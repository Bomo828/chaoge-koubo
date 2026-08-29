import { createHash } from "node:crypto";
import { getMemberSession } from "../../../member-session";
import { lk888Fetch } from "../../../../lib/lk888";
import {
  buildViralDirectorPlan,
  markViralKeywordSfx,
  sanitizeViralKeyword,
  sanitizeViralCaptionPlan,
  VIRAL_DIRECTOR_PROMPT_VERSION,
  type ViralCaptionPlanItem,
} from "../../../../lib/viral-workflow";
import { normalizeViralTitleSyntax, planViralCaptionLayout, planViralTitleLayout } from "../../../../lib/viral-semantic-layout";
import { acceptViralCaptionCorrection } from "../../../../lib/viral-text-integrity";
import {
  buildViralCaptionSkillRequest,
  buildViralCaptionSkillSystemPrompt,
  detectViralCaptionSkillLanguage,
  normalizeViralKeywordImportance,
  viralCaptionSkillTitleIsValid,
  VIRAL_CAPTION_AI_MODEL,
  VIRAL_CAPTION_AI_TIMEOUT_MS,
} from "../../../../lib/viral-caption-ai-skill";

type ProviderResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  output_text?: string;
};

// A complete title/keyword/director plan for 10-20 captions regularly takes
// longer than eight seconds on the shared provider.  The previous limit made
// healthy AI requests look like failures and silently exposed the local
// fallback as if it were an AI result.
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

