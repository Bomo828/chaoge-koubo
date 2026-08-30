import { getMemberSession } from "../../../member-session";
import { repairEnglishWordFragments, segmentViralCaptions } from "../../../../lib/viral-caption-segmentation";
import { planViralCaptionDirector } from "../../../../lib/server/viral-caption-director";
import type { ViralCaptionPlanItem } from "../../../../lib/viral-workflow";

function normalizeSourceCaptions(value: unknown, duration: number): ViralCaptionPlanItem[] {
  if (!Array.isArray(value)) return [];
  const captions = value
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const start = Math.max(0, Math.min(duration, Number(record.start) || 0));
      const end = Math.max(start + 0.05, Math.min(duration, Number(record.end) || start + 0.5));
      const text = typeof record.text === "string" ? record.text.trim().slice(0, 500) : "";
      const words = Array.isArray(record.words)
        ? record.words.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const word = item as Record<string, unknown>;
          const wordText = typeof word.text === "string" ? word.text.trim().slice(0, 80) : "";
          const wordStart = Math.max(start, Math.min(end, Number(word.start) || start));
          const wordEnd = Math.max(wordStart + 0.01, Math.min(end, Number(word.end) || wordStart + 0.04));
          return wordText ? [{ start: wordStart, end: wordEnd, text: wordText }] : [];
        })
        : [];
      return { start, end, text, ...(words.length ? { words } : {}) };
    })
    .filter((item) => item.text && item.end > item.start)
    .sort((left, right) => left.start - right.start)
    .slice(0, 160);
  return repairEnglishWordFragments(captions);
}

/**
 * ASR has already supplied text and timing before this route is called. The
 * same unified content director used by the retry button now handles title,
 * correction, semantic caption groups, highlights and primary keywords.
 */
export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const duration = Math.max(1, Math.min(600, Number(body.duration) || 60));
  const source = normalizeSourceCaptions(body.captions, duration);
  if (!source.length) {
    return Response.json({ error: "没有读取到视频中的原始口播，请确认视频带有清晰人声。" }, { status: 400 });
  }
  const lockedCaptions = segmentViralCaptions(source);
  try {
    const result = await planViralCaptionDirector({
      captions: lockedCaptions,
      duration,
      script: lockedCaptions.map((caption) => caption.text).join("。"),
      templateId: typeof body.templateId === "string" ? body.templateId : "template-9",
    });
    const planReady = "planReady" in result && Boolean(result.planReady);
    return Response.json({
      ...result,
      summary: planReady
        ? "AI内容导演已完成标题、语义分段、模板排版、提亮词与重点词规划。"
        : "已保留真实语音时间轴，并完成模板安全分段；AI内容导演未完成，可直接重新规划。",
      timelineRole: "asr-timing-only",
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "AI内容导演暂时不可用，请稍后重试。",
    }, { status: 400 });
  }
}
