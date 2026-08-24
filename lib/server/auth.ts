import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getDatabase, unixNow } from "./db";

export const SESSION_COOKIE = "merchant_studio_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export type UserRole = "member" | "admin" | "super_admin";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  level: string;
  points: number;
  status: string;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  avatar_url: string | null;
  role: UserRole;
  level: string;
  points: number;
  status: string;
};

function encode(value: Buffer) {
  return value.toString("base64url");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${encode(salt)}$${encode(digest)}`;
}

export function verifyPassword(password: string, stored: string) {
  const [algorithm, saltValue, digestValue] = stored.split("$");
  if (algorithm !== "scrypt" || !saltValue || !digestValue) return false;
  try {
    const expected = Buffer.from(digestValue, "base64url");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    level: row.level,
    points: Number(row.points),
    status: row.status,
  };
}

let bootstrapComplete = false;

export function ensureBootstrapUsers() {
  if (bootstrapComplete) return;
  const db = getDatabase();
  const now = unixNow();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, username, password_hash, display_name, role, level, points, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);

  if (process.env.NODE_ENV !== "production" || process.env.ENABLE_DEMO_ACCOUNT === "true") {
    insert.run(
      "member_demo_001",
      process.env.DEMO_USERNAME?.trim() || "demo",
      hashPassword(process.env.DEMO_PASSWORD || "123456"),
      "商装工坊会员",
      "member",
      "basic",
      1000,
      now,
      now,
    );
  }

  const adminUsername = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim()
    || (process.env.NODE_ENV !== "production" ? "admin" : "");
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD
    || (process.env.NODE_ENV !== "production" ? "Admin123456!" : "");
  if (adminUsername && adminPassword) {
    insert.run(
      "admin_local_001",
      adminUsername,
      hashPassword(adminPassword),
      "平台管理员",
      "super_admin",
      "admin",
      0,
      now,
      now,
    );
  }
  bootstrapComplete = true;
}

export function findUserByUsername(username: string) {
  ensureBootstrapUsers();
  return getDatabase().prepare(`
    SELECT id, username, password_hash, display_name, avatar_url, role, level, points, status
    FROM users WHERE username = ? COLLATE NOCASE LIMIT 1
  `).get(username.trim()) as UserRow | undefined;
}

export function getUserById(userId: string) {
  ensureBootstrapUsers();
  const row = getDatabase().prepare(`
    SELECT id, username, password_hash, display_name, avatar_url, role, level, points, status
    FROM users WHERE id = ? LIMIT 1
  `).get(userId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function authenticateUser(username: string, password: string) {
  const row = findUserByUsername(username);
  if (!row || row.status !== "active" || !verifyPassword(password, row.password_hash)) return null;
  return toUser(row);
}

export function changeUserPassword(userId: string, currentPassword: string, nextPassword: string) {
  ensureBootstrapUsers();
  const db = getDatabase();
  const row = db.prepare("SELECT password_hash, status FROM users WHERE id = ? LIMIT 1")
    .get(userId) as { password_hash?: string; status?: string } | undefined;
  if (!row?.password_hash || row.status !== "active" || !verifyPassword(currentPassword, row.password_hash)) return false;
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(nextPassword), unixNow(), userId);
  return true;
}

export function createSession(userId: string) {
  const db = getDatabase();
  const token = encode(randomBytes(32));
  const now = unixNow();
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`session_${randomUUID()}`, userId, tokenHash(token), now + SESSION_MAX_AGE, now, now);
  return token;
}

export function getUserBySessionToken(token: string | undefined | null) {
  if (!token) return null;
  ensureBootstrapUsers();
  const db = getDatabase();
  const now = unixNow();
  const row = db.prepare(`
    SELECT u.id, u.username, u.password_hash, u.display_name, u.avatar_url,
      u.role, u.level, u.points, u.status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
    LIMIT 1
  `).get(tokenHash(token), now) as UserRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash(token));
  return toUser(row);
}

export function revokeSession(token: string | undefined | null) {
  if (!token) return;
  getDatabase().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function isAdmin<T extends { role: UserRole }>(user: T | null): user is T {
  return Boolean(user && (user.role === "admin" || user.role === "super_admin"));
}
