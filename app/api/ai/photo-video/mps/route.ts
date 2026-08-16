import { randomUUID } from "node:crypto";
import { getMemberSession } from "../../../../member-session";
import { createAiTask, getAiTask, updateAiTask } from "../../../../../lib/server/ai-tasks";
import {
  callTencentMps,
  cosInputInfo,
  cosOutputStorage,
  getCosObject,
  inputObjectKey,
  outputObjectKey,
  putCosObject,
  tencentMpsConfigStatus,
} from "../../../../../lib/server/tencent-mps";

type EditMediaResponse = { TaskId?: string };
type TaskDetailResponse = {
  Status?: string;
  EditMediaTask?: {
    ErrCode?: number;
    Message?: string;
    Progress?: number;
    Output?: { Path?: string };
  };
};

function safeNumber(value: FormDataEntryValue | null, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function mediaResponse(source: Response) {
  if (!source.ok || !source.body) {
    return Response.json({ error: "MP4 成片暂时无法读取。" }, { status: 502 });
  }
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Cache-Control": "private, max-age=300",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
  });
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(source.body, { status: source.status, headers });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const status = tencentMpsConfigStatus();
  if (!status.configured) {
    return Response.json({ error: `腾讯云 MPS 尚未配置：${status.missing.join("、")}` }, { status: 503 });
  }

  try {
    const form = await request.formData();
    const video = form.get("video");
    const audio = form.get("audio");
    if (!(video instanceof File) || !video.size) throw new Error("本地成片已失效，请重新生成。");
    if (!video.type.startsWith("video/")) throw new Error("提交的成片格式无效。");
    if (video.size > 120 * 1024 * 1024) throw new Error("本地成片超过 120MB，请降低清晰度后重试。");
    if (audio instanceof File && audio.size > 30 * 1024 * 1024) throw new Error("口播音频超过 30MB，请缩短文案后重试。");

    const duration = safeNumber(form.get("duration"), 12, 1, 60);
    const width = Math.round(safeNumber(form.get("width"), 720, 240, 1920));
    const height = Math.round(safeNumber(form.get("height"), 1280, 240, 1920));
    const title = typeof form.get("title") === "string"
      ? String(form.get("title")).trim().slice(0, 100)
      : "素材智能成片";
    const jobId = `photo_mps_${randomUUID().replace(/-/g, "")}`;
    const inputObject = inputObjectKey(jobId, video.name || "photo-video.webm");
    const audioObject = audio instanceof File && audio.size
      ? inputObjectKey(`${jobId}_audio`, audio.name || "speech.mp3")
      : "";
    const outputObject = outputObjectKey(jobId);

    await putCosObject(inputObject, Buffer.from(await video.arrayBuffer()), video.type || "video/webm");
    if (audioObject && audio instanceof File) {
      await putCosObject(audioObject, Buffer.from(await audio.arrayBuffer()), audio.type || "audio/mpeg");
    }
    const result = await callTencentMps<EditMediaResponse>("EditMedia", {
      FileInfos: [
        { Id: "source", InputInfo: cosInputInfo(inputObject) },
        ...(audioObject ? [{ Id: "speech", InputInfo: cosInputInfo(audioObject) }] : []),
      ],
      OutputStorage: cosOutputStorage(),
      OutputObjectPath: `/${outputObject.replace(/\.mp4$/i, ".{format}")}`,
      ComposeConfig: {
        Canvas: { Width: width, Height: height, Color: "#000000" },
        Tracks: [
          {
            Type: "Video",
            Items: [{
              Type: "Video",
              Video: {
                SourceMedia: { FileId: "source" },
                TrackTime: { Duration: `${duration.toFixed(3)}s` },
                XPos: "50%",
                YPos: "50%",
                Width: "100%",
              },
            }],
          },
          ...(audioObject ? [{
            Type: "Audio",
            Items: [{
              Type: "Audio",
              Audio: {
                SourceMedia: { FileId: "speech" },
                TrackTime: { Duration: `${duration.toFixed(3)}s` },
              },
            }],
          }] : []),
        ],
        TargetInfo: { Container: "mp4", VideoStream: { Fps: 30 } },
      },
    });
    if (!result.TaskId) throw new Error("腾讯云 MPS 没有返回任务编号。");

    createAiTask(member, {
      id: jobId,
      kind: "photo-video-mp4",
      provider: "tencent-mps",
      payload: { title: title || "素材智能成片", duration, width, height, outputObject, hasSpeech: Boolean(audioObject) },
    });
    updateAiTask(member, jobId, {
      providerTaskIds: [result.TaskId],
      state: "running",
      progress: 75,
      result: { outputObject },
    });
    return Response.json({ jobId, state: "running", progress: 75 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "MP4 转码任务创建失败。",
    }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") || "";
  if (!jobId) return Response.json(tencentMpsConfigStatus());
  const task = getAiTask(member, jobId);
  if (!task || task.kind !== "photo-video-mp4" || task.provider !== "tencent-mps") {
    return Response.json({ error: "找不到这个 MP4 转码任务。" }, { status: 404 });
  }

  if (url.searchParams.get("media") === "1") {
    if (task.state !== "success") return Response.json({ error: "MP4 成片尚未完成。" }, { status: 409 });
    const outputObject = typeof task.result.outputObject === "string" ? task.result.outputObject : "";
    if (!outputObject) return Response.json({ error: "MP4 成片地址缺失。" }, { status: 502 });
    return mediaResponse(await getCosObject(outputObject, request.headers.get("range") || ""));
  }

  if (task.state === "success" || task.state === "failed") {
    return Response.json({
      jobId,
      state: task.state,
      progress: task.progress,
      error: task.error,
      mediaUrl: task.state === "success"
        ? `/api/ai/photo-video/mps?media=1&jobId=${encodeURIComponent(jobId)}`
        : "",
    });
  }

  const taskId = task.providerTaskIds[0];
  if (!taskId) return Response.json({ error: "腾讯云 MPS 任务编号缺失。" }, { status: 502 });
  try {
    const detail = await callTencentMps<TaskDetailResponse>("DescribeTaskDetail", { TaskId: taskId });
    const editTask = detail.EditMediaTask;
    const finished = detail.Status === "FINISH";
    const succeeded = finished && Number(editTask?.ErrCode || 0) === 0;
    if (!finished) {
      const providerProgress = Math.max(0, Math.min(100, Number(editTask?.Progress) || 0));
      const progress = Math.min(98, Math.max(76, 76 + Math.round(providerProgress * .22), task.progress + 1));
      updateAiTask(member, jobId, { state: "running", progress });
      return Response.json({ jobId, state: "running", progress });
    }
    if (!succeeded) {
      const message = editTask?.Message || `腾讯云 MPS 转码失败（${editTask?.ErrCode ?? "未知错误"}）`;
      updateAiTask(member, jobId, { state: "failed", progress: 100, error: message });
      return Response.json({ jobId, state: "failed", progress: 100, error: message });
    }

    const outputObject = editTask?.Output?.Path || String(task.result.outputObject || "");
    updateAiTask(member, jobId, {
      state: "success",
      progress: 100,
      result: { ...task.result, outputObject },
    });
    return Response.json({
      jobId,
      state: "success",
      progress: 100,
      mediaUrl: `/api/ai/photo-video/mps?media=1&jobId=${encodeURIComponent(jobId)}`,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "MP4 转码状态读取失败。",
    }, { status: 502 });
  }
}
