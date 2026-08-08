import { getMemberSession } from "../../../../member-session";
import { updateUserByAdmin } from "../../../../../lib/server/admin-data";
import { isAdmin } from "../../../../../lib/server/auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const { id } = await context.params;
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return Response.json({ error: "缺少更新内容。" }, { status: 400 });
  if (id === member.id && (input.status === "disabled" || input.role === "member")) {
    return Response.json({ error: "不能停用当前管理员或移除自己的管理权限。" }, { status: 400 });
  }
  const username = input.username === undefined ? undefined : String(input.username).trim();
  const displayName = input.displayName === undefined ? undefined : String(input.displayName).trim();
  const password = input.password === undefined ? undefined : String(input.password);
  if (username !== undefined && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return Response.json({ error: "登录账号需为 3–32 位字母、数字、点、下划线或短横线。" }, { status: 400 });
  }
  if (displayName !== undefined && (!displayName || displayName.length > 40)) {
    return Response.json({ error: "请填写不超过 40 个字符的会员名称。" }, { status: 400 });
  }
  if (password !== undefined && password !== "" && (password.length < 8 || password.length > 72)) {
    return Response.json({ error: "新密码需为 8–72 个字符。" }, { status: 400 });
  }
  try {
    const item = updateUserByAdmin(member.id, id, {
    username,
    displayName,
    password: password || undefined,
    role: input.role === undefined ? undefined : String(input.role),
    level: input.level === undefined ? undefined : String(input.level),
    status: input.status === undefined ? undefined : String(input.status),
    pointDelta: input.pointDelta === undefined ? undefined : Number(input.pointDelta),
  });
    return item ? Response.json({ item }) : Response.json({ error: "会员不存在。" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error && error.message.includes("UNIQUE")
      ? "这个登录账号已经存在，请更换。"
      : "会员资料保存失败。";
    return Response.json({ error: message }, { status: 409 });
  }
}
