import { getMemberSession } from "../../../member-session";
import { getWallet, pointsErrorResponse, topUpDemoPoints } from "../../../../lib/points";
import { getPlatformSettings } from "../../../../lib/server/platform-settings";

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const platform = getPlatformSettings();
    return Response.json({
      wallet: await getWallet(member),
      rechargePackages: platform.rechargePackages.filter((item) => item.enabled).map((item) => ({ ...item, totalPoints: item.points + item.bonus })),
      paymentMode: platform.paymentMode,
    });
  } catch (error) {
    return pointsErrorResponse(error) ?? Response.json({ error: "积分账户暂时不可用。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const body = await request.json() as { amount?: unknown; requestId?: unknown };
    return Response.json({ wallet: await topUpDemoPoints(member, Number(body.amount), body.requestId) });
  } catch (error) {
    return pointsErrorResponse(error) ?? Response.json({ error: "积分充值暂时不可用。" }, { status: 500 });
  }
}
