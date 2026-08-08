import { getMemberSession } from "../../../member-session";
import { listAiTasks } from "../../../../lib/server/ai-tasks";

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const limit = Number(new URL(request.url).searchParams.get("limit") || 100);
  return Response.json({ tasks: listAiTasks(member, limit) });
}
