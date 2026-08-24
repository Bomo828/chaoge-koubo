import { getMemberSession } from "../../../member-session";
import { getWallet, pointsErrorResponse, topUpDemoPoints } from "../../../../lib/points";
import { getPlatformSettings, rechargeBasePoints, rechargeTotalPoints } from "../../../../lib/server/platform-settings";
import {
  CUSTOM_RECHARGE_MAX_YUAN,
  CUSTOM_RECHARGE_MIN_YUAN,
  isWechatPayConfigured,
  wechatPayMissingConfig,
} from "../../../../lib/server/wechat-pay";

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const platform = getPlatformSettings();
    return Response.json({
      wallet: await getWallet(member),
      rechargePackages: platform.rechargePackages.filter((item) => item.enabled).map((item) => ({
        ...item,
        points: rechargeBasePoints(platform, item),
        totalPoints: rechargeTotalPoints(platform, item),
      })),
      rechargePointsPerYuan: platform.rechargePointsPerYuan,
      customRecharge: {
        enabled: platform.paymentMode === "wechat",
        minYuan: CUSTOM_RECHARGE_MIN_YUAN,
        maxYuan: CUSTOM_RECHARGE_MAX_YUAN,
      },
      paymentMode: platform.paymentMode,
      paymentAvailable: platform.paymentMode === "wechat" && isWechatPayConfigured(),
      paymentMessage: platform.paymentMode === "wechat" && !isWechatPayConfigured()
        ? `微信支付尚缺少服务器配置：${wechatPayMissingConfig().join("、")}`
        : "",
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
