import { getMemberSession } from "../../../../member-session";
import { createMarketAccount, listMarketAccounts } from "../../../../../lib/server/market-monitor";

function accountJson(account: ReturnType<typeof listMarketAccounts>[number]) {
  return {
    id: account.id,
    platform: account.platform,
    sourceUrl: account.source_url,
    secUid: account.sec_uid,
    nickname: account.nickname,
    handle: account.handle,
    avatarUrl: account.avatar_url,
    signature: account.signature,
    status: account.status,
    statusMessage: account.status_message,
    followerCount: Number(account.follower_count),
    followingCount: Number(account.following_count),
    totalLikes: Number(account.total_likes),
    videoCount: Number(account.video_count),
    lastSyncAt: account.last_sync_at ? Number(account.last_sync_at) * 1000 : null,
    nextSyncAt: account.next_sync_at ? Number(account.next_sync_at) * 1000 : null,
    createdAt: Number(account.created_at) * 1000,
  };
}

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  return Response.json({ items: listMarketAccounts(member.id).map(accountJson) });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const body = await request.json() as { sourceUrl?: unknown };
    if (typeof body.sourceUrl !== "string") {
      return Response.json({ error: "请输入抖音账号主页链接。" }, { status: 400 });
    }
    return Response.json({ item: accountJson(createMarketAccount(member.id, body.sourceUrl)) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "账号添加失败。" }, { status: 400 });
  }
}
