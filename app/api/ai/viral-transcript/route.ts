import { createHash } from "node:crypto";
import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse } from "../../../../lib/lk888";
import { parseAiJsonObject } from "../../../../lib/ai-json";
import { requestViralCaptionAi, type ViralCaptionAiProvider } from "../../../../lib/viral-caption-ai-provider";
import { repairEnglishWordFragments, segmentViralCaptions } from "../../../../lib/viral-caption-segmentation";
import { normalizeViralTitleSyntax, planViralCaptionLayout, planViralTitleLayout } from "../../../../lib/viral-semantic-layout";
import {
  acceptViralCaptionCorrection,
  viralCorrectionBatchIsGrounded,
} from "../../../../lib/viral-text-integrity";
import {
  buildViralDirectorPlan,
  markViralKeywordSfx,
  sanitizeViralKeyword,
  type ViralCaptionPlanItem,
} from "../../../../lib/viral-workflow";
import {
  buildViralCaptionSkillSystemPrompt,
  normalizeViralKeywordImportance,
  viralCaptionKeywordTargets,
  VIRAL_CAPTION_AI_MODEL,
} from "../../../../lib/viral-caption-ai-skill";

type Caption = ViralCaptionPlanItem;

type ProviderResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  output_text?: string;
};

// The transcript has already been produced by Tencent Flash ASR. One short AI
// pass is enough; render workers must never repeat this request.
// The provider needs enough time to return a structured plan for the whole
// timeline. Eight seconds caused normal requests to be discarded and made the
// local fallback appear to be the AI result.
const TRANSCRIPT_CACHE_MAX = 96;
const transcriptCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

function transcriptCacheKey(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readTranscriptCache(key: string) {
  const entry = transcriptCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    transcriptCache.delete(key);
    return null;
  }
  transcriptCache.delete(key);
  transcriptCache.set(key, entry);
  return entry.value;
}

function writeTranscriptCache(key: string, value: Record<string, unknown>) {
  transcriptCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    const oldest = transcriptCache.keys().next().value;
    if (!oldest) break;
    transcriptCache.delete(oldest);
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  const record = value as Record<string, unknown>;
  for (const key of ["output_text", "text", "value", "content", "message", "choices", "output"]) {
    const result = extractText(record[key]);
    if (result) return result;
  }
  return "";
}

function plainText(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
}

function languageOf(value: string) {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return latinWords.length * 2 > cjk ? "en" as const : "zh" as const;
}