function parseJson(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 没有返回结构化字幕规划。");
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
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

function localPlan(captions: ViralCaptionPlanItem[], script: string) {
  const planned = captions.map((caption, index) => {
    const lineLayout = planViralCaptionLayout(caption.text, caption.captionLines, 10);
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
  const titleLayout = planViralTitleLayout(localFallbackTitle(captions, script));
  return { title: titleLayout.serializedTitle, titleLines: titleLayout.lines, captions: markViralKeywordSfx(planned) };
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

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const duration = Math.max(1, Math.min(600, Number(body.duration) || 600));
  const source = sanitizeViralCaptionPlan(body.captions, duration);
  if (!source.length) return Response.json({ error: "没有可用于网感剪辑的字幕时间轴。" }, { status: 400 });
  const script = typeof body.script === "string" ? body.script.trim().slice(0, 12_000) : "";
  const templateId = typeof body.templateId === "string" ? body.templateId.trim().slice(0, 64) : "template-9";
  const fallback = localPlan(source, script);
  const input = source.map((caption, id) => ({ id, start: caption.start, end: caption.end, text: caption.text }));
  const sourceText = script || source.map((item) => item.text).join("。");
  const sourceLanguage = detectViralCaptionSkillLanguage(sourceText);
  const key = cacheKey({ prompt: VIRAL_DIRECTOR_PROMPT_VERSION, model: VIRAL_CAPTION_AI_MODEL, templateId, script, input });
  const cached = cachedDirectorPlan(key);
  if (cached) return Response.json({ ...cached, cache: "hit" });
  const system = buildViralCaptionSkillSystemPrompt({
    language: sourceLanguage,
    itemKey: "items",
    idBase: 0,
  });
  const requestStartedAt = Date.now();
  try {
    const response = await lk888Fetch<ProviderResponse>("/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(VIRAL_CAPTION_AI_TIMEOUT_MS),
      body: JSON.stringify(buildViralCaptionSkillRequest({
        captionCount: source.length,
        maxTokens: source.length * 105,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `完整口播：${sourceText}\n确认时间轴：${JSON.stringify(input)}` },
        ],
      })),
    });
    const parsed = parseJson(extractText(response));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const itemsById = new Map<number, Record<string, unknown>>();
    items.forEach((item, responseIndex) => {
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      const id = Number(record.id);
      if (Number.isInteger(id) && id >= 0 && id < source.length) itemsById.set(id, record);
      else if (responseIndex < source.length && !itemsById.has(responseIndex)) itemsById.set(responseIndex, record);
    });
    if (!itemsById.size) throw new Error("AI 没有返回可用的逐句规划。");
    if (typeof parsed.title !== "string" || !parsed.title.trim()) throw new Error("AI 没有返回完整标题。");
    const plannedCaptions = source.map((caption, index) => {
      const raw = itemsById.get(index) || {};
      const text = acceptViralCaptionCorrection(caption.text, raw.corrected_text).slice(0, 180);
      const node = NODES.has(raw.content_node as ViralCaptionPlanItem["contentNode"])
        ? raw.content_node as ViralCaptionPlanItem["contentNode"]
        : localNode(text, index, source.length);
      const lineLayout = planViralCaptionLayout(text, raw.caption_lines, 10);
      const contentWeight = Math.max(0, Math.min(1, Number.isFinite(Number(raw.weight)) ? Number(raw.weight) : 0.5));
      const candidate = typeof raw.keyword === "string" ? raw.keyword.trim().replace(/\s+/g, "").slice(0, 8) : "";
      const keyword = candidate && plain(text).includes(plain(candidate))
        ? sanitizeViralKeyword(text, candidate, node, contentWeight)
        : "";
      const keywordImportance = normalizeViralKeywordImportance(raw.keyword_importance, Boolean(keyword));
      const local = localIntents(node, contentWeight);
      return {
        ...caption,
        text,
        ...(keyword ? { keyword } : {}),
        translation: typeof raw.translation === "string" ? raw.translation.trim().slice(0, 240) : "",
        contentNode: node,
        contentWeight,
        keywordOrigin: keyword ? "ai" as const : "none" as const,
        ...(keyword ? {
          keywordImportance: keywordImportance === "primary" ? "primary" as const : "regular" as const,
          ...(keywordImportance === "primary" ? { keywordSfx: true } : {}),
        } : {}),
        captionLineMode: lineLayout.mode,
        captionLines: lineLayout.lines,
        ...local,
      };
    });
    if (source.length > 4 && !plannedCaptions.some((caption) => caption.keywordOrigin === "ai" && caption.keyword)) {
      throw new Error("AI 没有完成语义关键词规划。");
    }
    const captions = markViralKeywordSfx(plannedCaptions, duration);
    const rawTitle = typeof parsed.title === "string" && parsed.title.trim()
      ? normalizeViralTitleSyntax(parsed.title.trim().replace(/[。！？!?]+$/g, "").slice(0, 40))
      : fallback.title;
    if (!viralCaptionSkillTitleIsValid(rawTitle.replace(/\n/g, ""), sourceLanguage)) {
      throw new Error("AI 返回的标题不是完整自然语义。");
    }
    const titleLayout = planViralTitleLayout(rawTitle, parsed.title_lines);
    const title = titleLayout.serializedTitle;
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title,
      titleLines: titleLayout.lines,
      duration,
      captions,
      bgmMood: parsed.bgm_mood as "calm" | "warm" | "professional" | "uplifting" | "neutral",
      source: "ai",
      model: VIRAL_CAPTION_AI_MODEL,
      degraded: false,
    });
    const result = {
      title,
      titleLines: titleLayout.lines,
      captions: directorPlan.captions,
      planReady: true,
      degraded: false,
      model: VIRAL_CAPTION_AI_MODEL,
      directorPlan,
      requestMs: Date.now() - requestStartedAt,
      cache: "miss",
    };
    rememberDirectorPlan(key, result);
    return Response.json(result);
  } catch (error) {
    console.warn("Fast viral caption plan fell back to local rules", error);
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title: fallback.title,
      titleLines: fallback.titleLines,
      duration,
      captions: fallback.captions,
      source: "local-fallback",
      model: "local-fast-plan",
      degraded: true,
    });
    const result = {
      ...fallback,
      captions: directorPlan.captions,
      planReady: false,
      degraded: true,
      model: "local-fast-plan",
      directorPlan,
      warning: error instanceof Error
        ? `AI 规划未完成：${error.message} 请重试 AI 规划，或手动填写标题与关键词。`
        : "AI 规划未完成，请重试 AI 规划，或手动填写标题与关键词。",
      requestMs: Date.now() - requestStartedAt,
      cache: "miss",
    };
    return Response.json(result);
  }
}
