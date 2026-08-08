import { getMemberSession } from "../../../member-session";
import { changeUserPassword } from "../../../../lib/server/auth";

export async function PUT(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const body = await request.json() as { currentPassword?: unknown; nextPassword?: unknown };
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const nextPassword = typeof body.nextPassword === "string" ? body.nextPassword : "";
    if (nextPassword.length < 8) return Response.json({ error: "新密码至少需要 8 个字符。" }, { status: 400 });
    if (nextPassword === currentPassword) return Response.json({ error: "新密码不能与当前密码相同。" }, { status: 400 });
    if (!changeUserPassword(member.id, currentPassword, nextPassword)) {
      return Response.json({ error: "当前密码不正确。" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "密码修改失败，请稍后重试。" }, { status: 400 });
  }
}
