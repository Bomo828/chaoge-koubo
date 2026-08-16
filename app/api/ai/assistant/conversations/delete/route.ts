import { getMemberSession } from "../../../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../../../lib/lk888";
import { forgetAgentConversation, ownsAgentConversation } from "../../../../../../lib/server/agent-conversations";

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { conversation_id?: unknown };
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
  if (!conversationId || !ownsAgentConversation(member.id, conversationId)) {
    return Response.json({ error: "没有权限删除这个对话。" }, { status: 403 });
  }
  try {
    const result = await lk888Fetch<Record<string, unknown>>("/v1/agent/conversations/delete", {
      method: "POST",
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    forgetAgentConversation(member.id, conversationId);
    return Response.json(result);
  } catch (error) {
    return aiErrorResponse(error);
  }
}
