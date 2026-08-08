import { getMemberSession } from "../../../member-session";
import {
  chanjingErrorResponse,
  createLipSyncTask,
  getLipSyncTask,
  uploadLipSyncMedia,
} from "../../../../lib/chanjing";
import { saveMemberAsset } from "../../../../lib/member-assets";
import {
  getWallet,
  pointsErrorResponse,
  refundAiPoints,
  reserveAiPoints,
  settleAiPointsByRequest,
} from "../../../../lib/points";

const LIP_SYNC_POINTS = 200;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

function safeFileName(name: string, fallback: string) {
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120);
  return cleaned || fallback;
}

function assetId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `lip_${(hash >>> 0).toString(36)}_${value.length.toString(36)}`;
}

async function archiveVideo(member: NonNullable<Awaited<ReturnType<typeof getMemberSession>>>, input: {
  url: string;
  taskId: string;
  projectName: string;
}) {
  if (!input.url) return { videoUrl: "", saved: false };
  try {
    const id = assetId(input.taskId);
    await saveMemberAsset(member, {
      id,
      projectName: input.projectName,
      kind: "video",
      name: "对口型成片",
      sourceUrl: input.url,
      sourceTaskId: `chanjing_${input.taskId}`,
      createdAt: Date.now(),
    });
    return { videoUrl: `/api/member/assets/${encodeURIComponent(id)}`, saved: true };
  } catch (error) {
    console.error("Archive lip-sync video failed", error);
    return { videoUrl: input.url, saved: false };
  }
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

    reservation = await reserveAiPoints(member, "lip_sync_generate", 1, requestId, LIP_SYNC_POINTS);
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
      bytes: await audio.arrayBuffer(),
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
  const projectName = (url.searchParams.get("project_name") || "对口型视频").slice(0, 80);
  if (!taskId) return Response.json({ error: "缺少对口型任务编号。" }, { status: 400 });

  try {
    const task = await getLipSyncTask(taskId);
    const resultUrl = task.videoUrl || task.previewUrl;
    const archived = task.state === "success" && resultUrl
      ? await archiveVideo(member, { url: resultUrl, taskId, projectName })
      : { videoUrl: "", saved: false };
    const wallet = task.isFinal && requestId
      ? await settleAiPointsByRequest(member, requestId, task.state === "success" ? LIP_SYNC_POINTS : 0)
      : await getWallet(member);
    return Response.json({
      ...task,
      videoUrl: archived.videoUrl || task.videoUrl || task.previewUrl,
      saved: archived.saved,
      requestId: requestId || null,
      wallet,
    });
  } catch (error) {
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}
