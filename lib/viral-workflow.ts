export type ViralCaptionPlanItem = {
  start: number;
  end: number;
  text: string;
  keyword?: string;
  translation?: string;
  contentNode?: "hook" | "pain_reversal" | "core_viewpoint" | "number_benefit" | "example_step" | "brand_entity" | "cta" | "supporting";
  contentWeight?: number;
  keywordOrigin?: "ai" | "local" | "none";
  keywordSfx?: boolean;
  keywordImportance?: "primary" | "regular";
  captionLineMode?: "single" | "two-line";
  captionLines?: string[];
  cameraIntent?: "hold" | "push-in" | "pull-back" | "reframe" | "close-up" | "wide";
  transitionIntent?: "none" | "cut" | "matched-reframe" | "focus-bridge" | "foreground-occlusion";
  sfxRole?: "none" | "hook" | "reversal" | "viewpoint" | "number" | "step" | "brand" | "cta";
};

export const VIRAL_DIRECTOR_PLAN_VERSION = 1 as const;
export const VIRAL_DIRECTOR_PROMPT_VERSION = "viral-director-semantic-lock-v3";

export type ViralBgmMood = "calm" | "warm" | "professional" | "uplifting" | "neutral";

export type ViralDirectorPlan = {
  version: typeof VIRAL_DIRECTOR_PLAN_VERSION;
  kind: "viral-director-plan";
  promptVersion: string;
  templateId: string;
  title: string;
  titleLines: string[];
  duration: number;
  captions: ViralCaptionPlanItem[];
  bgmMood: ViralBgmMood;
  source: "ai" | "cache" | "local-fallback" | "user-confirmed";
  model: string;
  degraded: boolean;
  plannedAt: number;
};

export type ViralWorkflowManifest = {
  version: 1;
  kind: "lip-sync-viral";
  script: string;
  title: string;
  duration: number;
  captions: ViralCaptionPlanItem[];
  bgmMood?: ViralBgmMood;
  planReady: boolean;
  plannedAt: number;
};

const CONTENT_NODES = new Set<ViralCaptionPlanItem["contentNode"]>([
  "hook",
  "pain_reversal",
  "core_viewpoint",
  "number_benefit",
  "example_step",
  "brand_entity",
  "cta",
  "supporting",
]);

const CAMERA_INTENTS = new Set<ViralCaptionPlanItem["cameraIntent"]>([
  "hold", "push-in", "pull-back", "reframe", "close-up", "wide",
]);

const TRANSITION_INTENTS = new Set<ViralCaptionPlanItem["transitionIntent"]>([
  "none", "cut", "matched-reframe", "focus-bridge", "foreground-occlusion",
]);

const SFX_ROLES = new Set<ViralCaptionPlanItem["sfxRole"]>([
  "none", "hook", "reversal", "viewpoint", "number", "step", "brand", "cta",
]);

const KEYWORD_SFX_NODE_SCORE: Record<NonNullable<ViralCaptionPlanItem["contentNode"]>, number> = {
  hook: 4.2,
  pain_reversal: 4.0,
  core_viewpoint: 3.8,
  number_benefit: 4.6,
  example_step: 3.4,
  brand_entity: 3.2,
  cta: 3.9,
  supporting: 1.2,
};

const VIRAL_KEYWORD_STOPWORDS = new Set([
  "这个", "那个", "这些", "那些", "然后", "就是", "我们", "大家", "自己",
  "一个", "一些", "可以", "可能", "其实", "所以", "但是", "因为", "如果",
  "以及", "还是", "已经", "现在", "进行", "通过", "需要", "觉得", "感觉",
  "大家好", "你好", "我是", "我叫", "来自",
]);

const VIRAL_WEAK_STANDALONE_KEYWORDS = new Set([
  "ai", "视频", "工具", "剪辑", "内容", "功能", "素材", "文案", "字幕", "codex",
]);

function compactViralText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
}

/**
 * Accept only a grounded, informative phrase. An empty keyword is a valid
 * semantic decision and is safer than mechanically colouring a filler word.
 */
