import { createHash, randomUUID } from "node:crypto";
import { douyinSecUidFromUrl, extractDouyinUrl, isDouyinHostname } from "../douyin-links";
import { getDatabase, unixNow } from "./db";
import { getTikHubConfig } from "./ai-credentials";

export type MarketAccountRow = {
  id: string;
  owner_id: string;
  platform: string;
  source_url: string;
  sec_uid: string;
  nickname: string;
  handle: string;
  avatar_url: string;
  signature: string;
  status: "pending" | "syncing" | "ready" | "error";
  status_message: string;
  follower_count: number;
  following_count: number;
  total_likes: number;
  video_count: number;
  last_sync_at: number | null;
  next_sync_at: number | null;
  created_at: number;
  updated_at: number;
};

type MarketVideoBaseRow = {
  id: string;
  account_id: string;
  aweme_id: string;
  source_url: string;
  title: string;
  cover_url: string;
  duration_seconds: number | null;
  published_at: number | null;
  first_seen_at: number;
  updated_at: number;
};

type MetricRow = {
  play_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  collect_count: number | null;
  collected_at: number;
};

export type MarketVideoRow = MarketVideoBaseRow & MetricRow & { growth: number };

type DouyinUserInfo = Record<string, unknown>;
type DouyinAweme = Record<string, unknown>;

const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36";

function safeString(value: unknown, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nestedRecord(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ((value as Record<string, unknown>)[key] as Record<string, unknown> | undefined)
    : undefined;
}

function firstUrl(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const list = (value as Record<string, unknown>).url_list;
  if (!Array.isArray(list)) return "";
  const urls = list.filter((item): item is string => typeof item === "string" && item.length > 0);
  const browserCompatible = urls.find((url) => /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url));
  return safeString(browserCompatible || urls[0], 2000);
}

