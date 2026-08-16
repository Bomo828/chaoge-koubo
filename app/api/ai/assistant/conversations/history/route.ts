import { getMemberSession } from "../../../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../../../lib/lk888";
import { ownsAgentConversation } from "../../../../../../lib/server/agent-conversations";

type HistoryResponse = { code?: number; msg?: string; data?: unknown };

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const conversationId = new URL(request.url).searchParams.get("conversation_id")?.trim() || "";
  if (!conversationId || !ownsAgentConversation(member.id, conversationId)) {
    return Response.json({ error: "没有权限查看这个对话。" }, { status: 403 });
  }
  try {
    const data = await lk888Fetch<HistoryResponse>(`/v1/agent/conversations/history?conversation_id=${encodeURIComponent(conversationId)}&page=1&page_size=100`, { cache: "no-store" });
    return Response.json(data);
  } catch (error) {
    return aiErrorResponse(error);
  }
}
