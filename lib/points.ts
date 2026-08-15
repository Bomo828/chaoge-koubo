import type { MemberSession } from "../app/member-session";
import { getDatabase, unixNow } from "./server/db";
import { getPlatformSettings, pointCost } from "./server/platform-settings";

export const AI_POINT_COSTS = {
  prompt_optimize: 2,
  image_generate: 10,
  video_generate: 1,
  voice_clone: 80,
  speech_generate: 1,
  lip_sync_generate: 80,
} as const;

export type AiPointAction = keyof typeof AI_POINT_COSTS;

export type WalletSummary = {
  points: number;
  recent: Array<{
    id: string;
    delta: number;
    reason: string;
    taskId: string | null;
    createdAt: number;
  }>;
};

export type WalletHistoryEntry = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  taskId: string | null;
  createdAt: number;
};

export type WalletHistory = {
  consumption: WalletHistoryEntry[];
  recharge: WalletHistoryEntry[];
};

type Reservation = {
  requestId: string;
  memberId: string;
  action: AiPointAction;
  reservedCost: number;
};

type ChargeRow = {
  request_id: string;
  user_id: string;
  action: AiPointAction;
  reserved_cost: number;
  actual_cost: number | null;
  state: "created" | "reserved" | "succeeded" | "refunded" | "insufficient";
};

export class PointsError extends Error {
  status: number;
  points?: number;
  required?: number;

  constructor(message: string, status: number, details?: { points?: number; required?: number }) {
    super(message);
    this.name = "PointsError";
    this.status = status;
    this.points = details?.points;
    this.required = details?.required;
  }
}

function normalizeRequestId(value: unknown) {
  if (typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value)) return value;
  return crypto.randomUUID();
}

function memberPoints(memberId: string) {
  const row = getDatabase().prepare("SELECT points FROM users WHERE id = ?").get(memberId) as { points?: number } | undefined;
  return Number(row?.points ?? 0);
}

function inTransaction<T>(callback: () => T) {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function getWallet(member: MemberSession): Promise<WalletSummary> {
  const db = getDatabase();
  const recent = db.prepare(`
    SELECT id, delta, reason, task_id, created_at
    FROM point_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(member.id) as Array<{ id: string; delta: number; reason: string; task_id: string | null; created_at: number }>;
  return {
    points: memberPoints(member.id),
    recent: recent.map((item) => ({
      id: item.id,
      delta: Number(item.delta),
      reason: item.reason,
      taskId: item.task_id,
      createdAt: Number(item.created_at),
    })),
  };
}

export async function getWalletHistory(member: MemberSession): Promise<WalletHistory> {
  const rows = getDatabase().prepare(`
    SELECT id, delta, balance_after, reason, task_id, created_at
    FROM point_ledger
    WHERE user_id = ?
      AND (delta < 0 OR (delta > 0 AND reason LIKE '%充值%'))
    ORDER BY created_at DESC, id DESC
    LIMIT 2000
  `).all(member.id) as Array<{
    id: string;
    delta: number;
    balance_after: number;
    reason: string;
    task_id: string | null;
    created_at: number;
  }>;

  const history = rows.map((item): WalletHistoryEntry => ({
    id: item.id,
    delta: Number(item.delta),
    balanceAfter: Number(item.balance_after),
    reason: item.reason,
    taskId: item.task_id,
    createdAt: Number(item.created_at),
  }));

  return {
    consumption: history.filter((item) => item.delta < 0),
    recharge: history.filter((item) => item.delta > 0),
  };
}

export async function topUpDemoPoints(member: MemberSession, amount: number, rawRequestId: unknown) {
  const platform = getPlatformSettings();
  if (platform.paymentMode !== "demo") {
    throw new PointsError("当前已切换为正式支付模式，请通过支付订单完成充值。", 403);
  }
  const allowedAmounts = new Set(platform.rechargePackages.filter((item) => item.enabled).map((item) => item.points + item.bonus));
  const safeAmount = Math.floor(amount);
  if (!allowedAmounts.has(safeAmount)) throw new PointsError("请选择有效的演示充值额度。", 400);

  const requestId = normalizeRequestId(rawRequestId);
  const db = getDatabase();
  const now = unixNow();
  const ledgerId = `ledger_topup_${requestId}`;
  inTransaction(() => {
    const exists = db.prepare("SELECT 1 FROM point_ledger WHERE task_id = ?").get(requestId);
    if (exists) throw new PointsError("这笔充值已经到账，请勿重复提交。", 409);
    db.prepare("UPDATE users SET points = points + ?, updated_at = ? WHERE id = ?").run(safeAmount, now, member.id);
    const balance = memberPoints(member.id);
    db.prepare(`
      INSERT INTO point_ledger (id, user_id, delta, balance_after, reason, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ledgerId, member.id, safeAmount, balance, member.role === "member" ? "积分充值（本地演示）" : "管理员账户演示充值", requestId, now);
  });
  return getWallet(member);
}

