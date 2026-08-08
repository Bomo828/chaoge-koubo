import { getMemberSession } from "../../../member-session";
import { createTemplate, listTemplates } from "../../../../lib/server/admin-data";
import { isAdmin } from "../../../../lib/server/auth";

export const runtime = "nodejs";

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  return Response.json({ items: listTemplates({ includeDrafts: true }) });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(input?.name || "").trim();
  const slug = String(input?.slug || "").trim();
  if (!name) return Response.json({ error: "请填写模板名称。" }, { status: 400 });
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) {
    return Response.json({ error: "模板标识只能使用小写字母、数字和短横线。" }, { status: 400 });
  }
  const category = String(input?.category || "viral_video");
  const config = typeof input?.config === "object" && input.config ? input.config as Record<string, unknown> : {};
  if (category === "viral_video" && input?.status !== "draft" && config.validationStatus !== "published-ready") {
    return Response.json({ error: "新网感模板必须先完成短、长两条原片回归测试，才能正式上架。" }, { status: 400 });
  }
  try {
    const item = createTemplate(member.id, {
      name,
      slug,
      category,
      version: Number(input?.version || 1),
      status: input?.status === "draft" ? "draft" : "published",
      previewUrl: String(input?.previewUrl || ""),
      coverUrl: String(input?.coverUrl || ""),
      description: String(input?.description || ""),
      config,
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error && error.message.includes("UNIQUE")
      ? "模板标识已存在，请更换。"
      : "模板创建失败。";
    return Response.json({ error: message }, { status: 409 });
  }
}
