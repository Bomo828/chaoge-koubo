import { getMemberSession } from "../../../../member-session";
import { isAdmin } from "../../../../../lib/server/auth";
import { setInvitationStatus } from "../../../../../lib/server/invitations";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || (input.status !== "active" && input.status !== "disabled")) {
    return Response.json({ error: "邀请码状态不正确。" }, { status: 400 });
  }
  const { id } = await context.params;
  const item = setInvitationStatus(id, String(input.status));
  return item ? Response.json({ item }) : Response.json({ error: "邀请码不存在。" }, { status: 404 });
}
