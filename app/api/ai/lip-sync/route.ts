import { getMemberSession } from "../../../member-session";
import {
  chanjingErrorResponse,
  createLipSyncTask,
  ensureChanjingBalance,
  getLipSyncTask,
  uploadLipSyncMedia,
} from "../../../../lib/chanjing";
import { lipSyncPoints, wavDurationSeconds } from "../../../../lib/chanjing-pricing";
import { billablePointsFromCost, costPointsFromBillable } from "../../../../lib/billing";
import {
  getWallet,
  getReservedAiPoints,
  pointsErrorResponse,
  refundAiPoints,
  reserveAiPoints,
  settleAiPointsByRequest,
} from "../../../../lib/points";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

function safeFileName(name: string, fallback: string) {
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120);
  return cleaned || fallback;
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let submitted = false;
  try {
    const form = await request.formData();
    const video = form.get("video");
    const audio = form.get("audio");
    const requestId = form.get("requestId");
    const width = Number(form.get("width")) || 1080;
    const height = Number(form.get("height")) || 1920;
    const projectName = typeof form.get("projectName") === "string"
      ? String(form.get("projectName")).trim().slice(0, 80) || "对口型视频"
      : "对口型视频";

    if (!(video instanceof File) || !video.type.startsWith("video/")) {
      return Response.json({ error: "请上传需要进行口型同步的视频文件。" }, { status: 400 });
    }
    if (!(audio instanceof File) || !audio.type.startsWith("audio/")) {
      return Response.json({ error: "请先生成口播音频。" }, { status: 400 });
    }
    if (video.size <= 0 || video.size > MAX_VIDEO_BYTES) {
      return Response.json({ error: "视频文件需小于 200MB。" }, { status: 413 });
    }
    if (audio.size <= 0 || audio.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "口播音频需小于 30MB。" }, { status: 413 });
    }

    const audioBytes = await audio.arrayBuffer();
    const declaredDuration = Number(form.get("audioDuration"));
    const detectedDuration = wavDurationSeconds(audioBytes);
    const audioDuration = detectedDuration > 0 ? detectedDuration : declaredDuration;
    if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
      return Response.json({ error: "无法读取口播音频时长，请重新生成口播音频。" }, { status: 400 });
    }
    const estimatedPoints = lipSyncPoints(audioDuration, true);
    await ensureChanjingBalance(estimatedPoints);
    reservation = await reserveAiPoints(member, "lip_sync_generate", 1, requestId, estimatedPoints);
    // Chanjing's upload gateway is sensitive to simultaneous signed-slot
    // creation. Upload sequentially so each media file is fully ready before
    // requesting the next slot and creating the lip-sync task.
    const videoUpload = await uploadLipSyncMedia({
      service: "lip_sync_video",
      fileName: safeFileName(video.name, "lip-sync-video.mp4"),
      contentType: video.type,
      bytes: await video.arrayBuffer(),
    });
    const audioUpload = await uploadLipSyncMedia({
      service: "lip_sync_audio",
      fileName: safeFileName(audio.name, "lip-sync-audio.mp3"),
      contentType: audio.type,
      bytes: audioBytes,
    });
    const task = await createLipSyncTask({
      videoFileId: videoUpload.fileId,
      audioFileId: audioUpload.fileId,
      width,
      height,
      highQuality: true,
    });
    submitted = true;
    return Response.json({
      taskId: task.taskId,
      state: "running",
      isFinal: false,
      progress: 0,
      requestId: reservation.requestId,
      projectName,
      estimatedPoints: billablePointsFromCost(estimatedPoints),
      audioDuration,
      wallet: await getWallet(member),
    });
  } catch (error) {
    if (reservation && !submitted) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const url = new URL(request.url);
  const taskId = url.searchParams.get("task_id") || "";
  const requestId = url.searchParams.get("request_id") || "";
  if (!taskId) return Response.json({ error: "缺少对口型任务编号。" }, { status: 400 });

  try {
    const task = await getLipSyncTask(taskId);
    const resultUrl = task.videoUrl || task.previewUrl;
    const actualPoints = task.isFinal && requestId && task.state === "success"
      ? getReservedAiPoints(member, requestId)
      : 0;
    const actualCostPoints = costPointsFromBillable(actualPoints);
    const wallet = task.isFinal && requestId
      ? await settleAiPointsByRequest(member, requestId, actualCostPoints)
      : await getWallet(member);
    return Response.json({
      ...task,
      // Return the provider media URL immediately. Archiving the complete file
      // is intentionally decoupled so the player and one-click viral editor do
      // not wait for a second full video transfer through the web server.
      videoUrl: resultUrl,
      saved: false,
      archivePending: task.state === "success" && Boolean(resultUrl),
      requestId: requestId || null,
      actualPoints: task.isFinal ? actualPoints : null,
      wallet,
    });
  } catch (error) {
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}
