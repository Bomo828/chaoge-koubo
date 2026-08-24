import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
} from "node:crypto";
import type { MemberSession } from "../../app/member-session";
import { getDatabase, unixNow } from "./db";
import { getPlatformSettings, rechargeTotalPoints } from "./platform-settings";
import {
  getWechatPayConfig,
  wechatPayMissingCredentialNames,
  type WechatPayConfig,
} from "./wechat-pay-credentials";

const WECHAT_API_BASE = "https://api.mch.weixin.qq.com";
export const CUSTOM_RECHARGE_MIN_YUAN = 1;
export const CUSTOM_RECHARGE_MAX_YUAN = 5000;

type RechargeOrderRow = {
  out_trade_no: string;
  user_id: string;
  package_id: string;
  package_name: string;
  amount_fen: number;
  points: number;
  status: string;
  code_url: string;
  wechat_transaction_id: string | null;
  trade_state: string;
  failure_reason: string;
  expires_at: number;
  paid_at: number | null;
  last_query_at: number | null;
  created_at: number;
  updated_at: number;
};

export type RechargeOrder = {
  outTradeNo: string;
  packageId: string;
  packageName: string;
  amountYuan: number;
  points: number;
  status: string;
  tradeState: string;
  codeUrl: string;
  expiresAt: number;
  paidAt: number | null;
  failureReason: string;
};

export class WechatPayError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 500, code = "WECHAT_PAY_ERROR") {
    super(message);
    this.name = "WechatPayError";
    this.status = status;
    this.code = code;
  }
}

export function wechatPayMissingConfig() {
  return wechatPayMissingCredentialNames();
}

export function isWechatPayConfigured() {
  return wechatPayMissingConfig().length === 0;
}

function getConfig(): WechatPayConfig {
  try {
    return getWechatPayConfig();
  } catch (error) {
    throw new WechatPayError(error instanceof Error ? error.message : "微信支付尚未完成配置。", 503, "PAYMENT_NOT_CONFIGURED");
  }
}

function signature(config: WechatPayConfig, method: string, requestPath: string, body: string, timestamp: string, nonce: string) {
  const signer = createSign("RSA-SHA256");
  signer.update(`${method}\n${requestPath}\n${timestamp}\n${nonce}\n${body}\n`);
  signer.end();
  return signer.sign(config.privateKey, "base64");
}

function verifyWechatSignature(config: WechatPayConfig, timestamp: string, nonce: string, body: string, signatureValue: string, serial = "") {
  if (config.platformSerial && serial && config.platformSerial !== serial) {
    throw new WechatPayError("微信支付签名证书编号不匹配。", 400, "INVALID_WECHAT_SERIAL");
  }
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${timestamp}\n${nonce}\n${body}\n`);
  verifier.end();
  if (!verifier.verify(config.platformKey, signatureValue, "base64")) {
    throw new WechatPayError("微信支付返回签名校验失败。", 400, "INVALID_WECHAT_SIGNATURE");
  }
}

async function requestWechat<T>(
  method: "GET" | "POST",
  requestPath: string,
  bodyObject?: Record<string, unknown>,
  acceptableErrorCodes: string[] = [],
) {
  const config = getConfig();
  const body = bodyObject ? JSON.stringify(bodyObject) : "";
  const timestamp = String(unixNow());
  const nonce = randomBytes(16).toString("hex");
  const signed = signature(config, method, requestPath, body, timestamp, nonce);
  const response = await fetch(`${WECHAT_API_BASE}${requestPath}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.serialNo}",signature="${signed}"`,
      "User-Agent": "merchant-studio-web-v2/1.0",
    },
    body: body || undefined,
    cache: "no-store",
  });
  const responseBody = await response.text();
  const responseTimestamp = response.headers.get("wechatpay-timestamp") || "";
  const responseNonce = response.headers.get("wechatpay-nonce") || "";
  const responseSignature = response.headers.get("wechatpay-signature") || "";
  const responseSerial = response.headers.get("wechatpay-serial") || "";
  if (responseTimestamp && responseNonce && responseSignature) {
    verifyWechatSignature(config, responseTimestamp, responseNonce, responseBody, responseSignature, responseSerial);
  } else if (response.ok) {
    throw new WechatPayError("微信支付响应缺少验签信息。", 502, "MISSING_WECHAT_SIGNATURE");
  }
  const data = responseBody ? JSON.parse(responseBody) as T & { code?: string; message?: string } : {} as T & { code?: string; message?: string };
  if (!response.ok && !acceptableErrorCodes.includes(data.code || "")) {
    throw new WechatPayError(data.message || `微信支付请求失败（${response.status}）。`, 502, data.code || "WECHAT_API_ERROR");
  }
  return data;
}