export function sanitizeViralKeyword(
  text: string,
  value: unknown,
  node: ViralCaptionPlanItem["contentNode"] = "supporting",
  weight = 0.5,
) {
  const original = typeof value === "string" ? value.trim().replace(/\s+/g, "") : "";
  const selected = compactViralText(original);
  const compactText = compactViralText(text);
  if (!selected || !compactText.includes(selected)) return "";
  if (selected.length > 8 || (selected.length < 2 && !/^\d$/.test(selected))) return "";
  if (VIRAL_KEYWORD_STOPWORDS.has(selected) || VIRAL_WEAK_STANDALONE_KEYWORDS.has(selected)) return "";
  if (/^[的了呢吗吧啊把被和与或就都也很在从]/.test(selected)) return "";
  if (/[的了呢吗吧啊着过和与或]$/.test(selected)) return "";
  if (selected === compactText && compactText.length > 5 && node !== "brand_entity") return "";
  if (/大家好|你好|我是|我叫|来自/.test(compactText) && node === "brand_entity") return "";
  if (node === "supporting" && Math.max(0, Math.min(1, Number(weight) || 0)) < 0.72) return "";
  return original;
}

/**
 * Keep visual highlights richer than the sound track. Every confirmed keyword
 * can remain highlighted, but only a sparse, well-spaced subset becomes a
 * sound-effect keyword shared by templates 9-12.
 */
export function markViralKeywordSfx(captions: ViralCaptionPlanItem[], duration?: number) {
  const result = captions.map((caption) => ({ ...caption }));
  const totalDuration = Math.max(
    1,
    Number(duration) || Math.max(...result.map((caption) => caption.end), 1),
  );
  const maximum = Math.max(1, Math.min(5, Math.ceil(totalDuration / 14)));
  const minimumGap = 4.2;
  const candidates = result.flatMap((caption, index) => {
    const keyword = String(caption.keyword || "").trim();
    if (!keyword || !caption.text.replace(/\s+/g, "").includes(keyword.replace(/\s+/g, ""))) return [];
    if (caption.keywordSfx === false) return [];
    const node = caption.contentNode || "supporting";
    const score = KEYWORD_SFX_NODE_SCORE[node]
      + Math.max(0, Math.min(1, Number(caption.contentWeight) || 0.45)) * 2
      + (caption.keywordSfx === true ? 100 : 0);
    return [{ index, start: caption.start, score, manual: caption.keywordSfx === true }];
  });
  const selected: number[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score || left.start - right.start)) {
    if (selected.length >= maximum) break;
    if (candidate.start < 1.15 || candidate.start > totalDuration - 1.0) continue;
    if (selected.some((index) => Math.abs(result[index].start - candidate.start) < minimumGap)) continue;
    selected.push(candidate.index);
  }
  // Very short clips may have their only meaningful keyword inside the opening
  // protection window. Keep one explicit key word rather than returning none.
  if (!selected.length && candidates.length) selected.push(candidates.sort((a, b) => b.score - a.score)[0].index);
  const selectedSet = new Set(selected);
  return result.map((caption, index) => ({
    ...caption,
    keywordSfx: selectedSet.has(index),
    keywordImportance: selectedSet.has(index) ? "primary" as const : "regular" as const,
  }));
}

function shortText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function sanitizeViralCaptionPlan(value: unknown, duration = 600): ViralCaptionPlanItem[] {
  if (!Array.isArray(value)) return [];
  const maximumDuration = Math.max(1, Math.min(600, Number(duration) || 600));
  return value.slice(0, 240).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = shortText(record.text, 180);
    const start = Math.max(0, Math.min(maximumDuration, Number(record.start) || 0));
    const end = Math.min(maximumDuration, Math.max(start + 0.04, Number(record.end) || start + 0.5));
    if (!text || start >= maximumDuration || end <= start) return [];
    const translation = shortText(record.translation, 240);
    const node = CONTENT_NODES.has(record.contentNode as ViralCaptionPlanItem["contentNode"])
      ? record.contentNode as ViralCaptionPlanItem["contentNode"]
      : undefined;
    const origin = ["ai", "local", "none"].includes(String(record.keywordOrigin))
      ? record.keywordOrigin as ViralCaptionPlanItem["keywordOrigin"]
      : undefined;
    const contentWeight = Number.isFinite(Number(record.contentWeight))
      ? Math.max(0, Math.min(1, Number(record.contentWeight)))
      : 0.5;
    const keyword = sanitizeViralKeyword(text, shortText(record.keyword, 16), node, contentWeight);
    const compactText = text.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:]/g, "");
    const captionLines = Array.isArray(record.captionLines)
      ? record.captionLines
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:]/g, "").trim())
        .filter(Boolean)
        .slice(0, 2)
      : [];
    const validCaptionLines = captionLines.length > 0 && captionLines.join("") === compactText
      ? captionLines
      : [];
    return [{
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text,
      ...(keyword ? { keyword } : {}),
      ...(translation ? { translation } : {}),
      ...(node ? { contentNode: node } : {}),
      ...(Number.isFinite(Number(record.contentWeight)) ? { contentWeight } : {}),
      ...(origin ? { keywordOrigin: origin } : {}),
      ...(typeof record.keywordSfx === "boolean" ? { keywordSfx: record.keywordSfx } : {}),
      ...(record.keywordImportance === "primary" || record.keywordImportance === "regular"
        ? { keywordImportance: record.keywordImportance as ViralCaptionPlanItem["keywordImportance"] }
        : {}),
      ...(validCaptionLines.length ? {
        captionLineMode: validCaptionLines.length === 2 ? "two-line" as const : "single" as const,
        captionLines: validCaptionLines,
      } : {}),
      ...(CAMERA_INTENTS.has(record.cameraIntent as ViralCaptionPlanItem["cameraIntent"])
        ? { cameraIntent: record.cameraIntent as ViralCaptionPlanItem["cameraIntent"] }
        : {}),
      ...(TRANSITION_INTENTS.has(record.transitionIntent as ViralCaptionPlanItem["transitionIntent"])
        ? { transitionIntent: record.transitionIntent as ViralCaptionPlanItem["transitionIntent"] }
        : {}),
      ...(SFX_ROLES.has(record.sfxRole as ViralCaptionPlanItem["sfxRole"])
        ? { sfxRole: record.sfxRole as ViralCaptionPlanItem["sfxRole"] }
        : {}),
    }];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
}

