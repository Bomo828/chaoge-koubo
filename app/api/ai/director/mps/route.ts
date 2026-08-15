import { randomUUID } from "node:crypto";
import { getMemberSession } from "../../../../member-session";
import { createAiTask, getAiTask, updateAiTask } from "../../../../../lib/server/ai-tasks";
import { callTencentMps, cosInputInfo, cosOutputStorage, getCosObject, inputObjectKey, outputObjectKey, putCosObject, tencentMpsConfigStatus } from "../../../../../lib/server/tencent-mps";

type DirectorManifest = {
  title?: string;
  duration?: number;
  sources?: Array<{ id?: string; field?: string; name?: string; contentType?: string }>;
  shots?: Array<{ id?: string; sourceId?: string; duration?: number; sourceIn?: number; sourceOut?: number }>;
};
type EditMediaResponse = { TaskId?: string };
type TaskDetailResponse = { Status?: string; EditMediaTask?: { ErrCode?: number; Message?: string; Progress?: number; Output?: { Path?: string } } };

const DIRECTOR_CANVAS = { Width: 720, Height: 1280, Color: "#000000" } as const;

function safeManifest(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new Error("缺少腾讯云合成清单。");
  const manifest = JSON.parse(value) as DirectorManifest;
  const sources = Array.isArray(manifest.sources) ? manifest.sources.slice(0, 24) : [];
  const shots = Array.isArray(manifest.shots) ? manifest.shots.slice(0, 36) : [];
  const duration = Math.max(.2, Math.min(300, Number(manifest.duration) || 0));
  if (!sources.length || !shots.length || !duration) throw new Error("腾讯云合成清单不完整。");
  return { ...manifest, duration, sources, shots };
}

async function runLimited<T>(items: T[], limit: number, action: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await action(items[index], index);
    }
  }));
}

