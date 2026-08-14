import { getMemberSession } from "../../../../../member-session";
import { deleteMarketAccount, queueMarketAccountSync } from "../../../../../../lib/server/market-monitor";

export async function PATCH(_: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const { id } = await context.params;
  const account = queueMarketAccountSync(member.id, id);
  if (!account) return Response.json({ error: "没有找到这个监控账号。" }, { status: 404 });
  return Response.json({
    item: {
      id: account.id,
      status: account.status,
      statusMessage: account.status_message,
      nextSyncAt: account.next_sync_at ? Number(account.next_sync_at) * 1000 : null,
    },
  });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const { id } = await context.params;
  if (!deleteMarketAccount(member.id, id)) {
    return Response.json({ error: "没有找到这个监控账号。" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
