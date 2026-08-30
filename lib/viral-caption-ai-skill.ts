export const VIRAL_CAPTION_AI_SKILL_ID = "talking-head-caption-director";
export const VIRAL_CAPTION_AI_SKILL_VERSION = "2026-08-30-v4-deepseek";
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
  itemKey?: "items" | "captions";
  idBase?: 0 | 1;
}) {
  const language = options?.language || "zh";
  const itemKey = options?.itemKey || "items";
  const idBase = options?.idBase ?? 0;
  const languageRule = language === "en"
    ? "英文口播：title、corrected_text、caption_lines用英文，translation用简短中文。"
    : "中文口播：title、corrected_text、caption_lines用中文，translation用简短自然英文。";

  // Keep this agent deliberately narrow. ASR already supplied the accurate
  // timeline; camera, transition and SFX intent are derived after this pass.
  // Asking the model for unrelated fields made short scripts time out.
  return `你是“口播标题字幕导演”。输入已经含精确时间轴，你只做：文字校正、标题、视觉换行、提亮词、重点词和双语翻译。

硬规则：
1. id和条目数量必须与输入完全一致；不得改时间、增删、合并或拆分条目。
2. corrected_text只能修正确定的错字、品牌名、数字和标点；不得总结、改写、扩写。${languageRule}
3. 标题先理解全文再提炼，不能用问候或机械拼接前两句。中文8到16字；英文3到12词。title_lines为1到2行，拼接后等于title，不能拆固定短语。
4. caption_lines为1到2行，拼接后等于corrected_text。按完整语义短语换行，不让“的、了、和、与、在、就、都、把、被”等虚词孤立在行首或行尾，不拆品牌名和数字单位；短句保持单行。
5. keyword必须是corrected_text中连续出现的2到8字完整信息短语；数字可单独提亮。问候、自我介绍及“我、codex、AI、视频、工具、剪辑”等泛词不能单独提亮。用户消息会给出本次目标数量，必须按目标选择分散且有信息量的keyword，其余为空。
6. keyword_importance只能是none、regular、primary。无keyword则none；普通提亮为regular；primary只给全片最重要的钩子、利益数字、反差、结论或行动号召，60秒内0到3个且尽量间隔4秒，会触发音效，宁缺毋滥。
7. 输入条目使用[id,原句]精简数组。按id逐条处理，不要重复输出时间轴。
8. 只返回一个紧凑JSON对象，不要Markdown、解释、前后缀或第二个JSON。

为减少延迟，必须使用以下短字段：t=标题，tl=标题行，i=id，x=校正原句，l=字幕行，k=提亮词，p=none|regular|primary，z=简短翻译。
输出：{"t":"完整标题","tl":["第一行","第二行"],"${itemKey}":[{"i":${idBase},"x":"校正原句","l":["第一行","第二行"],"k":"提亮词或空字符串","p":"none|regular|primary","z":"简短翻译"}]}。`;
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
