import {
  normalizeViralCaptionText,
  viralCaptionUnitCount,
  type ViralCaptionTemplateContract,
} from "./viral-caption-contract";
import { planViralCaptionLayout } from "./viral-semantic-layout";
import { acceptViralCaptionCorrection, viralPlainText } from "./viral-text-integrity";

export const VIRAL_CAPTION_AI_SKILL_ID = "talking-head-semantic-caption-director";
export const VIRAL_CAPTION_AI_SKILL_VERSION = "2026-08-30-v7-global-word-timeline";
export const VIRAL_CAPTION_AI_MODEL = process.env.DEEPSEEK_CAPTION_MODEL?.trim() || "deepseek-v4-flash";
export const VIRAL_CAPTION_AI_FALLBACK_MODEL = process.env.VIRAL_CAPTION_AI_FALLBACK_MODEL?.trim()
  || process.env.VIRAL_CAPTION_AI_MODEL?.trim()
  || "tt-5.5";
const configuredTimeout = Number(process.env.VIRAL_CAPTION_AI_TIMEOUT_MS?.trim() || Number.NaN);
export const VIRAL_CAPTION_AI_TIMEOUT_MS = Number.isFinite(configuredTimeout)
  ? Math.max(8_000, Math.min(30_000, Math.round(configuredTimeout)))
  : 22_000;
const configuredFallbackTimeout = Number(process.env.VIRAL_CAPTION_AI_FALLBACK_TIMEOUT_MS?.trim() || Number.NaN);
export const VIRAL_CAPTION_AI_FALLBACK_TIMEOUT_MS = Number.isFinite(configuredFallbackTimeout)
  ? Math.max(6_000, Math.min(18_000, Math.round(configuredFallbackTimeout)))
  : 12_000;

export type ViralCaptionSkillLanguage = "zh" | "en";
export type ViralKeywordImportance = "none" | "regular" | "primary";

export type ViralCaptionSource = {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; text: string }>;
};

export type ViralCaptionTimelineToken = {
  id: number;
  start: number;
  end: number;
  text: string;
  sourceIndex: number;
};

export type ViralCaptionTokenTimeline = {
  precision: "word" | "segment";
  language: ViralCaptionSkillLanguage;
  tokens: ViralCaptionTimelineToken[];
};

export type ViralSemanticCaptionCue = {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; text: string }>;
  captionLines: string[];
  keyword: string;
  keywordImportance: ViralKeywordImportance;
  translation: string;
  contentNode: "hook" | "pain_reversal" | "core_viewpoint" | "number_benefit" | "example_step" | "brand_entity" | "cta" | "supporting";
  contentWeight: number;
};

const CONTENT_NODES = new Set<ViralSemanticCaptionCue["contentNode"]>([
  "hook", "pain_reversal", "core_viewpoint", "number_benefit",
  "example_step", "brand_entity", "cta", "supporting",
]);

function normalizedTokenText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return detectViralCaptionSkillLanguage(text) === "en"
    ? text.replace(/\s+/g, " ")
    : text.replace(/\s+/g, "");
}

function tokenText(tokens: ViralCaptionTimelineToken[], language: ViralCaptionSkillLanguage) {
  return language === "en"
    ? tokens.map((token) => token.text).join(" ").replace(/\s+/g, " ").trim()
    : tokens.map((token) => token.text).join("").replace(/\s+/g, "");
}

/**
 * Convert ASR transport chunks into one stable, ordered token timeline.  Word
 * timestamps are preferred.  If an upstream workflow only has sentence
 * timings, each sentence remains an indivisible token: AI may join sentences
 * but cannot invent sub-sentence timing.
 */
