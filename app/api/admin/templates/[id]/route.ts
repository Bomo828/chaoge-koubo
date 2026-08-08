import { getMemberSession } from "../../../../member-session";
import { deleteTemplate, getTemplate, updateTemplate } from "../../../../../lib/server/admin-data";
import { isAdmin } from "../../../../../lib/server/auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const { id } = await context.params;
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return Response.json({ error: "缺少更新内容。" }, { status: 400 });
  const current = getTemplate(id);
  if (!current) return Response.json({ error: "模板不存在。" }, { status: 404 });
  const nextCategory = input.category === undefined ? current.category : String(input.category);
  const nextStatus = input.status === undefined ? current.status : String(input.status);
  const nextConfig = typeof input.config === "object" && input.config ? input.config as Record<string, unknown> : current.config;
  if (current.status !== "published" && nextCategory === "viral_video" && nextStatus === "published" && nextConfig.validationStatus !== "published-ready") {
    return Response.json({ error: "请先完成短、长两条原片回归测试，再上架网感模板。" }, { status: 400 });
  }
  try {
    const item = updateTemplate(id, {
      name: input.name === undefined ? undefined : String(input.name),
      slug: input.slug === undefined ? undefined : String(input.slug),
      category: input.category === undefined ? undefined : String(input.category),
      version: input.version === undefined ? undefined : Number(input.version),
      status: input.status === undefined ? undefined : String(input.status),
      previewUrl: input.previewUrl === undefined ? undefined : String(input.previewUrl),
      coverUrl: input.coverUrl === undefined ? undefined : String(input.coverUrl),
      description: input.description === undefined ? undefined : String(input.description),
      config: typeof input.config === "object" && input.config ? input.config as Record<string, unknown> : undefined,
    });
    return item ? Response.json({ item }) : Response.json({ error: "模板不存在。" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error && error.message.includes("UNIQUE") ? "模板标识已存在。" : "模板保存失败。";
    return Response.json({ error: message }, { status: 409 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const { id } = await context.params;
  return deleteTemplate(id)
    ? Response.json({ ok: true })
    : Response.json({ error: "模板不存在。" }, { status: 404 });
}
