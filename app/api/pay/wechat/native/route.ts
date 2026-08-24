import { toDataURL } from "qrcode";
import { getMemberSession } from "../../../../member-session";
import { createNativeRecharge, wechatPayErrorResponse } from "../../../../../lib/server/wechat-pay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const input = await request.json().catch(() => null) as { packageId?: unknown; amountYuan?: unknown } | null;
    const packageId = typeof input?.packageId === "string" ? input.packageId.trim() : "";
    const amountYuan = Number(input?.amountYuan);
    if (!packageId && !Number.isFinite(amountYuan)) {
      return Response.json({ error: "请选择充值套餐或填写充值金额。" }, { status: 400 });
    }
    const order = await createNativeRecharge(member, packageId ? { packageId } : { amountYuan });
    const qrDataUrl = await toDataURL(order.codeUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 360,
      color: { dark: "#071a13", light: "#ffffff" },
    });
    return Response.json({ order: { ...order, codeUrl: undefined, qrDataUrl } });
  } catch (error) {
    return wechatPayErrorResponse(error) ?? Response.json({ error: "微信支付订单创建失败，请稍后重试。" }, { status: 500 });
  }
}
