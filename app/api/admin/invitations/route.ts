import { getMemberSession } from "../../../member-session";
import { isAdmin } from "../../../../lib/server/auth";
import { createInvitations, listInvitations } from "../../../../lib/server/invitations";

export const runtime = "nodejs";

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  return Response.json({ items: listInvitations() });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return Response.json({ error: "缺少邀请码设置。" }, { status: 400 });
  try {
    const result = createInvitations(member.id, {
      count: Number(input.count),
      maxUses: Number(input.maxUses),
      validityDays: Number(input.validityDays),
      giftPoints: Number(input.giftPoints),
      memberLevel: String(input.memberLevel || "basic"),
      note: String(input.note || ""),
    });
    return Response.json(result, { status: 201 });
  } catch {
    return Response.json({ error: "邀请码生成失败，请稍后重试。" }, { status: 500 });
  }
}
