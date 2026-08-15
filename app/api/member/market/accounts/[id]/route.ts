import { getMemberSession } from "../../../../../member-session";
import { deleteMarketAccount, listMarketVideos, syncMarketAccount } from "../../../../../../lib/server/market-monitor";

export async function PATCH(_: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const { id } = await context.params;
  const account = await syncMarketAccount(member.id, id);
  if (!account) return Response.json({ error: "没有找到这个监控账号。" }, { status: 404 });
  return Response.json({
    item: {
      id: account.id,
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
      videos: listMarketVideos(account.id).map((video) => ({
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
      })),
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
