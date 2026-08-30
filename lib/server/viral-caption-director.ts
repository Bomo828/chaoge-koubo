import { createHash } from "node:crypto";
import { parseAiJsonObject } from "../ai-json";
import { requestViralCaptionAi } from "../viral-caption-ai-provider";
import {
  compileViralCaptionCues,
  viralCaptionConstraintPrompt,
  viralCaptionTemplateContract,
} from "../viral-caption-contract";
import {
  buildViralDirectorPlan,
  markViralKeywordSfx,
  sanitizeViralKeyword,
  sanitizeViralCaptionPlan,
  VIRAL_DIRECTOR_PROMPT_VERSION,
  type ViralCaptionPlanItem,
} from "../viral-workflow";
import { normalizeViralTitleSyntax, planViralCaptionLayout, planViralTitleLayout } from "../viral-semantic-layout";
import {
  buildViralCaptionTokenTimeline,
  buildViralCaptionSkillSystemPrompt,
  compileViralSemanticCaptionPlan,
  viralCaptionKeywordTargets,
  viralCaptionSkillTitleIsValid,
  VIRAL_CAPTION_AI_MODEL,
} from "../viral-caption-ai-skill";

type ProviderResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  output_text?: string;
};

const DIRECTOR_CACHE_MAX = 128;
const directorCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const NODES = new Set<ViralCaptionPlanItem["contentNode"]>([
  "hook", "pain_reversal", "core_viewpoint", "number_benefit",
  "example_step", "brand_entity", "cta", "supporting",
]);

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  const record = value as Record<string, unknown>;
  for (const key of ["output_text", "text", "value", "content", "message", "choices", "output"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return "";
}

function plain(value: string) {
  return value.toLocaleLowerCase().replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
}

function localNode(text: string, index: number, total: number): ViralCaptionPlanItem["contentNode"] {
  const value = text.replace(/\s+/g, "");
  if (/^(?:大家好|你好|我是|我叫|来自)/.test(value)) return "supporting";
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
  const cameraIntent: ViralCaptionPlanItem["cameraIntent"] = node === "hook"
    ? "push-in"
    : node === "number_benefit"
      ? "close-up"
      : node === "example_step"
        ? "reframe"
        : node === "cta"
          ? "pull-back"
          : weight >= 0.72
            ? "push-in"
            : "hold";
  const transitionIntent: ViralCaptionPlanItem["transitionIntent"] = node === "hook"
    ? "cut"
    : node === "pain_reversal"
      ? "focus-bridge"
      : node === "example_step"
        ? "matched-reframe"
        : node === "cta"
          ? "foreground-occlusion"
          : "none";
  const sfxRole: ViralCaptionPlanItem["sfxRole"] = ({
    hook: "hook",
    pain_reversal: "reversal",
    core_viewpoint: "viewpoint",
    number_benefit: "number",
    example_step: "step",
    brand_entity: "brand",
    cta: "cta",
    supporting: "none",
  } as const)[node || "supporting"];
  return { cameraIntent, transitionIntent, sfxRole };
}

function localFallbackTitle(captions: ViralCaptionPlanItem[], script: string) {
  const candidates = [
    ...captions.map((caption) => caption.text),
    ...(script || "").split(/[。！？!?；;\n]/g),
  ]
    .map((value) => value.replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·\s-]/g, ""))
    .filter(Boolean)
    .filter((value) => !/^(?:大家好|你好|我是|我叫|来自|今天给大家|我用)/.test(value));
  const trimmed = candidates.map((value) => value
    .replace(/^(?:最大的特点就是|它的特点就是|核心就是|重点就是|做到|然后|所以|其实)/, "")
    .slice(0, 20));
  const semantic = trimmed
    .filter((value) => value.length >= 6)
    .sort((left, right) => {
      const score = (value: string) => (
        Number(/提升|增长|效率|收益|省|免费|机会|方法|价值|网感|真实|关键|结果|入驻|解决/.test(value)) * 8
        + Number(value.length >= 8 && value.length <= 16) * 5
        - Math.max(0, value.length - 16)
      );
      return score(right) - score(left);
    })[0];
  return semantic?.slice(0, 16) || "口播核心观点";
}

