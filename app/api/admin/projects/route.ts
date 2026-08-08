import { getMemberSession } from "../../../member-session";
import { createProject, listProjects } from "../../../../lib/server/admin-data";
import { isAdmin } from "../../../../lib/server/auth";

export const runtime = "nodejs";

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  return Response.json({ items: listProjects() });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(input?.name || "").trim();
  if (!name) return Response.json({ error: "请填写项目名称。" }, { status: 400 });
  const item = createProject(member.id, {
    name,
    type: String(input?.type || "image"),
    status: String(input?.status || "draft"),
    coverUrl: String(input?.coverUrl || ""),
    config: typeof input?.config === "object" && input.config ? input.config as Record<string, unknown> : {},
  });
  return Response.json({ item }, { status: 201 });
}
