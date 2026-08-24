import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getUserById, hashPassword, type AuthUser } from "./auth";
import { getDatabase, unixNow } from "./db";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MEMBER_LEVELS = new Set(["basic", "growth", "business", "vip"]);

export type AdminInvitation = {
  id: string;
  codeHint: string;
  status: "active" | "disabled";
  availability: "active" | "disabled" | "expired" | "exhausted";
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  giftPoints: number;
  memberLevel: string;
  note: string;
  createdByName: string;
  createdAt: number;
  lastUsedBy: string;
  lastUsedAt: number | null;
};

type InvitationRow = {
  id: string;
  code_hash: string;
  code_hint: string;
  status: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  gift_points: number;
  member_level: string;
  note: string;
  created_by_name?: string | null;
  created_at: number;
  last_used_by?: string | null;
  last_used_at?: number | null;
};

export type InvitationErrorCode =
  | "invite_required"
  | "invite_invalid"
  | "invite_expired"
  | "invite_used"
  | "username_taken";

export class InvitationError extends Error {
  constructor(public readonly code: InvitationErrorCode) {
    super(code);
  }
}

function normalizeCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashCode(value: string) {
  return createHash("sha256").update(`merchant-studio-invite:${normalizeCode(value)}`).digest("hex");
}

function createPlainCode() {
  const bytes = randomBytes(16);
  let raw = "";
  for (let index = 0; index < 16; index += 1) raw += INVITE_ALPHABET[bytes[index] % INVITE_ALPHABET.length];
  return raw.match(/.{1,4}/g)?.join("-") || raw;
}

function codeHint(code: string) {
  const normalized = normalizeCode(code);
  return `${normalized.slice(0, 4)}-••••-••••-${normalized.slice(-4)}`;
}

function mapInvitation(row: InvitationRow): AdminInvitation {
  const status = row.status === "disabled" ? "disabled" : "active";
  const availability = status === "disabled"
    ? "disabled"
    : row.expires_at !== null && Number(row.expires_at) <= unixNow()
      ? "expired"
      : Number(row.used_count) >= Number(row.max_uses)
        ? "exhausted"
        : "active";
  return {
    id: row.id,
    codeHint: row.code_hint,
    status,
    availability,
    maxUses: Number(row.max_uses),
    usedCount: Number(row.used_count),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    giftPoints: Number(row.gift_points),
    memberLevel: row.member_level,
    note: row.note,
    createdByName: row.created_by_name || "平台管理员",
    createdAt: Number(row.created_at),
    lastUsedBy: row.last_used_by || "",
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
  };
}

export function listInvitations() {
  const rows = getDatabase().prepare(`
    SELECT i.*,
      creator.display_name AS created_by_name,
      used_user.display_name AS last_used_by,
      latest_use.used_at AS last_used_at
    FROM invitation_codes i
    LEFT JOIN users creator ON creator.id = i.created_by
    LEFT JOIN invitation_code_uses latest_use ON latest_use.id = (
      SELECT u.id FROM invitation_code_uses u
      WHERE u.invitation_id = i.id ORDER BY u.used_at DESC LIMIT 1
    )
    LEFT JOIN users used_user ON used_user.id = latest_use.user_id
    ORDER BY i.created_at DESC
  `).all() as InvitationRow[];
  return rows.map(mapInvitation);
}

