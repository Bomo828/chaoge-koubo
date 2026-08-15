import { getMemberSession } from "../../../../member-session";
import { createMarketAccount, listMarketAccounts, listMarketVideos, resolveDouyinProfileUrl, syncMarketAccount } from "../../../../../lib/server/market-monitor";

function videoJson(video: ReturnType<typeof listMarketVideos>[number]) {
  return {
    id: video.id,
    awemeId: video.aweme_id,
    sourceUrl: video.source_url,
    title: video.title,
    coverUrl: video.cover_url,
    durationSeconds: video.duration_seconds,
    publishedAt: video.published_at ? Number(video.published_at) * 1000 : null,
    playCount: video.play_count === null ? null : Number(video.play_count),
    likeCount: Number(video.like_count || 0),
    commentCount: Number(video.comment_count || 0),
    shareCount: Number(video.share_count || 0),
    collectCount: Number(video.collect_count || 0),
    growth: Number(video.growth || 0),
  };
}

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
    videos: listMarketVideos(account.id).map(videoJson),
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
    const resolved = await resolveDouyinProfileUrl(body.sourceUrl);
    const account = createMarketAccount(member.id, resolved.sourceUrl, resolved.secUid);
    const synced = await syncMarketAccount(member.id, account.id);
    return Response.json({ item: accountJson(synced || account) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "账号添加失败。" }, { status: 400 });
  }
}