export async function testWechatPayConnection() {
  const config = getConfig();
  const probe = `CONFIGTEST${Date.now()}`;
  const requestPath = `/v3/pay/transactions/out-trade-no/${probe}?mchid=${encodeURIComponent(config.mchId)}`;
  const result = await requestWechat<{ code?: string }>("GET", requestPath, undefined, ["ORDER_NOT_EXIST"]);
  if (result.code !== "ORDER_NOT_EXIST") throw new WechatPayError("微信支付接口返回异常，请稍后重试。", 502, "UNEXPECTED_WECHAT_RESPONSE");
  return { connected: true, message: "商户签名与微信支付公钥验签均已通过。" };
}

function publicOrder(row: RechargeOrderRow): RechargeOrder {
  return {
    outTradeNo: row.out_trade_no,
    packageId: row.package_id,
    packageName: row.package_name,
    amountYuan: Number((Number(row.amount_fen) / 100).toFixed(2)),
    points: Number(row.points),
    status: row.status,
    tradeState: row.trade_state,
    codeUrl: row.code_url,
    expiresAt: Number(row.expires_at) * 1000,
    paidAt: row.paid_at ? Number(row.paid_at) * 1000 : null,
    failureReason: row.failure_reason,
  };
}

function orderRow(outTradeNo: string) {
  return getDatabase().prepare("SELECT * FROM recharge_orders WHERE out_trade_no = ? LIMIT 1").get(outTradeNo) as RechargeOrderRow | undefined;
}

function createOrderNo() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `R${stamp}${randomBytes(8).toString("hex")}`.slice(0, 32);
}

