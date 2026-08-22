import { getMemberSession } from "../../../member-session";
import { aiErrorResponse } from "../../../../lib/lk888";
import { pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPoints } from "../../../../lib/points";
import { createExplainerContentBrief, normalizeExplainerInput } from "../../../../lib/server/ai-explainer";

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ ok: false, error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let completed = false;
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = normalizeExplainerInput(body);
    const estimatedTokens = 2400 + Math.ceil(JSON.stringify(body).length / 2) + input.references.length * 450;
    const tokenUnits = Math.max(1, Math.ceil(estimatedTokens / 1000));
    reservation = await reserveAiPoints(member, "prompt_optimize", tokenUnits, body.request_id);
    const { brief, usage } = await createExplainerContentBrief(input);
    const actualUnits = usage.totalTokens > 0 ? Math.max(1, Math.ceil(usage.totalTokens / 1000)) : tokenUnits;
    const wallet = await settleAiPoints(reservation, actualUnits);
    completed = true;
    return Response.json({ ok: true, model: "gpt-5.5", brief, usage, wallet });
  } catch (error) {
    if (reservation && !completed) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}
