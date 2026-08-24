import { getMemberSession } from "../../../../member-session";
import { billablePointsFromCost } from "../../../../../lib/billing";
import { pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPointsByRequest } from "../../../../../lib/points";
import { createMarketAccount, findMarketAccount, listMarketAccounts, listMarketVideos, resolveDouyinProfileUrl, syncMarketAccountProfile } from "../../../../../lib/server/market-monitor";
import { pointCost } from "../../../../../lib/server/platform-settings";

const MARKET_ACCOUNT_COST = 10;

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
  const costPoints = pointCost("market_account_add", MARKET_ACCOUNT_COST);
  return Response.json({
    items: listMarketAccounts(member.id).map(accountJson),
    pricing: { addAccountPoints: costPoints > 0 ? billablePointsFromCost(costPoints) : 0 },
  });
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let completed = false;
  try {
    const body = await request.json() as { sourceUrl?: unknown; requestId?: unknown };
    if (typeof body.sourceUrl !== "string") {
      return Response.json({ error: "请输入抖音账号主页链接。" }, { status: 400 });
    }
    const resolved = await resolveDouyinProfileUrl(body.sourceUrl);
    const existing = findMarketAccount(member.id, resolved.secUid);
    if (existing) {
      return Response.json({ item: accountJson(existing), chargedPoints: 0, duplicate: true });
    }

    const costPoints = pointCost("market_account_add", MARKET_ACCOUNT_COST);
    if (costPoints > 0) {
      reservation = await reserveAiPoints(member, "market_account_add", 1, body.requestId, costPoints);
    }
    const account = createMarketAccount(member.id, resolved.sourceUrl, resolved.secUid);
    const synced = await syncMarketAccountProfile(member.id, account.id);
    const finalAccount = synced || account;
    if (reservation) {
      if (finalAccount.status === "error") {
        await refundAiPoints(reservation);
        reservation = null;
      } else {
        await settleAiPointsByRequest(member, reservation.requestId, costPoints);
        completed = true;
      }
    }
    return Response.json({
      item: accountJson(finalAccount),
      chargedPoints: completed ? billablePointsFromCost(costPoints) : 0,
      refunded: finalAccount.status === "error",
    }, { status: 201 });
  } catch (error) {
    if (reservation && !completed) await refundAiPoints(reservation).catch(() => undefined);
    const pointsResponse = pointsErrorResponse(error);
    if (pointsResponse) return pointsResponse;
    return Response.json({ error: error instanceof Error ? error.message : "账号添加失败。" }, { status: 400 });
  }
}
