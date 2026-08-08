import { getMemberSession } from "../../../../member-session";
import { getAiTask } from "../../../../../lib/server/ai-tasks";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const { id } = await context.params;
  const task = getAiTask(member, id);
  return task ? Response.json({ task }) : Response.json({ error: "任务不存在。" }, { status: 404 });
}
