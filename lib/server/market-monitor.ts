import { createHash, randomUUID } from "node:crypto";
import { getDatabase, unixNow } from "./db";

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

function cleanDouyinProfileUrl(value: string) {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("请输入完整的抖音主页链接。");
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "douyin.com" && !host.endsWith(".douyin.com")) {
    throw new Error("目前仅支持 douyin.com 的公开账号主页链接。");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new Error("这个链接没有包含抖音账号主页信息。");
  }
  parsed.hash = "";
  return parsed.toString();
}

function secUidFromUrl(sourceUrl: string) {
  const parsed = new URL(sourceUrl);
  const pathMatch = parsed.pathname.match(/\/user\/([^/?]+)/i);
  const candidate = pathMatch?.[1] || parsed.searchParams.get("sec_uid") || "";
  if (candidate) return candidate.slice(0, 180);
  return `pending_${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 18)}`;
}

export function listMarketAccounts(ownerId: string) {
  return getDatabase().prepare(`
    SELECT * FROM monitored_accounts
    WHERE owner_id = ?
    ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'syncing' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      updated_at DESC
  `).all(ownerId) as MarketAccountRow[];
}

export function createMarketAccount(ownerId: string, rawUrl: string) {
  const sourceUrl = cleanDouyinProfileUrl(rawUrl);
  const db = getDatabase();
  const existing = db.prepare(`
    SELECT * FROM monitored_accounts WHERE owner_id = ? AND source_url = ? LIMIT 1
  `).get(ownerId, sourceUrl) as MarketAccountRow | undefined;
  if (existing) return existing;

  const now = unixNow();
  const id = `market_${randomUUID()}`;
  db.prepare(`
    INSERT INTO monitored_accounts (
      id, owner_id, platform, source_url, sec_uid, nickname, handle, avatar_url,
      signature, status, status_message, follower_count, following_count,
      total_likes, video_count, last_sync_at, next_sync_at, created_at, updated_at
    ) VALUES (?, ?, 'douyin', ?, ?, '待同步账号', '抖音公开主页', '', '', 'pending',
      '账号已加入，等待采集服务读取公开主页', 0, 0, 0, 0, NULL, ?, ?, ?)
  `).run(id, ownerId, sourceUrl, secUidFromUrl(sourceUrl), now + 15 * 60, now, now);
  return db.prepare("SELECT * FROM monitored_accounts WHERE id = ?").get(id) as MarketAccountRow;
}

export function queueMarketAccountSync(ownerId: string, accountId: string) {
  const db = getDatabase();
  const now = unixNow();
  const result = db.prepare(`
    UPDATE monitored_accounts
    SET status = 'syncing', status_message = '同步任务已排队，正在等待采集服务',
      next_sync_at = ?, updated_at = ?
    WHERE id = ? AND owner_id = ?
  `).run(now + 15 * 60, now, accountId, ownerId);
  if (!result.changes) return null;
  return db.prepare("SELECT * FROM monitored_accounts WHERE id = ?").get(accountId) as MarketAccountRow;
}

export function deleteMarketAccount(ownerId: string, accountId: string) {
  const result = getDatabase().prepare("DELETE FROM monitored_accounts WHERE id = ? AND owner_id = ?")
    .run(accountId, ownerId);
  return Boolean(result.changes);
}
