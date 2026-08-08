import { getMemberSession } from "../../../member-session";
import { createUserByAdmin, listUsers } from "../../../../lib/server/admin-data";
import { isAdmin } from "../../../../lib/server/auth";

export const runtime = "nodejs";

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  return Response.json({ items: listUsers() });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return Response.json({ error: "缺少会员资料。" }, { status: 400 });
  const username = String(input.username || "").trim();
  const displayName = String(input.displayName || "").trim();
  const password = String(input.password || "");
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return Response.json({ error: "登录账号需为 3–32 位字母、数字、点、下划线或短横线。" }, { status: 400 });
  }
  if (!displayName || displayName.length > 40) {
    return Response.json({ error: "请填写不超过 40 个字符的会员名称。" }, { status: 400 });
  }
  if (password.length < 8 || password.length > 72) {
    return Response.json({ error: "初始密码需为 8–72 个字符。" }, { status: 400 });
  }
  try {
    const item = createUserByAdmin(member.id, {
      username,
      displayName,
      password,
      level: String(input.level || "basic"),
      points: Number(input.points || 0),
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error && error.message.includes("UNIQUE")
      ? "这个登录账号已经存在，请更换。"
      : "会员账号创建失败。";
    return Response.json({ error: message }, { status: 409 });
  }
}
