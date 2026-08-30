import { AiProviderError } from "./lk888";
import { getDeepSeekConfig } from "./server/ai-credentials";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

function providerConfig() {
  const configured = getDeepSeekConfig();
  const apiKey = configured.apiKey;
  const baseUrl = (configured.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (!apiKey) {
    throw new AiProviderError("DeepSeek 服务尚未配置，请先在管理后台填写 API Key。", 503);
  }
  return { apiKey, baseUrl };
}

export async function deepSeekFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiKey, baseUrl } = providerConfig();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(22_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new AiProviderError("DeepSeek 字幕规划响应超时。", 504);
    }
    throw new AiProviderError("无法连接 DeepSeek 字幕规划服务。", 502);
  }

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
      : providerError && typeof providerError === "object" && "message" in providerError
        && typeof (providerError as { message?: unknown }).message === "string"
        ? (providerError as { message: string }).message
        : `DeepSeek 请求失败（${response.status}）`;
    throw new AiProviderError(message, response.status);
  }
  return data as T;
}