export async function reserveAiPoints(
  member: MemberSession,
  action: AiPointAction,
  quantity: number,
  rawRequestId: unknown,
  reservedCostOverride?: number,
): Promise<Reservation> {
  const requestId = normalizeRequestId(rawRequestId);
  const safeQuantity = Math.max(1, Math.floor(quantity));
  const reservedCost = Number.isFinite(reservedCostOverride)
    ? Math.max(1, Math.ceil(Number(reservedCostOverride)))
    : pointCost(action, AI_POINT_COSTS[action]) * safeQuantity;
  const db = getDatabase();
  const now = unixNow();

  inTransaction(() => {
    const previous = db.prepare("SELECT state FROM ai_point_charges WHERE request_id = ?").get(requestId) as { state?: string } | undefined;
    if (previous) throw new PointsError("这次 AI 请求已经提交，请勿重复操作。", 409, { points: memberPoints(member.id), required: reservedCost });
    const current = memberPoints(member.id);
    if (current < reservedCost) {
      db.prepare(`
        INSERT INTO ai_point_charges (request_id, user_id, action, reserved_cost, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'insufficient', ?, ?)
      `).run(requestId, member.id, action, reservedCost, now, now);
      throw new PointsError(`积分不足，本次需要 ${reservedCost} 积分。`, 402, { points: current, required: reservedCost });
    }
    db.prepare("UPDATE users SET points = points - ?, updated_at = ? WHERE id = ?").run(reservedCost, now, member.id);
    db.prepare(`
      INSERT INTO ai_point_charges (request_id, user_id, action, reserved_cost, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reserved', ?, ?)
    `).run(requestId, member.id, action, reservedCost, now, now);
  });
  return { requestId, memberId: member.id, action, reservedCost };
}

const actionReasons: Record<AiPointAction, string> = {
  prompt_optimize: "AI 优化生成要求",
  image_generate: "AI 图片生成",
  video_generate: "AI 商家素材成片",
  voice_clone: "AI 克隆声音",
  speech_generate: "AI 生成口播音频",
  lip_sync_generate: "AI 生成对口型视频",
};

