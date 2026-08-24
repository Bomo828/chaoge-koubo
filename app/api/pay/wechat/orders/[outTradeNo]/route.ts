import { getMemberSession } from "../../../../../member-session";
import { refreshRechargeOrder, wechatPayErrorResponse } from "../../../../../../lib/server/wechat-pay";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ outTradeNo: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const { outTradeNo } = await context.params;
    return Response.json({ order: await refreshRechargeOrder(member, outTradeNo) });
  } catch (error) {
    return wechatPayErrorResponse(error) ?? Response.json({ error: "充值状态读取失败，请稍后重试。" }, { status: 500 });
  }
}
