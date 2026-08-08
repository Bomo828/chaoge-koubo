import { getMemberSession } from "../../../../member-session";
import { deleteProject, updateProject } from "../../../../../lib/server/admin-data";
import { isAdmin } from "../../../../../lib/server/auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const { id } = await context.params;
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return Response.json({ error: "缺少更新内容。" }, { status: 400 });
  const item = updateProject(id, {
    name: input.name === undefined ? undefined : String(input.name),
    type: input.type === undefined ? undefined : String(input.type),
    status: input.status === undefined ? undefined : String(input.status),
    coverUrl: input.coverUrl === undefined ? undefined : String(input.coverUrl),
    config: typeof input.config === "object" && input.config ? input.config as Record<string, unknown> : undefined,
  });
  return item ? Response.json({ item }) : Response.json({ error: "项目不存在。" }, { status: 404 });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const { id } = await context.params;
  return deleteProject(id)
    ? Response.json({ ok: true })
    : Response.json({ error: "项目不存在。" }, { status: 404 });
}