function localPlan(captions: ViralCaptionPlanItem[], script: string, templateId: string) {
  const contract = viralCaptionTemplateContract(templateId);
  const enriched = captions.map((caption, index) => {
    const lineLayout = planViralCaptionLayout(caption.text, caption.captionLines, contract.lineMaxUnits);
    const contentNode = localNode(caption.text, index, captions.length);
    const contentWeight = contentNode === "supporting"
      ? 0.35
      : contentNode === "brand_entity"
        ? 0.58
        : index === 0 || index === captions.length - 1
          ? 0.9
          : 0.72;
    return {
      ...caption,
      translation: caption.translation || "",
      contentNode,
      contentWeight,
      keywordOrigin: "none" as const,
      captionLineMode: lineLayout.mode,
      captionLines: lineLayout.lines,
      ...localIntents(contentNode, contentWeight),
    };
  });
  const planned = markViralKeywordSfx(compileViralCaptionCues(enriched, templateId));
  const titleLayout = planViralTitleLayout(localFallbackTitle(captions, script));
  return { title: titleLayout.serializedTitle, titleLines: titleLayout.lines, captions: planned };
}

function cacheKey(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cachedDirectorPlan(key: string) {
  const entry = directorCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    directorCache.delete(key);
    return null;
  }
  directorCache.delete(key);
  directorCache.set(key, entry);
  return entry.value;
}

function rememberDirectorPlan(key: string, value: Record<string, unknown>) {
  directorCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
  while (directorCache.size > DIRECTOR_CACHE_MAX) {
    const oldest = directorCache.keys().next().value;
    if (!oldest) break;
    directorCache.delete(oldest);
  }
}

