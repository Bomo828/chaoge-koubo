import { getMemberSession } from "../../../../member-session";
import { getWalletHistory, pointsErrorResponse } from "../../../../../lib/points";

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    return Response.json({ history: await getWalletHistory(member) });
  } catch (error) {
    return pointsErrorResponse(error) ?? Response.json({ error: "积分记录暂时无法读取。" }, { status: 500 });
  }
}