function textUnits(value: string) {
  if (languageOf(value) === "en") {
    return (value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  }
  return [...plainText(value)].length;
}

function phraseText(value: string) {
  const normalized = languageOf(value) === "en"
    ? value.replace(/\s+/g, " ")
    : value.replace(/\s+/g, "");
  return normalized
    .replace(/^[，,.。！？!?；;：:、]+|[，,.。！？!?；;：:、]+$/gu, "")
    .trim();
}

function completeTitle(value: unknown) {
  if (typeof value !== "string") return "";
  if (languageOf(value) === "en") {
    const title = value
      .replace(/^[\s'"“”‘’.,!?;:—-]+|[\s'"“”‘’.,!?;:—-]+$/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const words = title.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
    if (words.length < 3 || words.length > 12) return "";
    if (/\b(?:and|or|but|because|so|the|a|an|to|of|for|with|that|which)$/i.test(title)) return "";
    return title;
  }
  const title = value
    .replace(/[《》“”"'‘’：:。！？!?，,；;、*#\s]+/gu, "")
    .trim();
  if (title.length < 8 || title.length > 16) return "";
  const incompleteEndings = ["不是", "而是", "但是", "因为", "所以", "以及", "还有", "对于", "关于", "已经", "正在", "很多岗位", "这个问题", "这件事"];
  if (incompleteEndings.some((ending) => title.endsWith(ending))) return "";
  if (title.includes("不是")) {
    if (!title.includes("而是")) return "";
    if ((title.split("而是").pop() || "").length < 4) return "";
  }
  return title;
}

function fallbackEnglishTitle(captions: Caption[]) {
  const candidate = captions
    .map((caption) => caption.text.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim())
    .find((text) => textUnits(text) >= 3 && textUnits(text) <= 12) || "";
  return completeTitle(candidate);
}

function fallbackChineseTitle(captions: Caption[]) {
  const phrases = captions
    .map((caption) => phraseText(caption.text))
    .filter(Boolean);
  const standalone = phrases.find((text) => text.length >= 6 && text.length <= 16);
  if (standalone) return standalone;
  const combined = phrases.slice(0, 2).join("");
  return combined.length >= 6 ? combined.slice(0, 15) : combined;
}

function normalizeSourceCaptions(value: unknown, duration: number): Caption[] {
  if (!Array.isArray(value)) return [];
  const captions = value
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const start = Math.max(0, Math.min(duration, Number(record.start) || 0));
      const end = Math.max(start + 0.05, Math.min(duration, Number(record.end) || start + 0.5));
      const text = typeof record.text === "string" ? record.text.trim().slice(0, 500) : "";
      return { start, end, text };
    })
    .filter((item) => item.text && item.end > item.start)
    .sort((a, b) => a.start - b.start)
    .slice(0, 160);
  return repairEnglishWordFragments(captions);
}

function fixedAiCaptions(value: unknown, source: Caption[]) {
  if (!Array.isArray(value) || !value.length) {
    return { captions: source, rawItems: [] as Record<string, unknown>[], accepted: false, coverage: 0 };
  }
  const byId = new Map<number, Record<string, unknown>>();
  value.forEach((item, responseIndex) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const rawId = Number(record.id ?? record.i);
    const index = Number.isInteger(rawId) && rawId >= 1 && rawId <= source.length
      ? rawId - 1
      : responseIndex < source.length
        ? responseIndex
        : -1;
    if (index >= 0 && !byId.has(index)) {
      byId.set(index, {
        ...record,
        corrected_text: record.corrected_text ?? record.x,
        caption_lines: record.caption_lines ?? record.l,
        keyword: record.keyword ?? record.k,
        keyword_importance: record.keyword_importance ?? record.p,
        translation: record.translation ?? record.z,
      });
    }
  });
  const coverage = byId.size / source.length;
  if (coverage < 0.6) return { captions: source, rawItems: [], accepted: false, coverage };
  // Preserve the fixed timeline and fill any missing AI row with the original
  // text. Missing camera/SFX fields are safely completed by deterministic
  // defaults later instead of discarding the entire AI response.
  const rawItems = source.map((_, index) => byId.get(index) || {});
  const corrected = source.map((caption, index) => phraseText(acceptViralCaptionCorrection(
    caption.text,
    rawItems[index].corrected_text ?? rawItems[index].text,
  )) || caption.text);
  if (!viralCorrectionBatchIsGrounded(source.map((item) => item.text), corrected)) {
    return { captions: source, rawItems, accepted: false, coverage };
  }
  return {
    captions: source.map((caption, index) => ({ ...caption, text: corrected[index] })),
    rawItems,
    accepted: true,
    coverage,
  };
}

function captionsWithSemanticLines(captions: Caption[], rawCaptions: unknown) {
  const rawItems = Array.isArray(rawCaptions) ? rawCaptions : [];
  return captions.map((caption, index) => {
    const raw = rawItems.length === captions.length && rawItems[index] && typeof rawItems[index] === "object"
      ? rawItems[index] as Record<string, unknown>
      : {};
    const rawValue = raw.corrected_text ?? raw.text;
    const rawText = typeof rawValue === "string" ? phraseText(rawValue) : "";
    const preferredLines = rawText && plainText(rawText) === plainText(caption.text)
      ? raw.caption_lines
      : undefined;
    const layout = planViralCaptionLayout(caption.text, preferredLines, 10);
    return {
      ...caption,
      captionLineMode: layout.mode,
      captionLines: layout.lines,
    };
  });
}

function localNode(text: string, index: number, total: number): ViralCaptionPlanItem["contentNode"] {
  const value = text.replace(/\s+/g, "");
  if (index === 0 || /为什么|千万|别再|很多人|你知道|想不想/.test(value)) return "hook";
  if (index === total - 1 && /欢迎|咨询|预约|点击|联系|关注|留言/.test(value)) return "cta";
  if (/但是|不过|其实|相反|而是|不是|问题|难|担心/.test(value)) return "pain_reversal";
  if (/\d|提升|增长|效率|收益|优惠|免费|省/.test(value)) return "number_benefit";
  if (/比如|例如|第一|第二|第三|首先|其次|步骤|如何|怎么/.test(value)) return "example_step";
  if (/老师|品牌|公司|门店|产品|我们是|我是/.test(value)) return "brand_entity";
  if (/所以|记住|核心|结论|关键|本质|重点|方法|价值/.test(value)) return "core_viewpoint";
  return "supporting";
}

function localIntents(node: ViralCaptionPlanItem["contentNode"], weight: number) {
  return {
    cameraIntent: (node === "hook" ? "push-in" : node === "number_benefit" ? "close-up" : node === "example_step" ? "reframe" : node === "cta" ? "pull-back" : weight >= 0.72 ? "push-in" : "hold") as ViralCaptionPlanItem["cameraIntent"],
    transitionIntent: (node === "hook" ? "cut" : node === "pain_reversal" ? "focus-bridge" : node === "example_step" ? "matched-reframe" : node === "cta" ? "foreground-occlusion" : "none") as ViralCaptionPlanItem["transitionIntent"],
    sfxRole: ({ hook: "hook", pain_reversal: "reversal", core_viewpoint: "viewpoint", number_benefit: "number", example_step: "step", brand_entity: "brand", cta: "cta", supporting: "none" } as const)[node || "supporting"],
  };
}

function directedCaptions(captions: Caption[], rawCaptions: unknown, duration: number) {
  const rawItems = Array.isArray(rawCaptions) ? rawCaptions : [];
  const enriched = captions.map((caption, index) => {
    const midpoint = (caption.start + caption.end) / 2;
    const indexed = rawItems.length === captions.length && rawItems[index] && typeof rawItems[index] === "object"
      ? rawItems[index] as Record<string, unknown>
      : undefined;
    const raw = indexed || rawItems.find((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return midpoint >= Number(record.start) - 0.2 && midpoint <= Number(record.end) + 0.2;
    }) as Record<string, unknown> | undefined || {};
    const node = ["hook", "pain_reversal", "core_viewpoint", "number_benefit", "example_step", "brand_entity", "cta", "supporting"].includes(String(raw.content_node))
      ? raw.content_node as ViralCaptionPlanItem["contentNode"]
      : localNode(caption.text, index, captions.length);
    const weight = Math.max(0, Math.min(1, Number(raw.weight) || (index === 0 || index === captions.length - 1 ? 0.9 : 0.55)));
    const candidate = typeof raw.keyword === "string" ? raw.keyword.replace(/\s+/g, "").slice(0, 8) : "";
    // A keyword explicitly selected by the caption director has already passed the semantic
    // director. Do not let the old local "supporting sentence" weight rule
    // erase it merely because the compact AI schema does not return node/weight.
    const keyword = candidate && plainText(caption.text).includes(plainText(candidate))
      ? sanitizeViralKeyword(caption.text, candidate, node, candidate ? Math.max(weight, 0.75) : weight)
      : "";
    const keywordImportance = normalizeViralKeywordImportance(raw.keyword_importance, Boolean(keyword));
    const local = localIntents(node, weight);
    return {
      ...caption,
      keyword,
      translation: typeof raw.translation === "string" ? raw.translation.trim().slice(0, 240) : "",
      contentNode: node,
      contentWeight: weight,
      keywordOrigin: keyword ? "ai" as const : "none" as const,
        ...(keyword ? {
          keywordImportance: keywordImportance === "primary" ? "primary" as const : "regular" as const,
          ...(keywordImportance === "primary" ? { keywordSfx: true } : {}),
        } : {}),
      ...local,
    };
  });
  return markViralKeywordSfx(enriched, duration);
}

function semanticPlanIsComplete(items: Record<string, unknown>[], expectedLength: number) {
  const importance = new Set(["none", "regular", "primary"]);
  return items.length === expectedLength && items.every((item) => (
    importance.has(String(item.keyword_importance))
    && typeof item.keyword === "string"
    && typeof item.corrected_text === "string"
    && Array.isArray(item.caption_lines)
    && typeof item.translation === "string"
  ));
}

function safePlanningFailure(error: unknown) {
  const value = error instanceof Error ? error.message : String(error || "");
  if (/timeout|timed out|aborted|超时/i.test(value)) {
    return "AI 字幕导演响应超时，请重试。";
  }
  if (/JSON|结构化|可用的口播文案/i.test(value)) {
    return "AI 字幕导演返回的计划格式不完整，请重试。";
  }
  return "AI 字幕导演暂时不可用，请稍后重试。";
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    const body = await request.json() as {
      captions?: unknown;
      duration?: unknown;
      templateId?: unknown;
    };
    const duration = Math.max(1, Math.min(600, Number(body.duration) || 60));
    const sourceCaptions = normalizeSourceCaptions(body.captions, duration);
    if (!sourceCaptions.length) {
      return Response.json({ error: "没有读取到视频中的原始口播，请确认视频带有清晰人声。" }, { status: 400 });
    }
    const lockedCaptions = segmentViralCaptions(sourceCaptions);
    const sourceLanguage = languageOf(lockedCaptions.map((item) => item.text).join(" "));
    const templateId = typeof body.templateId === "string" ? body.templateId.trim().slice(0, 64) : "template-9";
    const cacheKey = transcriptCacheKey({
      version: "viral-transcript-semantic-lock-v8-deepseek-preserve-ai-keywords",
      model: VIRAL_CAPTION_AI_MODEL,
      templateId,
      duration,
      sourceCaptions: lockedCaptions,
    });
    const cached = readTranscriptCache(cacheKey);
    if (cached) return Response.json({ ...cached, cache: "hit" });
    const system = buildViralCaptionSkillSystemPrompt({
      language: sourceLanguage,
      itemKey: "captions",
      idBase: 1,
    });
    const keywordTargets = viralCaptionKeywordTargets(lockedCaptions.length, duration);
    const content = `口播语言：${sourceLanguage === "en" ? "英文" : "中文"}。时间轴已在服务器锁定。共${lockedCaptions.length}条字幕，必须恰好为${keywordTargets.keywordTarget}条填写非空k，其余k=""且p="none"；其中恰好${keywordTargets.primaryTarget}条p="primary"，其他非空k均为regular。关键词要分散、不得相邻重复泛词。仅处理以下有序条目：${JSON.stringify(lockedCaptions.map((item, index) => [index + 1, item.text]))}`;
    const tokenBudget = Math.max(800, Math.min(1900, 700 + lockedCaptions.length * 70));
    let endpoint: "deepseek-chat" | "lk888-chat" | "local" = "local";
    let selectedModel: string = "local-segmentation";
    let selectedProvider: ViralCaptionAiProvider | "local" = "local";
    let response: ProviderResponse | null = null;
    let planningFailure = "";
    try {
      const aiResult = await requestViralCaptionAi<ProviderResponse>({
        captionCount: lockedCaptions.length,
        maxTokens: tokenBudget,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
      });
      response = aiResult.response;
      if (!extractText(response)) throw new AiProviderError("识别通道没有返回有效内容。", 502);
      selectedProvider = aiResult.provider;
      endpoint = aiResult.provider === "deepseek" ? "deepseek-chat" : "lk888-chat";
      selectedModel = aiResult.model;
    } catch (error) {
      planningFailure = safePlanningFailure(error);
      response = null;
    }
    let parsed: Record<string, unknown> = {};
    if (response) {
      try {
        parsed = parseAiJsonObject(extractText(response), "大模型没有返回可用的口播文案。");
      } catch (error) {
        planningFailure = safePlanningFailure(error);
        response = null;
        endpoint = "local";
        selectedProvider = "local";
        selectedModel = "local-segmentation";
      }
    }
    const aiPlan = fixedAiCaptions(parsed.captions, lockedCaptions);
    const rawPlan = aiPlan.accepted ? aiPlan.rawItems : [];
    const captions = directedCaptions(captionsWithSemanticLines(aiPlan.captions, rawPlan), rawPlan, duration);
    const titleCandidates = [
      parsed.title ?? parsed.t,
      ...(Array.isArray(parsed.titleCandidates) ? parsed.titleCandidates : []),
    ];
    const aiTitle = titleCandidates
      .map((candidate) => completeTitle(normalizeViralTitleSyntax(typeof candidate === "string" ? candidate : "")))
      .find((candidate) => candidate && languageOf(candidate) === sourceLanguage) || "";
    const rawTitle = aiTitle || (sourceLanguage === "en" ? fallbackEnglishTitle(captions) : fallbackChineseTitle(captions));
    const titleLayout = planViralTitleLayout(rawTitle, parsed.title_lines ?? parsed.tl);
    const title = titleLayout.serializedTitle;
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title,
      titleLines: titleLayout.lines,
      duration,
      captions,
      bgmMood: parsed.bgm_mood as "calm" | "warm" | "professional" | "uplifting" | "neutral",
      source: response ? "ai" : "local-fallback",
      model: selectedModel,
      degraded: !response || !aiPlan.accepted,
    });
    const keywordCount = captions.filter((caption) => caption.keywordOrigin === "ai" && caption.keyword).length;
    const primaryKeywordCount = captions.filter((caption) => (
      caption.keywordOrigin === "ai"
      && caption.keyword
      && caption.keywordImportance === "primary"
    )).length;
    const semanticCoverage = rawPlan.length
      ? rawPlan.filter((item) => (
        typeof item.keyword === "string"
        || typeof item.keyword_importance === "string"
        || typeof item.translation === "string"
      )).length / lockedCaptions.length
      : 0;
    const planReady = Boolean(
      response
      && aiPlan.accepted
      && aiTitle
      && (semanticPlanIsComplete(rawPlan, lockedCaptions.length) || semanticCoverage >= 0.6)
      && keywordCount >= keywordTargets.minimumKeywords
      && keywordCount <= keywordTargets.maximumKeywords
      && primaryKeywordCount >= Math.min(1, keywordTargets.primaryTarget)
      && primaryKeywordCount <= keywordTargets.primaryTarget
    );
    const result = {
      title,
      titleLines: titleLayout.lines,
      summary: typeof parsed.summary === "string"
        ? parsed.summary.trim().slice(0, 180)
        : response
          ? `${selectedProvider === "deepseek" ? "DeepSeek" : "备用 AI"} 已在锁定时间轴上完成标题、字幕排版、提亮词与重点词规划。`
          : "AI 规划未完成，当前仅保留真实时间轴，不会机械补充关键词；请重试 AI 识别并排版。",
      captions: directorPlan.captions,
      directorPlan,
      planReady,
      model: selectedModel,
      provider: selectedProvider,
      endpoint,
      planningRole: `${selectedProvider}-caption-director`,
      timelineRole: "asr-timing-only",
      degraded: !planReady,
      warning: planReady
        ? ""
        : response
          ? "AI 已返回部分内容，但标题或关键词规划不完整。请点击重新 AI 规划，不要把当前结果当作最终 AI 方案。"
          : `${planningFailure || "AI 字幕导演请求未成功。"} 当前仅保留真实时间轴，请点击重新 AI 规划。`,
      cache: "miss",
    };
    if (planReady && selectedProvider === "deepseek") writeTranscriptCache(cacheKey, result);
    return Response.json(result);
  } catch (error) {
    return aiErrorResponse(error);
  }
}
