export type ViralCaptionPlanItem = {
  start: number;
  end: number;
  text: string;
  keyword?: string;
  translation?: string;
  contentNode?: "hook" | "pain_reversal" | "core_viewpoint" | "number_benefit" | "example_step" | "brand_entity" | "cta" | "supporting";
  contentWeight?: number;
  keywordOrigin?: "ai" | "local" | "none";
};

export type ViralWorkflowManifest = {
  version: 1;
  kind: "lip-sync-viral";
  script: string;
  title: string;
  duration: number;
  captions: ViralCaptionPlanItem[];
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
    const keyword = shortText(record.keyword, 16);
    const translation = shortText(record.translation, 240);
    const node = CONTENT_NODES.has(record.contentNode as ViralCaptionPlanItem["contentNode"])
      ? record.contentNode as ViralCaptionPlanItem["contentNode"]
      : undefined;
    const origin = ["ai", "local", "none"].includes(String(record.keywordOrigin))
      ? record.keywordOrigin as ViralCaptionPlanItem["keywordOrigin"]
      : undefined;
    return [{
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text,
      ...(keyword && text.replace(/\s+/g, "").includes(keyword.replace(/\s+/g, "")) ? { keyword } : {}),
      ...(translation ? { translation } : {}),
      ...(node ? { contentNode: node } : {}),
      ...(Number.isFinite(Number(record.contentWeight)) ? { contentWeight: Math.max(0, Math.min(1, Number(record.contentWeight))) } : {}),
      ...(origin ? { keywordOrigin: origin } : {}),
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
    planReady: Boolean(record.planReady)
      && captions.every((caption) => Boolean(caption.contentNode && caption.keywordOrigin && caption.translation)),
    plannedAt: Math.max(0, Number(record.plannedAt) || Date.now()),
  };
}
