import { getLk888Config } from "./server/ai-credentials";

const DEFAULT_BASE_URL = "https://api.lk888.ai";

export class AiProviderError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "AiProviderError";
    this.status = status;
  }
}

function providerConfig() {
  const configured = getLk888Config();
  const apiKey = configured.apiKey;
  const baseUrl = (configured.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");

  if (!apiKey) {
    throw new AiProviderError("AI 服务尚未配置，请先设置 LK888_API_KEY。", 503);
  }

  return { apiKey, baseUrl };
}

export async function lk888Request(path: string, init?: RequestInit) {
  const { apiKey, baseUrl } = providerConfig();
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new AiProviderError("AI 服务响应超时，请稍后重试。", 504);
    }
    throw error;
  }
}

export async function lk888Fetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await lk888Request(path, init);

  const raw = await response.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    const providerError = typeof data === "object" && data && "error" in data
      ? (data as { error?: unknown }).error
      : null;
    const message = typeof providerError === "string"
      ? providerError
      : providerError && typeof providerError === "object" && "message" in providerError && typeof (providerError as { message?: unknown }).message === "string"
        ? (providerError as { message: string }).message
        : `AI 服务请求失败（${response.status}）`;
    throw new AiProviderError(message, response.status);
  }

  // 媒体生成接口为了兼容旧客户端，即使业务失败也可能返回 HTTP 200，
  // 并通过顶层 { code, msg, data } 表示真实结果。必须在这里统一识别，
  // 否则调用方会把失败响应当成已创建任务，造成积分长期停留在预授权状态。
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const envelope = data as { code?: unknown; msg?: unknown; message?: unknown };
    const businessCode = Number(envelope.code);
    if (Number.isFinite(businessCode) && businessCode !== 200) {
      const message = typeof envelope.msg === "string" && envelope.msg.trim()
        ? envelope.msg.trim()
        : typeof envelope.message === "string" && envelope.message.trim()
          ? envelope.message.trim()
          : `AI 服务请求失败（业务状态 ${businessCode}）`;
      const status = businessCode >= 400 && businessCode <= 599 ? businessCode : 502;
      throw new AiProviderError(message, status);
    }
  }

  return data as T;
}

export function aiErrorResponse(error: unknown) {
  if (error instanceof AiProviderError) {
    const capacity = /selected model is at capacity|model.*capacity|overloaded/i.test(error.message);
    const insufficientBalance = /insufficient balance|top up and try again|余额不足/i.test(error.message);
    return Response.json({
      error: capacity
        ? "当前 AI 模型使用人数较多，系统正在切换备用模型，请稍后重试。"
        : insufficientBalance
          ? "第三方 AI 视频账户余额不足，请联系管理员充值或更换可用密钥后重试。"
          : error.message,
    }, { status: capacity ? 503 : insufficientBalance ? 503 : error.status });
  }
  console.error("AI provider request failed", error);
  return Response.json({ error: "AI 服务暂时不可用，请稍后再试。" }, { status: 500 });
}