export async function createNativeRecharge(
  member: MemberSession,
  selection: { packageId: string } | { amountYuan: number },
) {
  const platform = getPlatformSettings();
  if (platform.paymentMode !== "wechat") {
    throw new WechatPayError("管理员尚未启用正式微信支付。", 403, "PAYMENT_MODE_DISABLED");
  }
  const selected = "packageId" in selection
    ? platform.rechargePackages.find((item) => item.enabled && item.id === selection.packageId)
    : null;
  if ("packageId" in selection && !selected) {
    throw new WechatPayError("充值套餐不存在或已下架。", 400, "INVALID_PACKAGE");
  }

  const amountFen = selected
    ? Math.round(Number(selected.priceYuan) * 100)
    : Math.round(Number("amountYuan" in selection ? selection.amountYuan : 0) * 100);
  const minFen = CUSTOM_RECHARGE_MIN_YUAN * 100;
  const maxFen = CUSTOM_RECHARGE_MAX_YUAN * 100;
  if (!Number.isSafeInteger(amountFen) || (!selected && amountFen % 100 !== 0) || amountFen < minFen || amountFen > maxFen) {
    throw new WechatPayError(
      `自由充值金额需在${CUSTOM_RECHARGE_MIN_YUAN}—${CUSTOM_RECHARGE_MAX_YUAN}元之间。`,
      400,
      "INVALID_AMOUNT",
    );
  }

  const packageId = selected?.id || `custom-${amountFen}`;
  const packageName = selected?.name || "自由金额充值";
  const points = selected
    ? rechargeTotalPoints(platform, selected)
    : Math.max(1, Math.floor((amountFen * platform.rechargePointsPerYuan) / 100));

  const db = getDatabase();
  const now = unixNow();
  const reusable = db.prepare(`
    SELECT * FROM recharge_orders
    WHERE user_id = ? AND package_id = ? AND status = 'pending' AND expires_at > ? AND code_url <> ''
    ORDER BY created_at DESC LIMIT 1
  `).get(member.id, packageId, now + 60) as RechargeOrderRow | undefined;
  if (reusable) return publicOrder(reusable);

  const outTradeNo = createOrderNo();
  const expiresAt = now + 15 * 60;
  db.prepare(`
    INSERT INTO recharge_orders
      (out_trade_no, user_id, package_id, package_name, amount_fen, points, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(outTradeNo, member.id, packageId, packageName, amountFen, points, expiresAt, now, now);

  try {
    const config = getConfig();
    const result = await requestWechat<{ code_url?: string }>("POST", "/v3/pay/transactions/native", {
      appid: config.appId,
      mchid: config.mchId,
      description: `${packageName}（${points}积分）`.slice(0, 127),
      out_trade_no: outTradeNo,
      time_expire: new Date(expiresAt * 1000).toISOString(),
      notify_url: config.notifyUrl,
      amount: { total: amountFen, currency: "CNY" },
      attach: packageId,
    });
    if (!result.code_url) throw new WechatPayError("微信支付没有返回二维码链接。", 502, "MISSING_CODE_URL");
    db.prepare("UPDATE recharge_orders SET code_url = ?, updated_at = ? WHERE out_trade_no = ?")
      .run(result.code_url, unixNow(), outTradeNo);
    return publicOrder(orderRow(outTradeNo)!);
  } catch (error) {
    const message = error instanceof Error ? error.message : "微信支付下单失败。";
    db.prepare("UPDATE recharge_orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE out_trade_no = ?")
      .run(message.slice(0, 500), unixNow(), outTradeNo);
    throw error;
  }
}

function applyPaidRecharge(outTradeNo: string, amountFen: number, transactionId: string, paidAt: number) {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = orderRow(outTradeNo);
    if (!row) throw new WechatPayError("充值订单不存在。", 404, "ORDER_NOT_FOUND");
    if (Number(row.amount_fen) !== Number(amountFen)) {
      throw new WechatPayError("微信支付金额与充值订单不一致。", 400, "AMOUNT_MISMATCH");
    }
    if (row.status !== "paid") {
      const now = unixNow();
      db.prepare(`
        UPDATE recharge_orders
        SET status = 'paid', trade_state = 'SUCCESS', wechat_transaction_id = ?, paid_at = ?, failure_reason = '', updated_at = ?
        WHERE out_trade_no = ? AND status <> 'paid'
      `).run(transactionId, paidAt, now, outTradeNo);
      db.prepare("UPDATE users SET points = points + ?, updated_at = ? WHERE id = ?")
        .run(row.points, now, row.user_id);
      const balanceRow = db.prepare("SELECT points FROM users WHERE id = ?").get(row.user_id) as { points: number };
      db.prepare(`
        INSERT OR IGNORE INTO point_ledger (id, user_id, delta, balance_after, reason, task_id, operator_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `ledger_recharge_${outTradeNo}`,
        row.user_id,
        row.points,
        Number(balanceRow.points),
        `微信支付充值 · ${row.package_name}`,
        `recharge:${outTradeNo}`,
        transactionId,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return publicOrder(orderRow(outTradeNo)!);
}

function paidTimestamp(value: string | undefined) {
  const milliseconds = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : unixNow();
}

export async function refreshRechargeOrder(member: MemberSession, outTradeNo: string) {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(outTradeNo)) throw new WechatPayError("充值订单编号无效。", 400, "INVALID_ORDER_NO");
  let row = orderRow(outTradeNo);
  if (!row || row.user_id !== member.id) throw new WechatPayError("没有找到这笔充值订单。", 404, "ORDER_NOT_FOUND");
  const now = unixNow();
  if (row.status === "pending" && (!row.last_query_at || now - Number(row.last_query_at) >= 5)) {
    getDatabase().prepare("UPDATE recharge_orders SET last_query_at = ?, updated_at = ? WHERE out_trade_no = ?")
      .run(now, now, outTradeNo);
    const config = getConfig();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`;
    const result = await requestWechat<{
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      success_time?: string;
      amount?: { total?: number };
    }>("GET", path);
    if (result.appid !== config.appId || result.mchid !== config.mchId || result.out_trade_no !== outTradeNo) {
      throw new WechatPayError("微信支付订单身份校验失败。", 400, "ORDER_IDENTITY_MISMATCH");
    }
    if (result.trade_state === "SUCCESS") {
      return applyPaidRecharge(outTradeNo, Number(result.amount?.total), String(result.transaction_id || ""), paidTimestamp(result.success_time));
    }
    if (result.trade_state === "CLOSED" || result.trade_state === "REVOKED" || result.trade_state === "PAYERROR") {
      getDatabase().prepare("UPDATE recharge_orders SET status = 'closed', trade_state = ?, updated_at = ? WHERE out_trade_no = ? AND status = 'pending'")
        .run(result.trade_state, unixNow(), outTradeNo);
    } else if (row.expires_at <= now) {
      getDatabase().prepare("UPDATE recharge_orders SET status = 'expired', updated_at = ? WHERE out_trade_no = ? AND status = 'pending'")
        .run(now, outTradeNo);
    }
    row = orderRow(outTradeNo)!;
  }
  return publicOrder(row);
}

function decryptNotification(config: WechatPayConfig, resource: { ciphertext?: string; nonce?: string; associated_data?: string }) {
  if (Buffer.byteLength(config.apiV3Key) !== 32) throw new WechatPayError("APIv3密钥必须为32个字符。", 500, "INVALID_API_V3_KEY");
  const encrypted = Buffer.from(String(resource.ciphertext || ""), "base64");
  if (encrypted.length <= 16) throw new WechatPayError("微信支付回调密文无效。", 400, "INVALID_NOTIFICATION");
  const data = encrypted.subarray(0, encrypted.length - 16);
  const authTag = encrypted.subarray(encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.apiV3Key), Buffer.from(String(resource.nonce || "")));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(String(resource.associated_data || "")));
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as {
    appid?: string;
    mchid?: string;
    out_trade_no?: string;
    transaction_id?: string;
    trade_state?: string;
    success_time?: string;
    amount?: { total?: number };
  };
}

export function handleWechatNotification(headers: Headers, rawBody: string) {
  const config = getConfig();
  const timestamp = headers.get("wechatpay-timestamp") || "";
  const nonce = headers.get("wechatpay-nonce") || "";
  const signatureValue = headers.get("wechatpay-signature") || "";
  const serial = headers.get("wechatpay-serial") || "";
  if (!timestamp || !nonce || !signatureValue) throw new WechatPayError("微信支付回调缺少签名信息。", 400, "MISSING_SIGNATURE");
  if (Math.abs(unixNow() - Number(timestamp)) > 300) throw new WechatPayError("微信支付回调时间已失效。", 400, "EXPIRED_NOTIFICATION");
  verifyWechatSignature(config, timestamp, nonce, rawBody, signatureValue, serial);
  const notification = JSON.parse(rawBody) as { event_type?: string; resource?: { ciphertext?: string; nonce?: string; associated_data?: string } };
  if (notification.event_type !== "TRANSACTION.SUCCESS" || !notification.resource) return null;
  const payment = decryptNotification(config, notification.resource);
  if (payment.appid !== config.appId || payment.mchid !== config.mchId || payment.trade_state !== "SUCCESS") {
    throw new WechatPayError("微信支付回调订单身份校验失败。", 400, "PAYMENT_IDENTITY_MISMATCH");
  }
  return applyPaidRecharge(
    String(payment.out_trade_no || ""),
    Number(payment.amount?.total),
    String(payment.transaction_id || ""),
    paidTimestamp(payment.success_time),
  );
}

export function wechatPayErrorResponse(error: unknown) {
  if (!(error instanceof WechatPayError)) return null;
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}
