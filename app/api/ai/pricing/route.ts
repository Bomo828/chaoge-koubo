import { getMemberSession } from "../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { quoteGptImage2 } from "../../../../lib/ai-pricing";
import { billablePointsFromCost } from "../../../../lib/billing";

type BalanceResponse = {
  balance?: number;
  unit?: string;
  api_key_quota?: { limit?: number | null; used?: number };
};

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    const url = new URL(request.url);
    const quote = await quoteGptImage2({
      size: url.searchParams.get("size") || "auto",
      quality: url.searchParams.get("quality") || "auto",
      count: Number(url.searchParams.get("count") || 1),
      referenceCount: Number(url.searchParams.get("references") || 0),
    });
    const balance = await lk888Fetch<BalanceResponse>("/v1/skills/balance", { cache: "no-store" });
    return Response.json({ quote: { ...quote, estimatedPoints: billablePointsFromCost(quote.estimatedPoints) }, providerBalance: balance });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