export function buildViralCaptionTokenTimeline(captions: ViralCaptionSource[]): ViralCaptionTokenTimeline {
  const ordered = captions
    .map((caption, sourceIndex) => ({ ...caption, sourceIndex }))
    .filter((caption) => normalizedTokenText(caption.text) && caption.end > caption.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const language = detectViralCaptionSkillLanguage(ordered.map((caption) => caption.text).join(" "));
  const seen = new Set<string>();
  const words = ordered.flatMap((caption) => (caption.words || []).flatMap((word) => {
    const text = normalizedTokenText(word.text);
    const start = Math.max(caption.start, Number(word.start) || caption.start);
    const end = Math.min(caption.end, Math.max(start + 0.01, Number(word.end) || start + 0.04));
    const key = `${start.toFixed(3)}:${end.toFixed(3)}:${text}`;
    if (!text || end <= start || seen.has(key)) return [];
    seen.add(key);
    return [{ start, end, text, sourceIndex: caption.sourceIndex }];
  })).sort((left, right) => left.start - right.start || left.end - right.end);
  const sourcePlain = viralPlainText(ordered.map((caption) => caption.text).join(""));
  const wordPlain = viralPlainText(tokenText(words.map((word, id) => ({ ...word, id })), language));
  const coverage = sourcePlain ? wordPlain.length / sourcePlain.length : 0;
  const useWords = words.length >= Math.max(2, ordered.length) && coverage >= 0.72 && coverage <= 1.3;
  const rawTokens = useWords
    ? words
    : ordered.map((caption) => ({
      start: caption.start,
      end: caption.end,
      text: normalizedTokenText(caption.text),
      sourceIndex: caption.sourceIndex,
    }));
  return {
    precision: useWords ? "word" : "segment",
    language,
    tokens: rawTokens.map((token, id) => ({ ...token, id })),
  };
}

export function viralCaptionKeywordTargets(captionCount: number, duration: number) {
  const safeCount = Math.max(1, Math.round(Number(captionCount) || 1));
  const keywordTarget = safeCount <= 4
    ? 1
    : Math.max(2, Math.min(6, Math.round(safeCount * 0.27)));
  const primaryTarget = duration > 90 ? 3 : duration > 45 ? 2 : 1;
  return {
    keywordTarget,
    primaryTarget: Math.min(primaryTarget, keywordTarget),
    minimumKeywords: Math.max(1, keywordTarget - 1),
    maximumKeywords: Math.min(safeCount, keywordTarget + 1),
  };
}

export function detectViralCaptionSkillLanguage(value: string): ViralCaptionSkillLanguage {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return latinWords.length * 2 > cjk ? "en" : "zh";
}

export function normalizeViralKeywordImportance(value: unknown, hasKeyword: boolean): ViralKeywordImportance {
  if (!hasKeyword) return "none";
  return value === "primary" ? "primary" : "regular";
}

export function viralCaptionSkillTitleIsValid(value: string, language: ViralCaptionSkillLanguage) {
  const title = value.trim();
  if (language === "en") {
    const words = title.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
    return words.length >= 3
      && words.length <= 12
      && !/\b(?:and|or|but|because|so|the|a|an|to|of|for|with|that|which)$/i.test(title);
  }
  const compact = title.replace(/[《》“”"'‘’：:。！？!?，,；;、*#\s]+/gu, "");
  return compact.length >= 8
    && compact.length <= 16
    && !/(?:的|和|与|就|都|也|在|让|属于|因为|所以|但是)$/.test(compact);
}

export function buildViralCaptionSkillSystemPrompt(options?: {
  language?: ViralCaptionSkillLanguage;
  captionContract?: {
    templateId: string;
    lineMaxUnits: number;
    cueMaxUnits: number;
    maxLines: number;
  };
  timelinePrecision?: ViralCaptionTokenTimeline["precision"];
}) {
  const language = options?.language || "zh";
  const contract = options?.captionContract;
  const contractRule = contract
    ? `当前模板${contract.templateId}：每屏最多${contract.maxLines}行、每行最多${contract.lineMaxUnits}个中文/字母数字单位、每屏最多${contract.cueMaxUnits}个单位。`
    : "每屏最多2行；具体字数以用户消息中的模板约束为准。";
  const languageRule = language === "en"
    ? "英文口播：t、x、l用英文，z用简短中文。"
    : "中文口播：t、x、l用中文，z用简短自然英文。";

  const timelineRule = options?.timelinePrecision === "word"
    ? "输入是带稳定编号的逐词时间轴，可以在任意相邻词编号之间建立字幕边界。"
    : "输入只有分句级时间轴，每个编号都是不可拆分的最小时间单元；可以合并相邻编号，但不能拆开一个编号。";

  // This is the only semantic caption agent. ASR owns evidence and timing;
  // the deterministic compiler verifies coverage, timestamps and safe areas.
  return `你是唯一的“口播语义字幕导演”。你读取整段口播的有序时间词表，一次完成：文字校正、标题、全稿语义断句、视觉换行、提亮词、重点词和双语翻译。${timelineRule}

硬规则：
1. 输入词表格式为[id,文字]。c中的a、b分别是本屏字幕首词和末词id。所有c必须从id=0开始，按顺序、连续、无重叠、无遗漏覆盖到最后一个id；不能改id顺序。允许跨原ASR句段重新组合，这正是你的职责。
2. x只能修正确定的同音错字、品牌名、数字和标点；不得总结、改写、扩写。${languageRule}
3. 先理解整篇的论述结构、转折、因果、并列、步骤序号和指代，再决定每一屏的a、b。字幕边界必须落在完整语义单元之间，不得拆开词语、固定搭配、偏正短语、动宾短语、数量单位、品牌名或英文产品名；步骤序号必须与它引出的步骤在同一屏。容量是上限，不是凑满字数的目标。
4. l是本屏最终视觉行，1到${contract?.maxLines || 2}行，按顺序拼接必须等于x。${contractRule}不让“的、地、得、了、和、与、在、就、都、把、被”等虚词孤立在行首或行尾；能安全放下的完整短句保持一屏。
5. 标题先理解全文再提炼，不能用问候或机械拼接前两句。中文8到16字；英文3到12词。tl为1到2行，拼接后等于t，不能拆固定短语。
6. k必须是x中连续出现的2到8字完整信息短语；数字可单独提亮。问候、自我介绍及“我、AI、视频、工具、剪辑”等泛词不能单独提亮。用户消息会给出目标范围，按信息价值选择并分散出现，其余k为空。
7. p只能是none、regular、primary。无k则none；普通提亮为regular；primary只给全片最重要的钩子、利益数字、反差、结论或行动号召，60秒内最多3个且尽量间隔4秒，会触发音效，宁缺毋滥。
8. n标记本屏传播作用，只能是hook、pain_reversal、core_viewpoint、number_benefit、example_step、brand_entity、cta、supporting；w是0到1的重要度。
9. 只返回一个紧凑JSON对象，不要Markdown、解释、前后缀或第二个JSON。

为减少延迟，必须使用以下短字段：t=标题，tl=标题行，c=字幕屏数组，a=首词id，b=末词id，x=校正字幕，l=视觉行，k=提亮词，p=none|regular|primary，z=简短翻译，n=内容作用，w=重要度。
输出：{"t":"完整标题","tl":["第一行","第二行"],"c":[{"a":0,"b":4,"x":"这一屏校正后的完整字幕","l":["第一行","第二行"],"k":"提亮词或空字符串","p":"none|regular|primary","z":"简短翻译","n":"hook","w":0.9}]}。`;
}

function directedLines(value: unknown, text: string, contract: ViralCaptionTemplateContract) {
  const lines = Array.isArray(value)
    ? value.filter((line): line is string => typeof line === "string")
      .map(normalizeViralCaptionText).filter(Boolean).slice(0, contract.maxLines)
    : [];
  if (
    lines.length
    && viralPlainText(lines.join("")) === viralPlainText(text)
    && lines.every((line) => viralCaptionUnitCount(line) <= contract.lineMaxUnits)
    && viralCaptionUnitCount(lines.join("")) <= contract.cueMaxUnits
  ) return lines;
  const fallback = planViralCaptionLayout(text, undefined, contract.lineMaxUnits).lines.slice(0, contract.maxLines);
  return fallback.length
    && viralPlainText(fallback.join("")) === viralPlainText(text)
    && fallback.every((line) => viralCaptionUnitCount(line) <= contract.lineMaxUnits)
    && viralCaptionUnitCount(fallback.join("")) <= contract.cueMaxUnits
    ? fallback
    : [];
}

function badSemanticBoundary(left: string, right: string, language: ViralCaptionSkillLanguage) {
  if (!left || !right) return true;
  if (language === "en") {
    return /\b(?:a|an|the|and|or|but|because|with|for|to|of|in|on|at|from|by)$/i.test(left)
      || /^(?:s|es|ed|ing|ly)\b/i.test(right);
  }
  return /(?:的|地|得|和|与|及|或|而|但|却|就|都|也|还|再|又|把|被|让|给|向|从|在|到|为|对|比|像|如果|因为|所以|不仅|以及)$/u.test(left)
    || /^(?:的|地|得|了|着|过|就|才|和|与|及|或|把|被|让|给|以及)/u.test(right);
}

function boundariesFollowWords(cues: ViralSemanticCaptionCue[], language: ViralCaptionSkillLanguage) {
  if (language !== "zh" || typeof Intl.Segmenter !== "function" || cues.length <= 1) return true;
  const text = cues.map((cue) => normalizeViralCaptionText(cue.text)).join("");
  const boundaries = new Set<number>([0, text.length]);
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  for (const segment of segmenter.segment(text)) {
    boundaries.add(segment.index);
    boundaries.add(segment.index + segment.segment.length);
  }
  let offset = 0;
  return cues.slice(0, -1).every((cue) => {
    offset += normalizeViralCaptionText(cue.text).length;
    return boundaries.has(offset);
  });
}

/** Compile and prove an AI full-transcript plan against the immutable timeline. */
export function compileViralSemanticCaptionPlan(input: {
  value: unknown;
  timeline: ViralCaptionTokenTimeline;
  contract: ViralCaptionTemplateContract;
}) {
  const rawCues = Array.isArray(input.value) ? input.value : [];
  const tokens = input.timeline.tokens;
  if (!tokens.length || !rawCues.length || rawCues.length > 240) {
    return { cues: [] as ViralSemanticCaptionCue[], error: "AI 没有返回全稿字幕分段。" };
  }
  const cues: ViralSemanticCaptionCue[] = [];
  let expectedToken = 0;
  for (const value of rawCues) {
    if (!value || typeof value !== "object") return { cues: [], error: "AI 字幕分段格式不完整。" };
    const raw = value as Record<string, unknown>;
    const first = Number(raw.a ?? raw.from);
    const last = Number(raw.b ?? raw.to);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first !== expectedToken || last < first || last >= tokens.length) {
      return { cues: [], error: "AI 字幕分段没有连续覆盖完整口播。" };
    }
    const cueTokens = tokens.slice(first, last + 1);
    const source = tokenText(cueTokens, input.timeline.language);
    const text = acceptViralCaptionCorrection(source, raw.x ?? raw.text);
    if (!text || viralCaptionUnitCount(text) > input.contract.cueMaxUnits) {
      return { cues: [], error: "AI 字幕分段超过当前模板容量。" };
    }
    const lines = directedLines(raw.l ?? raw.lines, text, input.contract);
    if (!lines.length) return { cues: [], error: "AI 字幕换行不符合当前模板容量。" };
    const keyword = typeof (raw.k ?? raw.keyword) === "string"
      ? String(raw.k ?? raw.keyword).trim().replace(/\s+/g, "").slice(0, 8)
      : "";
    const importance = normalizeViralKeywordImportance(raw.p ?? raw.importance, Boolean(keyword));
    const contentNode = CONTENT_NODES.has(String(raw.n ?? raw.content_node) as ViralSemanticCaptionCue["contentNode"])
      ? String(raw.n ?? raw.content_node) as ViralSemanticCaptionCue["contentNode"]
      : "supporting";
    const contentWeight = Math.max(0, Math.min(1, Number(raw.w ?? raw.weight) || 0.5));
    cues.push({
      start: Number(cueTokens[0].start.toFixed(3)),
      end: Number(Math.max(cueTokens[0].start + 0.04, cueTokens.at(-1)!.end).toFixed(3)),
      text,
      ...(input.timeline.precision === "word" ? {
        words: cueTokens.map((token) => ({ start: token.start, end: token.end, text: token.text })),
      } : {}),
      captionLines: lines,
      keyword,
      keywordImportance: importance,
      translation: typeof (raw.z ?? raw.translation) === "string" ? String(raw.z ?? raw.translation).trim().slice(0, 240) : "",
      contentNode,
      contentWeight,
    });
    expectedToken = last + 1;
  }
  if (expectedToken !== tokens.length) return { cues: [], error: "AI 字幕分段遗漏了部分口播。" };
  if (cues.some((cue, index) => index < cues.length - 1 && badSemanticBoundary(cue.text, cues[index + 1].text, input.timeline.language))) {
    return { cues: [], error: "AI 字幕仍存在不完整语义边界。" };
  }
  if (!boundariesFollowWords(cues, input.timeline.language)) {
    return { cues: [], error: "AI 字幕边界拆开了完整词语。" };
  }
  return { cues, error: "" };
}

export function buildViralCaptionSkillRequest(input: {
  messages: Array<Record<string, unknown>>;
  captionCount: number;
  maxTokens?: number;
  model?: string;
  provider?: "deepseek" | "lk888";
}) {
  const request: Record<string, unknown> = {
    model: input.model || VIRAL_CAPTION_AI_MODEL,
    temperature: 0.02,
    max_tokens: Math.max(
      800,
      Math.min(1900, Number(input.maxTokens) || 700 + input.captionCount * 70),
    ),
    response_format: { type: "json_object" },
    messages: input.messages,
  };
  if (input.provider === "deepseek") {
    request.thinking = { type: "disabled" };
    request.reasoning_effort = "low";
  }
  return request;
}