function settleCharge(charge: ChargeRow, actualCost: number) {
  const db = getDatabase();
  if (charge.state === "succeeded" || charge.state === "refunded") return;
  if (charge.state !== "reserved") throw new PointsError("本次 AI 任务尚未进入可结算状态。", 409);
  const settledCost = Math.min(charge.reserved_cost, Math.max(0, Math.ceil(actualCost)));
  const refund = charge.reserved_cost - settledCost;
  const now = unixNow();
  inTransaction(() => {
    if (refund > 0) db.prepare("UPDATE users SET points = points + ?, updated_at = ? WHERE id = ?").run(refund, now, charge.user_id);
    db.prepare("UPDATE ai_point_charges SET state = 'succeeded', actual_cost = ?, updated_at = ? WHERE request_id = ? AND state = 'reserved'")
      .run(settledCost, now, charge.request_id);
    const balance = memberPoints(charge.user_id);
    db.prepare(`
      INSERT OR IGNORE INTO point_ledger (id, user_id, delta, balance_after, reason, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`ledger_${charge.request_id}`, charge.user_id, -settledCost, balance, actionReasons[charge.action], charge.request_id, now);
  });
}

export function getReservedAiPoints(member: MemberSession, rawRequestId: unknown) {
  const requestId = normalizeRequestId(rawRequestId);
  const charge = getDatabase().prepare(`
    SELECT reserved_cost FROM ai_point_charges WHERE request_id = ? AND user_id = ? LIMIT 1
  `).get(requestId, member.id) as { reserved_cost?: number } | undefined;
  if (!charge) throw new PointsError("没有找到本次 AI 任务的积分订单。", 404);
  return Math.max(0, Number(charge.reserved_cost) || 0);
}

export async function settleAiPoints(reservation: Reservation, quantity: number) {
  const charge = getDatabase().prepare(`
    SELECT request_id, user_id, action, reserved_cost, actual_cost, state
    FROM ai_point_charges WHERE request_id = ? AND user_id = ?
  `).get(reservation.requestId, reservation.memberId) as ChargeRow | undefined;
  if (!charge) throw new PointsError("没有找到本次积分订单。", 404);
  settleCharge(charge, pointCost(reservation.action, AI_POINT_COSTS[reservation.action]) * Math.max(1, Math.floor(quantity)));
  return getWallet({ id: reservation.memberId, username: "", displayName: "", level: "", points: 0, role: "member" });
}

export async function settleAiPointsByRequest(member: MemberSession, rawRequestId: unknown, actualCost: number) {
  const requestId = normalizeRequestId(rawRequestId);
  const charge = getDatabase().prepare(`
    SELECT request_id, user_id, action, reserved_cost, actual_cost, state
    FROM ai_point_charges WHERE request_id = ? AND user_id = ?
  `).get(requestId, member.id) as ChargeRow | undefined;
  if (!charge) throw new PointsError("没有找到本次 AI 任务的积分订单。", 404);
  settleCharge(charge, actualCost);
  return getWallet(member);
}

export async function refundAiPoints(reservation: Reservation) {
  const db = getDatabase();
  const now = unixNow();
  inTransaction(() => {
    const charge = db.prepare("SELECT state FROM ai_point_charges WHERE request_id = ? AND user_id = ?")
      .get(reservation.requestId, reservation.memberId) as { state?: string } | undefined;
    if (charge?.state !== "reserved") return;
    db.prepare("UPDATE users SET points = points + ?, updated_at = ? WHERE id = ?")
      .run(reservation.reservedCost, now, reservation.memberId);
    db.prepare("UPDATE ai_point_charges SET state = 'refunded', actual_cost = 0, updated_at = ? WHERE request_id = ? AND user_id = ?")
      .run(now, reservation.requestId, reservation.memberId);
  });
}

export async function refundAiPointsByRequest(member: MemberSession, rawRequestId: unknown) {
  const requestId = normalizeRequestId(rawRequestId);
  const db = getDatabase();
  const charge = db.prepare(`
    SELECT request_id, user_id, action, reserved_cost, actual_cost, state
    FROM ai_point_charges WHERE request_id = ? AND user_id = ?
  `).get(requestId, member.id) as ChargeRow | undefined;
  if (!charge) throw new PointsError("没有找到本次 AI 任务的积分订单。", 404);
  if (charge.state !== "reserved") return getWallet(member);
  const now = unixNow();
  inTransaction(() => {
    db.prepare("UPDATE users SET points = points + ?, updated_at = ? WHERE id = ?")
      .run(charge.reserved_cost, now, member.id);
    db.prepare("UPDATE ai_point_charges SET state = 'refunded', actual_cost = 0, updated_at = ? WHERE request_id = ? AND user_id = ? AND state = 'reserved'")
      .run(now, requestId, member.id);
    const balance = memberPoints(member.id);
    db.prepare(`
      INSERT OR IGNORE INTO point_ledger (id, user_id, delta, balance_after, reason, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`ledger_refund_${requestId}`, member.id, charge.reserved_cost, balance, "AI 任务失败，积分退回", `refund_${requestId}`, now);
  });
  return getWallet(member);
}

export function pointsErrorResponse(error: unknown) {
  if (!(error instanceof PointsError)) return null;
  return Response.json({
    error: error.message,
    wallet: error.points === undefined ? undefined : { points: error.points },
    required: error.required,
  }, { status: error.status });
}
