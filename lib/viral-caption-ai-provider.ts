import { deepSeekFetch } from "./deepseek";
import { AiProviderError, lk888Fetch } from "./lk888";
import { getDeepSeekConfig, getLk888Config } from "./server/ai-credentials";
import {
  buildViralCaptionSkillRequest,
  VIRAL_CAPTION_AI_FALLBACK_MODEL,
  VIRAL_CAPTION_AI_FALLBACK_TIMEOUT_MS,
  VIRAL_CAPTION_AI_MODEL,
  VIRAL_CAPTION_AI_TIMEOUT_MS,
} from "./viral-caption-ai-skill";

export type ViralCaptionAiProvider = "deepseek" | "lk888";

export type ViralCaptionAiResult<T> = {
  response: T;
  provider: ViralCaptionAiProvider;
  model: string;
  fallbackFailures?: string[];
};

export async function requestViralCaptionAi<T>(input: {
  messages: Array<Record<string, unknown>>;
  captionCount: number;
  maxTokens?: number;
}): Promise<ViralCaptionAiResult<T>> {
  const deepSeekConfigured = Boolean(getDeepSeekConfig().apiKey);
  const lk888Configured = Boolean(getLk888Config().apiKey);
  const failures: string[] = [];

  if (deepSeekConfigured) {
    try {
      const response = await deepSeekFetch<T>("/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(VIRAL_CAPTION_AI_TIMEOUT_MS),
        body: JSON.stringify(buildViralCaptionSkillRequest({
          ...input,
          model: VIRAL_CAPTION_AI_MODEL,
          provider: "deepseek",
        })),
      });
      return { response, provider: "deepseek", model: VIRAL_CAPTION_AI_MODEL };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "DeepSeek 请求失败");
    }
  } else {
    failures.push("DeepSeek 尚未配置");
  }

  // The legacy model is kept only as a short backup. Its tighter deadline
  // prevents one caption-planning click from blocking the page for a minute.
  if (lk888Configured) {
    try {
      const response = await lk888Fetch<T>("/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(VIRAL_CAPTION_AI_FALLBACK_TIMEOUT_MS),
        body: JSON.stringify(buildViralCaptionSkillRequest({
          ...input,
          model: VIRAL_CAPTION_AI_FALLBACK_MODEL,
          provider: "lk888",
        })),
      });
      return {
        response,
        provider: "lk888",
        model: VIRAL_CAPTION_AI_FALLBACK_MODEL,
        fallbackFailures: [...failures],
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "备用模型请求失败");
    }
  }

  throw new AiProviderError(`字幕导演不可用：${failures.join("；")}`, 503);
}
