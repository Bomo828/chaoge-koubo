const DEFAULT_BASE_URL = "https://open-api.chanjing.cc";

export class ChanjingError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ChanjingError";
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;
let tokenCache: { value: string; expiresAt: number } | null = null;

function upstreamMessage(payload: JsonRecord, status: number) {
  const candidate = typeof payload.msg === "string" && payload.msg.trim()
    ? payload.msg.trim()
    : typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "";
  if (candidate && !/<(?:html|head|body|center|h1)\b/i.test(candidate)) return candidate;
  if (status === 502) return "蝉镜上传网关暂时无响应（502），已停止本次任务。";
  if (status === 503) return "蝉镜服务正在维护或繁忙（503），请稍后重试。";
  if (status === 504) return "蝉镜服务响应超时（504），请稍后重试。";
  return `蝉镜接口请求失败（${status}）`;
}

function config() {
  const appId = process.env.CHANJING_APP_ID;
  const secretKey = process.env.CHANJING_SECRET_KEY;
  const baseUrl = (process.env.CHANJING_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (!appId || !secretKey) {
    throw new ChanjingError("蝉镜服务尚未配置，请在服务端设置 CHANJING_APP_ID 和 CHANJING_SECRET_KEY。", 503);
  }
  return { appId, secretKey, baseUrl };
}

async function parseResponse(response: Response) {
  const raw = await response.text();
  let payload: JsonRecord = {};
  try {
    payload = raw ? JSON.parse(raw) as JsonRecord : {};
  } catch {
    payload = { msg: raw };
  }
  const code = payload.code === undefined ? 0 : Number(payload.code);
  if (!response.ok || code !== 0) {
    throw new ChanjingError(upstreamMessage(payload, response.status), response.status >= 400 ? response.status : 502);
  }
  return payload;
}

async function getAccessToken(forceRefresh = false) {
  const { appId, secretKey, baseUrl } = config();
  if (!forceRefresh && tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const response = await fetch(`${baseUrl}/open/v1/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret_key: secretKey }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await parseResponse(response);
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const token = typeof data.access_token === "string" ? data.access_token : "";
  if (!token) throw new ChanjingError("蝉镜接口没有返回 access_token。");
  tokenCache = { value: token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return token;
}

async function request(path: string, init: RequestInit = {}, retry = true): Promise<JsonRecord> {
  const { baseUrl } = config();
  const token = await getAccessToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      access_token: token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let payload: JsonRecord = {};
  try {
    payload = raw ? JSON.parse(raw) as JsonRecord : {};
  } catch {
    payload = { msg: raw };
  }
  if (retry && Number(payload.code) === 10400) {
    await getAccessToken(true);
    return request(path, init, false);
  }
  const code = payload.code === undefined ? 0 : Number(payload.code);
  if (!response.ok || code !== 0) {
    throw new ChanjingError(upstreamMessage(payload, response.status), response.status >= 400 ? response.status : 502);
  }
  return payload;
}

export async function getChanjingBalance() {
  const payload = await request("/open/v1/user_duration", { method: "GET", cache: "no-store" });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const balance = Number(data.resi_total_bean);
  if (!Number.isFinite(balance)) throw new ChanjingError("蝉镜没有返回可用余额。", 502);
  return balance;
}

export async function ensureChanjingBalance(requiredPoints: number) {
  const required = Math.max(0, Math.ceil(requiredPoints));
  const balance = await getChanjingBalance();
  if (balance < required) {
    throw new ChanjingError(`蝉镜余额不足：当前 ${Math.floor(balance)} 蝉豆，本次预计需要 ${required} 蝉豆。请先充值蝉豆后再生成。`, 402);
  }
  return balance;
}

async function createUploadSlot(service: "lip_sync_video" | "lip_sync_audio", fileName: string) {
  const payload = await request(`/open/v1/common/create_upload_url?service=${encodeURIComponent(service)}&name=${encodeURIComponent(fileName)}`, {
    method: "GET",
  });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const signUrl = typeof data.sign_url === "string" ? data.sign_url : "";
  const fileId = typeof data.file_id === "string" || typeof data.file_id === "number" ? String(data.file_id) : "";
  const mimeType = typeof data.mime_type === "string" ? data.mime_type : "application/octet-stream";
  if (!signUrl || !fileId) throw new ChanjingError("蝉镜文件接口没有返回上传地址。");
  return { signUrl, fileId, mimeType };
}

async function fileDetail(fileId: string) {
  const payload = await request(`/open/v1/common/file_detail?id=${encodeURIComponent(fileId)}`, { method: "GET" });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  return {
    status: Number(data.status),
    error: typeof data.err_msg === "string" ? data.err_msg : typeof data.msg === "string" ? data.msg : "",
  };
}

export async function uploadLipSyncMedia(input: {
  service: "lip_sync_video" | "lip_sync_audio";
  fileName: string;
  contentType: string;
  bytes: ArrayBuffer;
}) {
  const mediaName = input.service === "lip_sync_video" ? "视频" : "口播音频";
  let slot: Awaited<ReturnType<typeof createUploadSlot>> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      slot = await createUploadSlot(input.service, input.fileName);
      break;
    } catch (error) {
      if (!(error instanceof ChanjingError) || error.status < 500 || attempt === 1) {
        throw new ChanjingError(`${mediaName}上传地址获取失败：${error instanceof Error ? error.message : "未知错误"}`, error instanceof ChanjingError ? error.status : 502);
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  if (!slot) throw new ChanjingError(`${mediaName}上传地址获取失败。`);

  let uploaded = false;
  let uploadStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(slot.signUrl, {
      method: "PUT",
      headers: { "Content-Type": slot.mimeType || input.contentType || "application/octet-stream" },
      body: input.bytes,
      signal: AbortSignal.timeout(120_000),
    });
    uploadStatus = response.status;
    if (response.ok) {
      uploaded = true;
      break;
    }
    if (response.status < 500 || attempt === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (!uploaded) throw new ChanjingError(`${mediaName}上传失败（${uploadStatus || "网络异常"}）。`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    let detail: Awaited<ReturnType<typeof fileDetail>>;
    try {
      detail = await fileDetail(slot.fileId);
    } catch (error) {
      if (error instanceof ChanjingError && error.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        continue;
      }
      throw new ChanjingError(`${mediaName}处理状态查询失败：${error instanceof Error ? error.message : "未知错误"}`, error instanceof ChanjingError ? error.status : 502);
    }
    // Current File Management API marks status=1 as available. Keep status=2
    // for compatibility with the older avatar skill documentation.
    if (detail.status === 1 || detail.status === 2) return { fileId: slot.fileId };
    if ([3, 4, 30, 98, 99, 100].includes(detail.status)) {
      throw new ChanjingError(`${mediaName}处理失败：${detail.error || "素材校验未通过"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new ChanjingError(`${mediaName}处理超时，请稍后重试。`, 504);
}

export async function createCustomVoice(input: {
  name: string;
  audioUrl: string;
  language?: string;
}) {
  const payload = await request("/open/v1/create_customised_audio", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      url: input.audioUrl,
      model_type: "Cicada3.0-turbo",
      language: input.language || "cn",
    }),
  });
  const data = payload.data;
  const voiceId = typeof data === "string" || typeof data === "number"
    ? String(data)
    : data && typeof data === "object"
      ? String((data as JsonRecord).id || (data as JsonRecord).voice_id || "")
      : "";
  if (!voiceId) throw new ChanjingError("蝉镜声音克隆接口没有返回声音 ID。");
  return { voiceId };
}

export async function getCustomVoice(voiceId: string) {
  const payload = await request(`/open/v1/customised_audio?id=${encodeURIComponent(voiceId)}`, {
    method: "GET",
    cache: "no-store",
  });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const status = Number(data.status);
  const failed = status === 3 || status === 4 || status === 99;
  const demoAudio = [
    data.demo_audio,
    data.audio_url,
    data.url,
    data.source_url,
  ].find((value): value is string => typeof value === "string" && /^https:\/\//i.test(value));
  return {
    voiceId: String(data.id || voiceId),
    name: typeof data.name === "string" ? data.name : "",
    demoAudio: demoAudio || "",
    status,
    state: status === 2 ? "success" : failed ? "failed" : "running",
    isFinal: status === 2 || failed,
    progress: Math.max(0, Math.min(100, Number(data.progress) || (status === 2 ? 100 : 0))),
    error: typeof data.err_msg === "string" ? data.err_msg : "",
  };
}

export async function createSpeechTask(input: {
  voiceId: string;
  text: string;
  speed?: number;
}) {
  const payload = await request("/open/v1/create_audio_task", {
    method: "POST",
    body: JSON.stringify({
      audio_man: input.voiceId,
      speed: Math.max(0.5, Math.min(2, Number(input.speed) || 1)),
      pitch: 1,
      text: { text: input.text },
      aigc_watermark: false,
    }),
  });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const taskId = typeof data.task_id === "string" || typeof data.task_id === "number"
    ? String(data.task_id)
    : "";
  if (!taskId) throw new ChanjingError("蝉镜口播音频接口没有返回任务编号。");
  return { taskId };
}

export async function getSpeechTask(taskId: string) {
  const payload = await request("/open/v1/audio_task_state", {
    method: "POST",
    body: JSON.stringify({ task_id: taskId }),
  });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const full = data.full && typeof data.full === "object" ? data.full as JsonRecord : {};
  const status = Number(data.status);
  const error = typeof data.errMsg === "string"
    ? data.errMsg
    : typeof data.errReason === "string"
      ? data.errReason
      : "";
  const audioUrl = typeof full.url === "string" ? full.url : "";
  const success = status === 9 && Boolean(audioUrl);
  const failed = Boolean(error);
  return {
    taskId,
    status,
    state: success ? "success" : failed ? "failed" : "running",
    isFinal: success || failed,
    progress: success ? "100%" : "处理中",
    audioUrl,
    duration: Number(full.duration) || 0,
    error,
  };
}

export async function createLipSyncTask(input: {
  videoFileId: string;
  audioFileId: string;
  width?: number;
  height?: number;
  highQuality?: boolean;
}) {
  const payload = await request("/open/v1/video_lip_sync/create", {
    method: "POST",
    body: JSON.stringify({
      video_file_id: input.videoFileId,
      screen_width: Math.max(360, Math.min(4096, Math.floor(input.width || 1080))),
      screen_height: Math.max(360, Math.min(4096, Math.floor(input.height || 1920))),
      model: input.highQuality === false ? 0 : 1,
      audio_type: "audio",
      audio_file_id: input.audioFileId,
      volume: 100,
    }),
  });
  const data = payload.data;
  const taskId = typeof data === "string" || typeof data === "number"
    ? String(data)
    : data && typeof data === "object" && (typeof (data as JsonRecord).id === "string" || typeof (data as JsonRecord).id === "number")
      ? String((data as JsonRecord).id)
      : "";
  if (!taskId) throw new ChanjingError("蝉镜对口型接口没有返回任务编号。");
  return { taskId };
}

export async function getLipSyncTask(taskId: string) {
  const payload = await request(`/open/v1/video_lip_sync/detail?id=${encodeURIComponent(taskId)}`, { method: "GET", cache: "no-store" });
  const data = payload.data && typeof payload.data === "object" ? payload.data as JsonRecord : {};
  const status = Number(data.status);
  return {
    taskId,
    status,
    state: status === 20 ? "success" : status === 30 ? "failed" : "running",
    isFinal: status === 20 || status === 30,
    progress: Math.max(0, Math.min(100, Number(data.progress) || 0)),
    videoUrl: typeof data.video_url === "string" ? data.video_url : "",
    previewUrl: typeof data.preview_url === "string" ? data.preview_url : "",
    duration: Number(data.duration) || 0,
    error: status === 30 && typeof data.msg === "string" ? data.msg : "",
  };
}

export function chanjingErrorResponse(error: unknown) {
  if (error instanceof ChanjingError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Chanjing request failed", error);
  return Response.json({ error: "蝉镜服务暂时不可用，请稍后重试。" }, { status: 500 });
}