export function createInvitations(actorId: string, input: {
  count?: number;
  maxUses?: number;
  validityDays?: number;
  giftPoints?: number;
  memberLevel?: string;
  note?: string;
}) {
  const db = getDatabase();
  const count = Math.min(50, Math.max(1, Math.trunc(Number(input.count) || 1)));
  const maxUses = Math.min(100, Math.max(1, Math.trunc(Number(input.maxUses) || 1)));
  const validityDays = Math.min(365, Math.max(0, Math.trunc(Number(input.validityDays) || 0)));
  const giftPoints = Math.min(10_000_000, Math.max(0, Math.trunc(Number(input.giftPoints) || 0)));
  const memberLevel = MEMBER_LEVELS.has(String(input.memberLevel)) ? String(input.memberLevel) : "basic";
  const note = String(input.note || "").trim().slice(0, 100);
  const now = unixNow();
  const expiresAt = validityDays ? now + validityDays * 86400 : null;
  const created: Array<{ id: string; code: string }> = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(`
      INSERT INTO invitation_codes
        (id, code_hash, code_hint, status, max_uses, used_count, expires_at, gift_points, member_level, note, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < count; index += 1) {
      const code = createPlainCode();
      const id = `invite_${randomUUID()}`;
      insert.run(id, hashCode(code), codeHint(code), maxUses, expiresAt, giftPoints, memberLevel, note, actorId, now, now);
      created.push({ id, code });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const all = listInvitations();
  return {
    items: created.map(({ id }) => all.find((item) => item.id === id)).filter(Boolean) as AdminInvitation[],
    codes: created.map(({ id, code }) => ({ id, code })),
  };
}

export function setInvitationStatus(id: string, status: string) {
  const nextStatus = status === "disabled" ? "disabled" : "active";
  const result = getDatabase().prepare("UPDATE invitation_codes SET status = ?, updated_at = ? WHERE id = ?")
    .run(nextStatus, unixNow(), id);
  if (!Number(result.changes)) return null;
  return listInvitations().find((item) => item.id === id) || null;
}

export function registerWithInvitation(input: {
  invitationCode: string;
  username: string;
  displayName: string;
  password: string;
  registrationIp?: string;
}): AuthUser {
  const normalized = normalizeCode(input.invitationCode);
  if (!normalized) throw new InvitationError("invite_required");
  const db = getDatabase();
  const passwordHash = hashPassword(input.password);
  const now = unixNow();
  const userId = `user_${randomUUID()}`;

  db.exec("BEGIN IMMEDIATE");
  try {
    const invitation = db.prepare(`
      SELECT id, status, max_uses, used_count, expires_at, gift_points, member_level
      FROM invitation_codes WHERE code_hash = ? LIMIT 1
    `).get(hashCode(normalized)) as {
      id: string; status: string; max_uses: number; used_count: number;
      expires_at: number | null; gift_points: number; member_level: string;
    } | undefined;
    if (!invitation || invitation.status !== "active") throw new InvitationError("invite_invalid");
    if (invitation.expires_at !== null && Number(invitation.expires_at) <= now) throw new InvitationError("invite_expired");
    if (Number(invitation.used_count) >= Number(invitation.max_uses)) throw new InvitationError("invite_used");
    const duplicate = db.prepare("SELECT 1 AS found FROM users WHERE username = ? COLLATE NOCASE LIMIT 1")
      .get(input.username.trim()) as { found?: number } | undefined;
    if (duplicate) throw new InvitationError("username_taken");

    const points = Math.max(0, Number(invitation.gift_points));
    db.prepare(`
      INSERT INTO users
        (id, username, password_hash, display_name, role, level, points, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', ?, ?, 'active', ?, ?)
    `).run(userId, input.username.trim(), passwordHash, input.displayName.trim(), invitation.member_level || "basic", points, now, now);
    db.prepare(`
      INSERT INTO invitation_code_uses (id, invitation_id, user_id, used_at, registration_ip)
      VALUES (?, ?, ?, ?, ?)
    `).run(`invite_use_${randomUUID()}`, invitation.id, userId, now, String(input.registrationIp || "").slice(0, 80));
    db.prepare("UPDATE invitation_codes SET used_count = used_count + 1, updated_at = ? WHERE id = ?")
      .run(now, invitation.id);
    if (points > 0) {
      db.prepare(`
        INSERT INTO point_ledger (id, user_id, delta, balance_after, reason, task_id, operator_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`ledger_${randomUUID()}`, userId, points, points, "邀请码注册赠送积分", `invite:${invitation.id}:${userId}`, invitation.id, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const user = getUserById(userId);
  if (!user) throw new Error("registered_user_missing");
  return user;
}
