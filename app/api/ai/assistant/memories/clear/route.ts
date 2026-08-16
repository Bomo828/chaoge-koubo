import { getMemberSession } from "../../../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../../../lib/lk888";

export async function POST() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const result = await lk888Fetch<Record<string, unknown>>("/v1/agent/memories/clear", {
      method: "POST",
      body: JSON.stringify({ memory_id: member.id }),
    });
    return Response.json(result);
  } catch (error) {
    return aiErrorResponse(error);
  }
}
