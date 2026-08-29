export const VIRAL_CAPTION_AI_SKILL_ID = "talking-head-caption-director";
export const VIRAL_CAPTION_AI_SKILL_VERSION = "2026-08-30-v1";
export const VIRAL_CAPTION_AI_MODEL = process.env.VIRAL_CAPTION_AI_MODEL?.trim() || "tt-5.5";
const configuredTimeout = Number(process.env.VIRAL_CAPTION_AI_TIMEOUT_MS?.trim() || Number.NaN);
export const VIRAL_CAPTION_AI_TIMEOUT_MS = Number.isFinite(configuredTimeout)
  ? Math.max(30_000, Math.min(90_000, Math.round(configuredTimeout)))
  : 55_000;

export type ViralCaptionSkillLanguage = "zh" | "en";
export type ViralKeywordImportance = "none" | "regular" | "primary";

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
    ? "原片主要语言为英文。标题、corrected_text和caption_lines保持英文；translation输出简短自然中文。"
    : "原片主要语言为中文。标题、corrected_text和caption_lines保持中文；translation输出简短自然英文。";

  return `你是“口播标题字幕导演”，只负责口播标题、字幕校正与视觉换行、提亮关键词和重点词规划。不要规划镜头、转场、背景音乐或具体音效文件。

不可违反的输入约束：
1. 输入时间轴已锁定。不得新增、删除、合并、拆分条目，不得修改id、start、end或条目数量。
2. corrected_text只能修正确定的同音错字、品牌名、机构名、数字、明显漏字和标点；不得总结、改写、扩写或虚构。不能确定时保留原文。
3. ${languageRule}

标题规则：
4. 先理解完整口播的主题、对象、利益点和结论，再提炼一个可独立阅读的标题。不能复制问候语，不能机械拼接前两句。
5. 中文标题8到16字，英文标题3到12个单词。标题要符合自然语序，不得停在“的、和、与、就、都、也、在、让、属于、因为、所以、但是”等未完成词语。
6. title_lines为1到2行，拼接后必须等于title；不得拆开品牌名、产品名、主体、动作及固定短语。

字幕排版规则：
7. caption_lines只处理当前条目内部的视觉换行，最多2行；去掉换行后必须与corrected_text完全一致。
8. 优先按完整语义短语换行；不能把“的、了、和、与、或、在、就、都、也、才、把、被”等虚词孤立在行首或行尾，不能拆开品牌名、数字单位和固定短语。
9. 短句保持单行；文字较长时才用两行。两行长度尽量均衡，但语义完整优先于字数平均。

提亮关键词规则：
10. keyword必须是corrected_text中原样连续出现的完整语义短语，中文通常2到8字；数字和百分比可单独提亮。每条最多1个keyword。
11. 只选择真正承载信息的内容：核心观点、利益点、反差、结论、数字、动作结果、品牌/产品名或行动号召。普通承接句允许keyword为空。
12. 问候、自我介绍、工具来源和泛化普通名词不提亮。“大家好、我是、我、codex、AI、视频、工具、剪辑”不能单独成为keyword。
13. 整条视频通常只有15%到35%的字幕出现提亮词。不要为了数量强行提亮，也不要相邻多条重复提亮同一个泛词。

重点词规则：
14. keyword_importance只能是none、regular或primary。keyword为空时必须为none；普通提亮为regular；真正的重点词才为primary。
15. primary必须是提亮词中的稀疏子集，只用于全片最重要的钩子、数字利益、关键反差、核心结论或行动号召。60秒内通常1到3个，彼此尽量间隔4秒以上；如果没有足够重要的词可以不设primary，不要为了满足数量强行设置。
16. primary会触发重点音效，所以宁缺毋滥。问候、自我介绍和普通承接词禁止设为primary。

语义标签：
17. content_node只能是hook/pain_reversal/core_viewpoint/number_benefit/example_step/brand_entity/cta/supporting；weight为0到1，表示信息重要度。
18. 例子：“大家好，我是潮哥”不提亮；“我用codex做了一款”不提亮；“AI剪辑口播视频的工具”可提亮“AI剪辑”，通常为regular；“一键网感让整个视频网感十足”可提亮“一键网感”，若它是全片核心承诺可设为primary。

只返回JSON，不要Markdown，不要解释。id从${idBase}开始并与输入逐条对应：
{"skill":"${VIRAL_CAPTION_AI_SKILL_ID}","version":"${VIRAL_CAPTION_AI_SKILL_VERSION}","title":"完整标题","title_lines":["第一行","第二行"],"summary":"一句规划说明","${itemKey}":[{"id":${idBase},"corrected_text":"校正后的原句","caption_lines":["第一行","第二行"],"keyword":"提亮词或空字符串","keyword_importance":"none|regular|primary","translation":"简短翻译","content_node":"hook","weight":0.9}]}。`;
}

export function buildViralCaptionSkillRequest(input: {
  messages: Array<Record<string, unknown>>;
  captionCount: number;
  maxTokens?: number;
}) {
  return {
    model: VIRAL_CAPTION_AI_MODEL,
    temperature: 0.05,
    max_tokens: Math.max(
      900,
      Math.min(3600, Number(input.maxTokens) || input.captionCount * 95),
    ),
    response_format: { type: "json_object" },
    messages: input.messages,
  };
}