export async function resolveDouyinProfileUrl(rawUrl: string) {
  const cleaned = extractDouyinUrl(rawUrl);
  if (!cleaned) throw new Error("没有识别到抖音链接，请粘贴完整分享口令或账号主页链接。");
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("请输入完整的抖音账号主页链接。");
  }
  if (!isDouyinHostname(parsed.hostname)) throw new Error("目前仅支持 douyin.com 的公开账号主页链接。");

  let resolved = parsed;
  if (parsed.hostname.toLowerCase().startsWith("v.")) {
    const response = await fetch(parsed, {
      redirect: "follow",
      headers: { "User-Agent": MOBILE_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    resolved = new URL(response.url);
    await response.body?.cancel().catch(() => undefined);
    if (!isDouyinHostname(resolved.hostname)) throw new Error("抖音短链跳转到了非抖音地址。");
  }

  const secUid = douyinSecUidFromUrl(resolved.toString());
  if (!secUid) throw new Error("这个链接不是抖音账号主页，请复制账号主页右上角的分享链接。");
  return { sourceUrl: `https://www.douyin.com/user/${secUid}`, secUid };
}

function expireStaleSyncs(ownerId: string) {
  const now = unixNow();
  getDatabase().prepare(`
    UPDATE monitored_accounts
    SET status = 'error', status_message = '上次同步任务超时，请重新点击同步', updated_at = ?
    WHERE owner_id = ? AND status = 'syncing' AND updated_at < ?
  `).run(now, ownerId, now - 3 * 60);
}

export function listMarketAccounts(ownerId: string) {
  expireStaleSyncs(ownerId);
  return getDatabase().prepare(`
    SELECT * FROM monitored_accounts
    WHERE owner_id = ?
    ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'syncing' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      updated_at DESC
  `).all(ownerId) as MarketAccountRow[];
}

export function listMarketVideos(accountId: string) {
  const db = getDatabase();
  const videos = db.prepare(`
    SELECT * FROM monitored_videos WHERE account_id = ?
    ORDER BY published_at DESC LIMIT 36
  `).all(accountId) as MarketVideoBaseRow[];
  return videos.map((video) => {
    const metrics = db.prepare(`
      SELECT play_count, like_count, comment_count, share_count, collect_count, collected_at
      FROM video_metric_snapshots WHERE video_id = ? ORDER BY collected_at DESC LIMIT 2
    `).all(video.id) as MetricRow[];
    const latest = metrics[0] || { play_count: null, like_count: null, comment_count: null, share_count: null, collect_count: null, collected_at: video.updated_at };
    const previous = metrics[1];
    const engagement = safeNumber(latest.like_count) + safeNumber(latest.comment_count) + safeNumber(latest.share_count) + safeNumber(latest.collect_count);
    const previousEngagement = previous
      ? safeNumber(previous.like_count) + safeNumber(previous.comment_count) + safeNumber(previous.share_count) + safeNumber(previous.collect_count)
      : 0;
    const growth = previousEngagement > 0 ? Math.max(-100, Math.round(((engagement - previousEngagement) / previousEngagement) * 100)) : 0;
    return { ...video, ...latest, growth } satisfies MarketVideoRow;
  });
}

export function createMarketAccount(ownerId: string, sourceUrl: string, secUid: string) {
  const db = getDatabase();
  const existing = db.prepare(`
    SELECT * FROM monitored_accounts WHERE owner_id = ? AND sec_uid = ? LIMIT 1
  `).get(ownerId, secUid) as MarketAccountRow | undefined;
  if (existing) return existing;

  const now = unixNow();
  const id = `market_${randomUUID()}`;
  db.prepare(`
    INSERT INTO monitored_accounts (
      id, owner_id, platform, source_url, sec_uid, nickname, handle, avatar_url,
      signature, status, status_message, follower_count, following_count,
      total_likes, video_count, last_sync_at, next_sync_at, created_at, updated_at
    ) VALUES (?, ?, 'douyin', ?, ?, '正在读取账号', '抖音公开主页', '', '', 'pending',
      '准备读取公开账号资料和作品', 0, 0, 0, 0, NULL, ?, ?, ?)
  `).run(id, ownerId, sourceUrl, secUid, now + 15 * 60, now, now);
  return db.prepare("SELECT * FROM monitored_accounts WHERE id = ?").get(id) as MarketAccountRow;
}

export function findMarketAccount(ownerId: string, secUid: string) {
  return getDatabase().prepare(`
    SELECT * FROM monitored_accounts WHERE owner_id = ? AND sec_uid = ? LIMIT 1
  `).get(ownerId, secUid) as MarketAccountRow | undefined;
}

export function queueMarketAccountSync(ownerId: string, accountId: string) {
  const db = getDatabase();
  const now = unixNow();
  const result = db.prepare(`
    UPDATE monitored_accounts
    SET status = 'syncing', status_message = '正在读取抖音公开账号资料和作品',
      next_sync_at = ?, updated_at = ?
    WHERE id = ? AND owner_id = ?
  `).run(now + 15 * 60, now, accountId, ownerId);
  if (!result.changes) return null;
  return db.prepare("SELECT * FROM monitored_accounts WHERE id = ?").get(accountId) as MarketAccountRow;
}

function safeServiceBaseUrl(configuredValue: string, serviceName: string) {
  const configured = configuredValue.replace(/\/$/, "");
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) {
    throw new Error(`${serviceName}地址不安全。`);
  }
  return configured;
}

function profileBaseUrl() {
  return safeServiceBaseUrl(process.env.DOUYIN_PROFILE_API_BASE_URL || "https://www.iesdouyin.com", "抖音账号资料服务");
}

async function fetchDouyinPosts(secUid: string) {
  const tikhub = getTikHubConfig();
  if (tikhub.apiKey) {
    const postsUrl = `${tikhub.baseUrl}/api/v1/douyin/app/v3/fetch_user_post_videos?sec_user_id=${encodeURIComponent(secUid)}&max_cursor=0&count=20`;
    return await fetchJson(postsUrl, {
      Authorization: `Bearer ${tikhub.apiKey}`,
      "User-Agent": DESKTOP_USER_AGENT,
      Accept: "application/json",
    }, 20_000);
  }

  const legacyCollector = process.env.DOUYIN_COLLECTOR_BASE_URL?.trim();
  if (legacyCollector) {
    const baseUrl = safeServiceBaseUrl(legacyCollector, "抖音作品采集服务");
    const postsUrl = `${baseUrl}/api/douyin/web/fetch_user_post_videos?sec_user_id=${encodeURIComponent(secUid)}&max_cursor=0&count=20`;
    return await fetchJson(postsUrl, { "User-Agent": DESKTOP_USER_AGENT, Accept: "application/json" }, 12_000);
  }

  throw new Error("市场数据服务尚未配置，请联系管理员配置 TikHub API Key。");
}

function providerErrorMessage(payload: Record<string, unknown>) {
  const detail = nestedRecord(payload, "detail");
  const code = safeNumber(detail?.code, safeNumber(payload.code, 200));
  if (code === 200 || code === 0) return "";

  const rawMessage = safeString(detail?.message_zh, 500)
    || safeString(detail?.message, 500)
    || safeString(payload.message_zh, 500)
    || safeString(payload.message, 500);
  if (code === 402 || /余额不足|insufficient balance/i.test(rawMessage)) {
    return "TikHub 付费余额不足，暂时无法读取公开作品，请联系管理员充值市场数据服务额度。";
  }
  if (code === 401 || code === 403) {
    return "TikHub 授权失败，请联系管理员检查市场数据服务密钥。";
  }
  return rawMessage ? `市场数据服务返回异常：${rawMessage}` : `市场数据服务返回异常（${code}）`;
}

function awemeListFromPayload(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  const direct = payload.aweme_list;
  if (Array.isArray(direct)) return direct;
  const firstData = nestedRecord(payload, "data");
  if (Array.isArray(firstData?.aweme_list)) return firstData.aweme_list;
  const secondData = firstData ? nestedRecord(firstData, "data") : undefined;
  if (Array.isArray(secondData?.aweme_list)) return secondData.aweme_list;
  return null;
}

async function fetchJson(url: string, headers: HeadersInit, timeout = 45_000) {
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`公开数据接口响应异常（${response.status}）`);
  const payload = await response.json() as Record<string, unknown>;
  const serviceError = providerErrorMessage(payload);
  if (serviceError) throw new Error(serviceError);
  return payload;
}

