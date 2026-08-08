import { getMemberSession } from "../../../member-session";
import { getMerchantProfile, saveMerchantProfile } from "../../../../lib/server/merchants";

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  return Response.json({ merchant: getMerchantProfile(member) });
}

export async function PUT(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    return Response.json({ merchant: saveMerchantProfile(member, body) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "商家资料保存失败。" }, { status: 400 });
  }
}