export function sanitizeViralWorkflowManifest(value: unknown): ViralWorkflowManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "lip-sync-viral") return null;
  const duration = Math.max(1, Math.min(600, Number(record.duration) || 600));
  const captions = sanitizeViralCaptionPlan(record.captions, duration);
  if (!captions.length) return null;
  return {
    version: 1,
    kind: "lip-sync-viral",
    script: shortText(record.script, 12_000),
    title: shortText(record.title, 40),
    duration,
    captions,
    bgmMood: ["calm", "warm", "professional", "uplifting", "neutral"].includes(String(record.bgmMood))
      ? record.bgmMood as ViralBgmMood
      : "professional",
    planReady: Boolean(record.planReady)
      && captions.every((caption) => Boolean(caption.contentNode && caption.keywordOrigin)),
    plannedAt: Math.max(0, Number(record.plannedAt) || Date.now()),
  };
}

export function buildViralDirectorPlan(input: {
  templateId: string;
  title: string;
  titleLines?: unknown;
  duration: number;
  captions: unknown;
  bgmMood?: ViralDirectorPlan["bgmMood"];
  source?: ViralDirectorPlan["source"];
  model?: string;
  degraded?: boolean;
  plannedAt?: number;
}): ViralDirectorPlan {
  const duration = Math.max(1, Math.min(600, Number(input.duration) || 600));
  const captions = sanitizeViralCaptionPlan(input.captions, duration);
  const title = shortText(input.title, 40);
  const titleLines = Array.isArray(input.titleLines)
    ? input.titleLines.filter((line): line is string => typeof line === "string").map((line) => line.trim()).filter(Boolean).slice(0, 2)
    : [];
  const bgmMood = ["calm", "warm", "professional", "uplifting", "neutral"].includes(String(input.bgmMood))
    ? input.bgmMood as ViralDirectorPlan["bgmMood"]
    : "professional";
  return {
    version: VIRAL_DIRECTOR_PLAN_VERSION,
    kind: "viral-director-plan",
    promptVersion: VIRAL_DIRECTOR_PROMPT_VERSION,
    templateId: shortText(input.templateId, 64) || "template-9",
    title,
    titleLines: titleLines.length ? titleLines : title.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2),
    duration,
    captions,
    bgmMood,
    source: input.source || "local-fallback",
    model: shortText(input.model, 80) || "local-director",
    degraded: Boolean(input.degraded),
    plannedAt: Math.max(0, Number(input.plannedAt) || Date.now()),
  };
}

export function sanitizeViralDirectorPlan(value: unknown): ViralDirectorPlan | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "viral-director-plan") return null;
  const plan = buildViralDirectorPlan({
    templateId: shortText(record.templateId, 64),
    title: shortText(record.title, 40),
    titleLines: record.titleLines,
    duration: Number(record.duration) || 600,
    captions: record.captions,
    bgmMood: record.bgmMood as ViralDirectorPlan["bgmMood"],
    source: ["ai", "cache", "local-fallback", "user-confirmed"].includes(String(record.source))
      ? record.source as ViralDirectorPlan["source"]
      : "local-fallback",
    model: shortText(record.model, 80),
    degraded: Boolean(record.degraded),
    plannedAt: Number(record.plannedAt) || Date.now(),
  });
  if (!plan.captions.length) return null;
  return plan;
}