function profileValues(userInfo: DouyinUserInfo, videoCountFallback = 0) {
  const nickname = safeString(userInfo.nickname, 120) || "抖音账号";
  const handle = safeString(userInfo.unique_id, 120) || safeString(userInfo.short_id, 120);
  return {
    nickname,
    handle: handle ? `抖音号：${handle}` : "抖音公开账号",
    avatarUrl: firstUrl(userInfo.avatar_medium) || firstUrl(userInfo.avatar_thumb),
    signature: safeString(userInfo.signature, 1000),
    followerCount: Math.max(0, Math.floor(safeNumber(userInfo.mplatform_followers_count, safeNumber(userInfo.follower_count, 0)))),
    followingCount: Math.max(0, Math.floor(safeNumber(userInfo.following_count, 0))),
    totalLikes: Math.max(0, Math.floor(safeNumber(userInfo.total_favorited, 0))),
    videoCount: Math.max(videoCountFallback, Math.floor(safeNumber(userInfo.aweme_count, videoCountFallback))),
  };
}

function updateAccountProfile(ownerId: string, accountId: string, userInfo: DouyinUserInfo, statusMessage: string, videoCountFallback = 0) {
  const db = getDatabase();
  const now = unixNow();
  const profile = profileValues(userInfo, videoCountFallback);
  db.prepare(`
    UPDATE monitored_accounts SET nickname = ?, handle = ?, avatar_url = ?, signature = ?,
      follower_count = ?, following_count = ?, total_likes = ?, video_count = ?, status = 'ready',
      status_message = ?, last_sync_at = ?, next_sync_at = ?, updated_at = ?
    WHERE id = ? AND owner_id = ?
  `).run(
    profile.nickname,
    profile.handle,
    profile.avatarUrl,
    profile.signature,
    profile.followerCount,
    profile.followingCount,
    profile.totalLikes,
    profile.videoCount,
    statusMessage,
    now,
    now + 15 * 60,
    now,
    accountId,
    ownerId,
  );
}

