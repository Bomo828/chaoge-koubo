import { getMemberSession } from "../../../member-session";
import {
  ChanjingError,
  chanjingErrorResponse,
  createLipSyncTask,
  ensureChanjingBalance,
  getLipSyncTask,
  uploadLipSyncMedia,
} from "../../../../lib/chanjing";
import { lipSyncPoints, wavDurationSeconds } from "../../../../lib/chanjing-pricing";
import { billablePointsFromCost, costPointsFromBillable } from "../../../../lib/billing";
import {
  getActiveAiPointReservation,
  getWallet,
  getReservedAiPoints,
  pointsErrorResponse,
  refundAiPoints,
  reserveAiPoints,
  settleAiPointsByRequest,
} from "../../../../lib/points";
import { createAiTask, getAiTask, updateAiTask } from "../../../../lib/server/ai-tasks";

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
  let workflowRequestId = "";
  let videoFileId = "";
  let audioFileId = "";
  let providerTaskId = "";
  let checkpointResult: Record<string, unknown> = {};
  let stage = "读取上传内容";
  try {
    const form = await request.formData();
    const video = form.get("video");
    const audio = form.get("audio");
    const requestedOperation = typeof form.get("operation") === "string" ? String(form.get("operation")) : "submit_all";
    const operation = ["upload_video", "upload_audio", "submit", "submit_all"].includes(requestedOperation)
      ? requestedOperation
      : "submit_all";
    const requestId = typeof form.get("requestId") === "string" ? String(form.get("requestId")).trim() : "";
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
      return Response.json({ error: "缺少有效的对口型制作编号。" }, { status: 400 });
    }
    workflowRequestId = requestId;
    const width = Number(form.get("width")) || 1080;
    const height = Number(form.get("height")) || 1920;
    const projectName = typeof form.get("projectName") === "string"
      ? String(form.get("projectName")).trim().slice(0, 80) || "对口型视频"
      : "对口型视频";

    let storedTask = getAiTask(member, requestId);
    if (storedTask && (storedTask.kind !== "lip_sync_generate" || storedTask.provider !== "chanjing")) {
      return Response.json({ error: "这个制作编号已被其他任务使用。" }, { status: 409 });
    }
    checkpointResult = storedTask?.result || {};
    videoFileId = typeof checkpointResult.videoFileId === "string" ? checkpointResult.videoFileId : "";
    audioFileId = typeof checkpointResult.audioFileId === "string" ? checkpointResult.audioFileId : "";
    providerTaskId = storedTask?.providerTaskIds[0] || "";
    if (providerTaskId) {
      return Response.json({
        taskId: providerTaskId,
        state: storedTask?.state || "running",
        isFinal: false,
        progress: storedTask?.progress || 35,
        requestId,
        projectName,
        estimatedPoints: storedTask?.pointsReserved || 1,
        audioDuration: Number(checkpointResult.audioDuration) || 0,
        checkpoint: { videoUploaded: true, audioUploaded: true },
        wallet: await getWallet(member),
      });
    }

    const shouldUploadVideo = operation === "upload_video" || operation === "submit_all";
    const shouldUploadAudio = operation === "upload_audio" || operation === "submit_all";
    if (shouldUploadVideo && !videoFileId && (!(video instanceof File) || !video.type.startsWith("video/"))) {
      return Response.json({ error: "请上传需要进行口型同步的视频文件。" }, { status: 400 });
    }
    if (shouldUploadAudio && !audioFileId && (!(audio instanceof File) || !audio.type.startsWith("audio/"))) {
      return Response.json({ error: "请先生成口播音频。" }, { status: 400 });
    }
    if (video instanceof File && (video.size <= 0 || video.size > MAX_VIDEO_BYTES)) {
      return Response.json({ error: "视频文件需小于 200MB。" }, { status: 413 });
    }
    if (audio instanceof File && (audio.size <= 0 || audio.size > MAX_AUDIO_BYTES)) {
      return Response.json({ error: "口播音频需小于 30MB。" }, { status: 413 });
    }

    stage = "读取口播音频";
    const audioBytes = audio instanceof File ? await audio.arrayBuffer() : null;
    const declaredDuration = Number(form.get("audioDuration"));
    const detectedDuration = audioBytes ? wavDurationSeconds(audioBytes) : 0;
    const savedDuration = Number(checkpointResult.audioDuration);
    const audioDuration = savedDuration > 0 ? savedDuration : detectedDuration > 0 ? detectedDuration : declaredDuration;
    if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
      return Response.json({ error: "无法读取口播音频时长，请重新生成口播音频。" }, { status: 400 });
    }
    const estimatedPoints = lipSyncPoints(audioDuration, true);
    stage = "检查蝉镜余额";
    await ensureChanjingBalance(estimatedPoints);
    stage = "预留会员积分";
    reservation = getActiveAiPointReservation(member, "lip_sync_generate", requestId)
      || await reserveAiPoints(member, "lip_sync_generate", 1, requestId, estimatedPoints);
    if (!storedTask) {
      storedTask = createAiTask(member, {
        id: requestId,
        kind: "lip_sync_generate",
        provider: "chanjing",
        pointsReserved: reservation.reservedCost,
        payload: { projectName, width, height },
      });
      if (!storedTask) throw new ChanjingError("对口型断点任务创建失败。", 500);
      checkpointResult = {
        stage: "reserved",
        audioDuration,
        estimatedPoints: reservation.reservedCost,
      };
      updateAiTask(member, requestId, { state: "running", progress: 2, result: checkpointResult, error: "" });
    }
    // Chanjing's upload gateway is sensitive to simultaneous signed-slot
    // creation. Upload sequentially so each media file is fully ready before
    // requesting the next slot and creating the lip-sync task.
    if (shouldUploadVideo && !videoFileId) {
      stage = "上传人物视频";
      const videoUpload = await uploadLipSyncMedia({
        service: "lip_sync_video",
        fileName: safeFileName((video as File).name, "lip-sync-video.mp4"),
        contentType: (video as File).type,
        bytes: await (video as File).arrayBuffer(),
      });
      videoFileId = videoUpload.fileId;
      checkpointResult = { ...checkpointResult, stage: "video_uploaded", videoFileId, audioDuration };
      updateAiTask(member, requestId, { state: "running", progress: 16, result: checkpointResult, error: "" });
    }
    if (operation === "upload_video") {
      return Response.json({
        state: "uploading",
        isFinal: false,
        progress: 16,
        requestId,
        projectName,
        estimatedPoints: billablePointsFromCost(estimatedPoints),
        audioDuration,
        resumeAvailable: true,
        nextOperation: "upload_audio",
        checkpoint: { videoUploaded: Boolean(videoFileId), audioUploaded: Boolean(audioFileId) },
        wallet: await getWallet(member),
      });
    }
    if (operation === "upload_audio" && !videoFileId) {
      return Response.json({
        error: "人物视频尚未上传完成，请从视频上传步骤继续。",
        requestId,
        resumeAvailable: true,
        checkpoint: { videoUploaded: false, audioUploaded: Boolean(audioFileId) },
      }, { status: 409 });
    }
    if (shouldUploadAudio && !audioFileId) {
      stage = "上传口播音频";
      const audioUpload = await uploadLipSyncMedia({
        service: "lip_sync_audio",
        fileName: safeFileName((audio as File).name, "lip-sync-audio.mp3"),
        contentType: (audio as File).type,
        bytes: audioBytes as ArrayBuffer,
      });
      audioFileId = audioUpload.fileId;
      checkpointResult = { ...checkpointResult, stage: "audio_uploaded", videoFileId, audioFileId, audioDuration };
      updateAiTask(member, requestId, { state: "running", progress: 30, result: checkpointResult, error: "" });
    }
    if (operation === "upload_audio") {
      return Response.json({
        state: "uploading",
        isFinal: false,
        progress: 30,
        requestId,
        projectName,
        estimatedPoints: billablePointsFromCost(estimatedPoints),
        audioDuration,
        resumeAvailable: true,
        nextOperation: "submit",
        checkpoint: { videoUploaded: Boolean(videoFileId), audioUploaded: Boolean(audioFileId) },
        wallet: await getWallet(member),
      });
    }
    if (!videoFileId || !audioFileId) {
      return Response.json({
        error: "上传素材尚未准备完整，请继续完成当前上传步骤。",
        requestId,
        resumeAvailable: true,
        checkpoint: { videoUploaded: Boolean(videoFileId), audioUploaded: Boolean(audioFileId) },
      }, { status: 409 });
    }
    stage = "创建对口型任务";
    const task = await createLipSyncTask({
      videoFileId,
      audioFileId,
      width,
      height,
      highQuality: true,
    });
    providerTaskId = task.taskId;
    checkpointResult = { ...checkpointResult, stage: "submitted", videoFileId, audioFileId, audioDuration };
    updateAiTask(member, requestId, {
      providerTaskIds: [providerTaskId],
      state: "running",
      progress: 35,
      result: checkpointResult,
      error: "",
    });
    return Response.json({
      taskId: task.taskId,
      state: "running",
      isFinal: false,
      progress: 0,
      requestId: reservation.requestId,
      projectName,
      estimatedPoints: billablePointsFromCost(estimatedPoints),
      audioDuration,
      checkpoint: { videoUploaded: true, audioUploaded: true },
      wallet: await getWallet(member),
    });
  } catch (error) {
    const pointsResponse = pointsErrorResponse(error);
    if (pointsResponse) return pointsResponse;
    const transient = !(error instanceof ChanjingError) || error.status >= 500;
    const resumeAvailable = Boolean(reservation && workflowRequestId && transient);
    if (reservation && !resumeAvailable) await refundAiPoints(reservation).catch(() => undefined);
    const message = error instanceof ChanjingError
      ? error.message
      : `对口型流程在“${stage}”未完成，请稍后重试。`;
    if (workflowRequestId && getAiTask(member, workflowRequestId)) {
      checkpointResult = {
        ...checkpointResult,
        stage: resumeAvailable ? "paused" : "failed",
        failedStage: stage,
        videoFileId,
        audioFileId,
      };
      updateAiTask(member, workflowRequestId, {
        state: resumeAvailable ? "running" : "failed",
        result: checkpointResult,
        error: message,
      });
    }
    if (!(error instanceof ChanjingError)) console.error("Lip-sync submission failed", { stage, error });
    return Response.json({
      error: message,
      requestId: workflowRequestId || null,
      resumeAvailable,
      failedStage: stage,
      checkpoint: { videoUploaded: Boolean(videoFileId), audioUploaded: Boolean(audioFileId) },
    }, { status: error instanceof ChanjingError ? error.status : 502 });
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const url = new URL(request.url);
  const taskId = url.searchParams.get("task_id") || "";
  const requestId = url.searchParams.get("request_id") || "";
  if (!taskId && requestId) {
    const stored = getAiTask(member, requestId);
    if (!stored || stored.kind !== "lip_sync_generate" || stored.provider !== "chanjing") {
      return Response.json({ error: "尚未找到可恢复的对口型任务。" }, { status: 404 });
    }
    const storedResult = stored.result || {};
    const storedProviderTaskId = stored.providerTaskIds[0] || "";
    return Response.json({
      taskId: storedProviderTaskId || null,
      requestId,
      projectName: typeof stored.input.projectName === "string" ? stored.input.projectName : "对口型视频",
      state: stored.state,
      isFinal: stored.state === "success" || stored.state === "failed",
      progress: stored.progress,
      error: stored.error || null,
      resumeAvailable: stored.state !== "success",
      audioDuration: Number(storedResult.audioDuration) || 0,
      checkpoint: {
        videoUploaded: Boolean(storedResult.videoFileId),
        audioUploaded: Boolean(storedResult.audioFileId),
      },
      wallet: await getWallet(member),
    });
  }
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
    if (requestId && getAiTask(member, requestId)) {
      const stored = getAiTask(member, requestId);
      updateAiTask(member, requestId, {
        state: task.state === "success" ? "success" : task.state === "failed" ? "failed" : "running",
        progress: Number(task.progress) || (task.state === "success" ? 100 : stored?.progress || 35),
        result: {
          ...(stored?.result || {}),
          stage: task.state === "success" ? "completed" : task.state === "failed" ? "failed" : "processing",
          videoUrl: resultUrl || "",
        },
        error: task.error || "",
        pointsCharged: task.isFinal ? actualPoints : undefined,
      });
    }
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
