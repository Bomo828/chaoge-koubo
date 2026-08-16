import { getMemberSession } from "../../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../../lib/lk888";
import { ownsAgentTask } from "../../../../../lib/server/agent-conversations";

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const taskId = new URL(request.url).searchParams.get("task_id")?.trim() || "";
  if (!/^\d{1,30}$/.test(taskId) || !ownsAgentTask(member.id, taskId)) {
    return Response.json({ error: "没有权限查看这个生成任务。" }, { status: 403 });
  }
  try {
    const result = await lk888Fetch<Record<string, unknown>>(`/v1/skills/task-status?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
    return Response.json(result);
  } catch (error) {
    return aiErrorResponse(error);
  }
}
