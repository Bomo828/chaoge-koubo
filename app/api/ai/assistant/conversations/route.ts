import { getMemberSession } from "../../../../member-session";
import { listAgentConversations } from "../../../../../lib/server/agent-conversations";

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  return Response.json({ conversations: listAgentConversations(member.id) });
}
