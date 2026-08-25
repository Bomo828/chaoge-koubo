import { getMemberSession } from "../../../member-session";
import { aiErrorResponse } from "../../../../lib/lk888";
import { pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPoints } from "../../../../lib/points";
import { billablePointsFromCost } from "../../../../lib/billing";
import { pointCost } from "../../../../lib/server/platform-settings";
import { createExplainerDirectorPlan, estimateExplainerDirectorUnits, normalizeExplainerInput } from "../../../../lib/server/ai-explainer";

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ ok: false, error: "请先登录会员账号。" }, { status: 401 });
  const url = new URL(request.url);
  const duration = Math.max(1, Math.min(3600, Number(url.searchParams.get("duration")) || 30));
  const materials = Math.max(1, Math.min(30, Math.floor(Number(url.searchParams.get("materials")) || 1)));
  const references = Math.max(1, Math.min(20, Math.floor(Number(url.searchParams.get("references")) || materials + 1)));
  const contentReady = url.searchParams.get("content_ready") === "1";
  const estimatedTranscriptLength = Math.ceil(duration * 5.2);
  const contentUnits = contentReady ? 0 : Math.max(1, Math.ceil((2400 + estimatedTranscriptLength / 2 + materials * 90 + references * 450) / 1000));
  const directorUnits = Math.max(1, Math.ceil((2800 + estimatedTranscriptLength / 2 + materials * 150 + references * 450) / 1000));
  const unitPoints = billablePointsFromCost(pointCost("prompt_optimize", 2));
  return Response.json({
    ok: true,
    estimatedPoints: (contentUnits + directorUnits) * unitPoints,
    contentPoints: contentUnits * unitPoints,
    directorPoints: directorUnits * unitPoints,
    settlement: "actual_usage",
  });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ ok: false, error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let completed = false;
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = normalizeExplainerInput(body);
    const contentBrief = body.content_brief && typeof body.content_brief === "object" && !Array.isArray(body.content_brief)
      ? body.content_brief as Record<string, unknown>
      : {};
    const tokenUnits = estimateExplainerDirectorUnits(input, contentBrief);
    reservation = await reserveAiPoints(member, "prompt_optimize", tokenUnits, body.request_id);
    const { plan, usage } = await createExplainerDirectorPlan(input, contentBrief);
    const actualUnits = usage.totalTokens > 0 ? Math.max(1, Math.ceil(usage.totalTokens / 1000)) : tokenUnits;
    const wallet = await settleAiPoints(reservation, actualUnits);
    completed = true;
    return Response.json({ ok: true, model: "gpt-5.5", plan, usage, wallet });
  } catch (error) {
    if (reservation && !completed) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}