function mediaResponse(source: Response) {
  if (!source.ok || !source.body) return Response.json({ error: "腾讯云成片暂时无法读取。" }, { status: 502 });
  const headers = new Headers({ "Content-Type": source.headers.get("content-type") || "video/mp4", "Cache-Control": "private, max-age=300", "Accept-Ranges": "bytes", "Content-Disposition": "inline" });
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
  if (!status.configured) return Response.json({ error: `腾讯云 MPS 尚未配置：${status.missing.join("、")}` }, { status: 503 });
  try {
    const form = await request.formData();
    const manifest = safeManifest(form.get("manifest"));
    const speech = form.get("speech");
    if (!(speech instanceof File) || !speech.size) throw new Error("口播音频已失效，请重新生成或上传。");
    const jobId = `mps_${randomUUID().replace(/-/g, "")}`;
    const fileInfos: Array<Record<string, unknown>> = [];
    const fileIdBySource = new Map<string, string>();
    await runLimited(manifest.sources, 3, async (source, index) => {
      const sourceId = typeof source.id === "string" ? source.id : "";
      const field = typeof source.field === "string" ? source.field : "";
      const file = field ? form.get(field) : null;
      if (!sourceId || !(file instanceof File) || !file.size) throw new Error(`镜头素材 ${index + 1} 已失效，请重试。`);
      const fileId = `media_${index}`;
      const objectKey = inputObjectKey(jobId, `${fileId}-${source.name || file.name || "source.mp4"}`);
      await putCosObject(objectKey, Buffer.from(await file.arrayBuffer()), file.type || source.contentType || "video/mp4");
      fileIdBySource.set(sourceId, fileId);
      fileInfos.push({ Id: fileId, InputInfo: cosInputInfo(objectKey) });
    });
    const speechObject = inputObjectKey(jobId, `speech-${speech.name || "voice.mp3"}`);
    await putCosObject(speechObject, Buffer.from(await speech.arrayBuffer()), speech.type || "audio/mpeg");
    fileInfos.push({ Id: "speech", InputInfo: cosInputInfo(speechObject) });
    const videoItems = manifest.shots.map((shot, index) => {
      const fileId = fileIdBySource.get(typeof shot.sourceId === "string" ? shot.sourceId : "");
      if (!fileId) throw new Error(`镜头 ${index + 1} 没有可用视频来源。`);
      const duration = Math.max(.2, Math.min(30, Number(shot.duration) || 0));
      const sourceIn = Math.max(0, Number(shot.sourceIn) || 0);
      const sourceOut = Math.max(sourceIn + .2, Number(shot.sourceOut) || sourceIn + duration);
      return {
        Type: "Video",
        Video: {
          SourceMedia: { FileId: fileId, StartTime: `${sourceIn.toFixed(3)}s`, EndTime: `${sourceOut.toFixed(3)}s` },
          TrackTime: { Duration: `${duration.toFixed(3)}s` },
          XPos: "50%",
          YPos: "50%",
          Width: "100%",
          AudioOperations: [{ Type: "Volume", Volume: 0 }],
        },
      };
    });
    const outputKey = outputObjectKey(jobId);
    const result = await callTencentMps<EditMediaResponse>("EditMedia", {
      FileInfos: fileInfos,
      OutputStorage: cosOutputStorage(),
      OutputObjectPath: `/${outputKey.replace(/\.mp4$/i, ".{format}")}`,
      ComposeConfig: {
        Canvas: DIRECTOR_CANVAS,
        Tracks: [
          { Type: "Video", Items: videoItems },
          { Type: "Audio", Items: [{ Type: "Audio", Audio: { SourceMedia: { FileId: "speech" }, TrackTime: { Duration: `${manifest.duration.toFixed(3)}s` } } }] },
        ],
        TargetInfo: { Container: "mp4", VideoStream: { Fps: 25 } },
      },
    });
    if (!result.TaskId) throw new Error("腾讯云 MPS 没有返回任务编号。");
    createAiTask(member, { id: jobId, kind: "director-clean-video", provider: "tencent-mps", payload: { title: String(manifest.title || "AI导演干净成片").slice(0, 100), duration: manifest.duration, outputObject: outputKey, sourceCount: manifest.sources.length, shotCount: manifest.shots.length } });
    updateAiTask(member, jobId, { providerTaskIds: [result.TaskId], state: "running", progress: 88, result: { outputObject: outputKey } });
    return Response.json({ jobId, taskId: result.TaskId, state: "running", progress: 88 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "腾讯云 MPS 合成任务创建失败。" }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") || "";
  if (!jobId) return Response.json(tencentMpsConfigStatus());
  const task = getAiTask(member, jobId);
  if (!task || task.kind !== "director-clean-video" || task.provider !== "tencent-mps") return Response.json({ error: "找不到这个腾讯云成片任务。" }, { status: 404 });
  if (url.searchParams.get("media") === "1") {
    if (task.state !== "success") return Response.json({ error: "腾讯云成片尚未完成。" }, { status: 409 });
    const outputObject = typeof task.result.outputObject === "string" ? task.result.outputObject : "";
    if (!outputObject) return Response.json({ error: "腾讯云成片地址缺失。" }, { status: 502 });
    return mediaResponse(await getCosObject(outputObject, request.headers.get("range") || ""));
  }
  if (task.state === "success" || task.state === "failed") return Response.json({ jobId, state: task.state, progress: task.progress, error: task.error, mediaUrl: task.state === "success" ? `/api/ai/director/mps?media=1&jobId=${encodeURIComponent(jobId)}` : "" });
  const taskId = task.providerTaskIds[0];
  if (!taskId) return Response.json({ error: "腾讯云 MPS 任务编号缺失。" }, { status: 502 });
  try {
    const detail = await callTencentMps<TaskDetailResponse>("DescribeTaskDetail", { TaskId: taskId });
    const editTask = detail.EditMediaTask;
    const finished = detail.Status === "FINISH";
    const succeeded = finished && Number(editTask?.ErrCode || 0) === 0;
    if (!finished) {
      const providerProgress = Math.max(0, Math.min(100, Number(editTask?.Progress) || 0));
      const progress = Math.min(97, Math.max(90, 88 + Math.round(providerProgress * .09), task.progress + 1));
      updateAiTask(member, jobId, { state: "running", progress });
      return Response.json({ jobId, state: "running", progress });
    }
    if (!succeeded) {
      const message = editTask?.Message || `腾讯云 MPS 合成失败（${editTask?.ErrCode ?? "未知错误"}）`;
      updateAiTask(member, jobId, { state: "failed", progress: 100, error: message });
      return Response.json({ jobId, state: "failed", progress: 100, error: message });
    }
    const outputObject = editTask?.Output?.Path || String(task.result.outputObject || "");
    updateAiTask(member, jobId, { state: "success", progress: 100, result: { ...task.result, outputObject } });
    return Response.json({ jobId, state: "success", progress: 100, mediaUrl: `/api/ai/director/mps?media=1&jobId=${encodeURIComponent(jobId)}` });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "腾讯云 MPS 状态读取失败。" }, { status: 502 });
  }
}