export async function syncMarketAccountProfile(ownerId: string, accountId: string) {
  const queued = queueMarketAccountSync(ownerId, accountId);
  if (!queued) return null;
  const db = getDatabase();
  const now = unixNow();
  try {
    const profileUrl = `${profileBaseUrl()}/web/api/v2/user/info/?sec_uid=${encodeURIComponent(queued.sec_uid)}`;
    const profilePayload = await fetchJson(profileUrl, { "User-Agent": MOBILE_USER_AGENT, Accept: "application/json" }, 15_000);
    const userInfo = nestedRecord(profilePayload, "user_info") as DouyinUserInfo | undefined;
    if (!userInfo || safeNumber(profilePayload.status_code, -1) !== 0) throw new Error("抖音没有返回可读取的账号资料。");
    updateAccountProfile(ownerId, accountId, userInfo, "账号资料已读取，正在同步公开作品");
  } catch (error) {
    const message = error instanceof Error ? error.message : "账号资料读取失败";
    db.prepare(`
      UPDATE monitored_accounts SET status = 'error', status_message = ?, next_sync_at = NULL, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(`账号资料读取失败：${message}`, now, accountId, ownerId);
  }
  return db.prepare("SELECT * FROM monitored_accounts WHERE id = ? AND owner_id = ?").get(accountId, ownerId) as MarketAccountRow;
}

function normalizeAweme(item: DouyinAweme) {
  const awemeId = safeString(item.aweme_id, 80);
  if (!awemeId) return null;
  const video = nestedRecord(item, "video") || {};
  const statistics = nestedRecord(item, "statistics") || {};
  const images = Array.isArray(item.images) ? item.images : Array.isArray(item.image_post_info) ? item.image_post_info : [];
  const firstImage = images[0];
  const cover = firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(firstImage) || firstUrl(nestedRecord(firstImage, "display_image"));
  const durationMs = safeNumber(item.duration, safeNumber(video.duration, 0));
  const playCount = safeNumber(statistics.play_count, 0);
  return {
    awemeId,
    sourceUrl: safeString(nestedRecord(item, "share_info")?.share_url, 2000) || `https://www.douyin.com/video/${awemeId}`,
    title: safeString(item.desc, 500) || safeString(item.preview_title, 500) || "未命名作品",
    cover,
    duration: durationMs > 1000 ? durationMs / 1000 : durationMs,
    publishedAt: Math.max(0, Math.floor(safeNumber(item.create_time, 0))),
    metrics: {
      play: playCount > 0 ? playCount : null,
      like: Math.max(0, Math.floor(safeNumber(statistics.digg_count, 0))),
      comment: Math.max(0, Math.floor(safeNumber(statistics.comment_count, 0))),
      share: Math.max(0, Math.floor(safeNumber(statistics.share_count, 0))),
      collect: Math.max(0, Math.floor(safeNumber(statistics.collect_count, 0))),
      raw: statistics,
    },
  };
}

export async function syncMarketAccount(ownerId: string, accountId: string) {
  const queued = queueMarketAccountSync(ownerId, accountId);
  if (!queued) return null;
  const db = getDatabase();
  const now = unixNow();
  try {
    const profileUrl = `${profileBaseUrl()}/web/api/v2/user/info/?sec_uid=${encodeURIComponent(queued.sec_uid)}`;
    const [profileResult, postsResult] = await Promise.allSettled([
      fetchJson(profileUrl, { "User-Agent": MOBILE_USER_AGENT, Accept: "application/json" }, 25_000),
      fetchDouyinPosts(queued.sec_uid),
    ]);
    if (profileResult.status === "rejected") throw profileResult.reason;
    const profilePayload = profileResult.value;
    const userInfo = nestedRecord(profilePayload, "user_info") as DouyinUserInfo | undefined;
    if (!userInfo || safeNumber(profilePayload.status_code, -1) !== 0) throw new Error("抖音没有返回可读取的账号资料。");

    const postsPayload = postsResult.status === "fulfilled" ? postsResult.value : null;
    const awemeList = awemeListFromPayload(postsPayload);
    const postsAvailable = Array.isArray(awemeList);

    const normalized = (awemeList || []).map((item) => item && typeof item === "object" && !Array.isArray(item) ? normalizeAweme(item as DouyinAweme) : null).filter(Boolean) as NonNullable<ReturnType<typeof normalizeAweme>>[];
    for (const video of normalized) {
      const id = `market_video_${createHash("sha256").update(`${accountId}:${video.awemeId}`).digest("hex").slice(0, 24)}`;
      db.prepare(`
        INSERT INTO monitored_videos (id, account_id, aweme_id, source_url, title, cover_url, duration_seconds, published_at, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, aweme_id) DO UPDATE SET
          source_url = excluded.source_url, title = excluded.title, cover_url = excluded.cover_url,
          duration_seconds = excluded.duration_seconds, published_at = excluded.published_at, updated_at = excluded.updated_at
      `).run(id, accountId, video.awemeId, video.sourceUrl, video.title, video.cover, video.duration, video.publishedAt || null, now, now);
      const stored = db.prepare("SELECT id FROM monitored_videos WHERE account_id = ? AND aweme_id = ?").get(accountId, video.awemeId) as { id: string };
      db.prepare(`
        INSERT INTO video_metric_snapshots (id, video_id, collected_at, play_count, like_count, comment_count, share_count, collect_count, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`snapshot_${randomUUID()}`, stored.id, now, video.metrics.play, video.metrics.like, video.metrics.comment, video.metrics.share, video.metrics.collect, JSON.stringify(video.metrics.raw).slice(0, 12_000));
    }

    const postsMessage = postsResult.status === "fulfilled" && postsAvailable
      ? `已同步账号资料和 ${normalized.length} 条公开作品`
      : postsResult.status === "rejected" && postsResult.reason instanceof Error
        ? `账号资料已同步；${postsResult.reason.message}`
        : "账号资料已同步；作品接口没有返回可读取的数据";
    updateAccountProfile(ownerId, accountId, userInfo, postsMessage, normalized.length);
  } catch (error) {
    const message = error instanceof Error ? error.message : "账号同步失败";
    db.prepare(`
      UPDATE monitored_accounts SET status = 'error', status_message = ?, next_sync_at = NULL, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(`同步失败：${message}`, now, accountId, ownerId);
  }
  return db.prepare("SELECT * FROM monitored_accounts WHERE id = ? AND owner_id = ?").get(accountId, ownerId) as MarketAccountRow;
}

export function deleteMarketAccount(ownerId: string, accountId: string) {
  const result = getDatabase().prepare("DELETE FROM monitored_accounts WHERE id = ? AND owner_id = ?")
    .run(accountId, ownerId);
  return Boolean(result.changes);
}