export async function planViralCaptionDirector(input: {
  captions: unknown;
  duration: number;
  script?: string;
  templateId?: string;
}) {
  const duration = Math.max(1, Math.min(600, Number(input.duration) || 600));
  const source = sanitizeViralCaptionPlan(input.captions, duration);
  if (!source.length) throw new Error("没有可用于网感剪辑的字幕时间轴。");
  const script = typeof input.script === "string" ? input.script.trim().slice(0, 12_000) : "";
  const templateId = typeof input.templateId === "string" ? input.templateId.trim().slice(0, 64) : "template-9";
  const contract = viralCaptionTemplateContract(templateId);
  const fallback = localPlan(source, script, templateId);
  const timeline = buildViralCaptionTokenTimeline(source);
  const compactInput = timeline.tokens.map((token) => [token.id, token.text]);
  const sourceLanguage = timeline.language;
  const key = cacheKey({
    prompt: `${VIRAL_DIRECTOR_PROMPT_VERSION}-global-word-director-v4`,
    model: VIRAL_CAPTION_AI_MODEL,
    templateId,
    contract,
    script,
    timeline: timeline.tokens.map((token) => [token.text, token.start, token.end]),
  });
  const cached = cachedDirectorPlan(key);
  if (cached) return { ...cached, cache: "hit" };
  const system = buildViralCaptionSkillSystemPrompt({
    language: sourceLanguage,
    captionContract: contract,
    timelinePrecision: timeline.precision,
  });
  const keywordTargets = viralCaptionKeywordTargets(source.length, duration);
  const requestStartedAt = Date.now();
  try {
    const aiResult = await requestViralCaptionAi<ProviderResponse>({
      captionCount: source.length,
      maxTokens: 760 + source.length * 86,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `这是整段口播的${timeline.precision === "word" ? "逐词" : "分句"}编号时间轴。${viralCaptionConstraintPrompt(contract)}最终c必须连续覆盖0到${Math.max(0, timeline.tokens.length - 1)}。全片应有${keywordTargets.minimumKeywords}到${keywordTargets.maximumKeywords}个非空k，其中1到${keywordTargets.primaryTarget}个p="primary"，其余非空k为regular；关键词要分散且不能重复泛词。只处理以下有序词表：${JSON.stringify(compactInput)}`,
        },
      ],
    });
    const parsed = parseAiJsonObject(extractText(aiResult.response), "AI 没有返回结构化字幕规划。");
    const compiled = compileViralSemanticCaptionPlan({
      value: parsed.c ?? parsed.cues ?? parsed.captions,
      timeline,
      contract,
    });
    if (!compiled.cues.length) throw new Error(compiled.error || "AI 没有返回可用的全稿语义规划。");
    const parsedTitle = typeof parsed.title === "string" ? parsed.title : typeof parsed.t === "string" ? parsed.t : "";
    const plannedSource = compiled.cues.map((cue, index) => {
      const text = cue.text.slice(0, 180);
      const node = NODES.has(cue.contentNode)
        ? cue.contentNode
        : localNode(text, index, compiled.cues.length);
      const contentWeight = cue.contentWeight;
      const candidate = cue.keyword;
      const keyword = candidate && plain(text).includes(plain(candidate))
        ? sanitizeViralKeyword(text, candidate, node, candidate ? Math.max(contentWeight, 0.75) : contentWeight)
        : "";
      return {
        start: cue.start,
        end: cue.end,
        ...(cue.words?.length ? { words: cue.words } : {}),
        text,
        ...(keyword ? { keyword } : {}),
        translation: cue.translation,
        contentNode: node,
        contentWeight,
        keywordOrigin: keyword ? "ai" as const : "none" as const,
        ...(keyword ? {
          keywordImportance: cue.keywordImportance === "primary" ? "primary" as const : "regular" as const,
          ...(cue.keywordImportance === "primary" ? { keywordSfx: true } : {}),
        } : {}),
        captionLineMode: cue.captionLines.length > 1 ? "two-line" as const : "single" as const,
        captionLines: cue.captionLines,
        ...localIntents(node, contentWeight),
      };
    });
    const compiledCaptions = plannedSource;
    const aiKeywordCount = compiledCaptions.filter((caption) => caption.keywordOrigin === "ai" && caption.keyword).length;
    const aiPrimaryCount = compiledCaptions.filter((caption) => (
      caption.keywordOrigin === "ai" && caption.keyword && caption.keywordImportance === "primary"
    )).length;
    if (
      aiKeywordCount < keywordTargets.minimumKeywords
      || aiKeywordCount > keywordTargets.maximumKeywords
      || aiPrimaryCount < Math.min(1, keywordTargets.primaryTarget)
      || aiPrimaryCount > keywordTargets.primaryTarget
    ) {
      throw new Error("AI 没有完成模板字幕、提亮关键词与重点词规划。");
    }
    const captions = markViralKeywordSfx(compiledCaptions, duration);
    const rawTitle = parsedTitle.trim()
      ? normalizeViralTitleSyntax(parsedTitle.trim().replace(/[。！？!?]+$/g, "").slice(0, 40))
      : fallback.title;
    const aiTitleAccepted = Boolean(parsedTitle.trim())
      && viralCaptionSkillTitleIsValid(rawTitle.replace(/\n/g, ""), sourceLanguage);
    const guardedTitle = aiTitleAccepted ? rawTitle : fallback.title;
    const titleLayout = planViralTitleLayout(
      guardedTitle,
      aiTitleAccepted ? parsed.title_lines ?? parsed.tl : fallback.titleLines,
    );
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title: titleLayout.serializedTitle,
      titleLines: titleLayout.lines,
      duration,
      captions,
      bgmMood: parsed.bgm_mood as "calm" | "warm" | "professional" | "uplifting" | "neutral",
      source: "ai",
      model: aiResult.model,
      degraded: false,
    });
    const result = {
      title: titleLayout.serializedTitle,
      titleLines: titleLayout.lines,
      captions: directorPlan.captions,
      planReady: true,
      degraded: false,
      model: aiResult.model,
      provider: aiResult.provider,
      planningRole: "global-semantic-caption-director",
      timelineRole: timeline.precision === "word" ? "upstream-word-timing" : "upstream-segment-timing",
      titleSource: aiTitleAccepted ? "ai" : "semantic-guardrail",
      providerFallbackWarning: aiResult.fallbackFailures?.join("；") || null,
      warning: aiTitleAccepted ? null : "AI 标题未通过完整语义校验，已保留其他AI规划并自动换用安全标题。",
      directorPlan,
      sourceCaptionCount: source.length,
      compiledCaptionCount: directorPlan.captions.length,
      autoSplitCaptionCount: compiled.autoSplitCount,
      requestMs: Date.now() - requestStartedAt,
      cache: "miss",
    };
    if (aiResult.provider === "deepseek") rememberDirectorPlan(key, result);
    return result;
  } catch (error) {
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title: fallback.title,
      titleLines: fallback.titleLines,
      duration,
      captions: fallback.captions,
      source: "local-fallback",
      model: "local-safe-compiler",
      degraded: true,
    });
    return {
      ...fallback,
      captions: directorPlan.captions,
      planReady: false,
      degraded: true,
      model: "local-safe-compiler",
      provider: "local",
      planningRole: "deterministic-fallback",
      timelineRole: "upstream-timing-only",
      directorPlan,
      sourceCaptionCount: source.length,
      compiledCaptionCount: directorPlan.captions.length,
      warning: error instanceof Error
        ? `AI 内容导演未完成：${error.message} 请重试，或手动调整标题与关键词。`
        : "AI 内容导演未完成，请重试，或手动调整标题与关键词。",
      requestMs: Date.now() - requestStartedAt,
      cache: "miss",
    };
  }
}
