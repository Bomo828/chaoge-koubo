import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDatabase, unixNow } from "./db";

const SETTING_KEY = "wechat_pay_credentials_v1";

export type WechatPayCredentialInput = {
  mchId?: string;
  appId?: string;
  apiV3Key?: string;
  certSerialNo?: string;
  privateKey?: string;
  platformPublicKey?: string;
  platformSerialNo?: string;
  notifyUrl?: string;
};

export type WechatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: string;
  serialNo: string;
  privateKey: string;
  platformKey: string;
  platformSerial: string;
  notifyUrl: string;
};

type StoredWechatPayCredentials = WechatPayCredentialInput & {
  updatedAt: number;
  updatedBy: string;
};

export type WechatPayCredentialSummary = {
  configured: boolean;
  source: "admin" | "environment" | "none";
  mchId: string;
  appId: string;
  certSerialNo: string;
  platformSerialNo: string;
  notifyUrl: string;
  hasApiV3Key: boolean;
  hasPrivateKey: boolean;
  hasPlatformPublicKey: boolean;
  updatedAt: number | null;
};

function dataDirectory() {
  return process.env.APP_DATA_DIR?.trim() || ".data";
}

function decodeMasterKey(value: string) {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  return createHash("sha256").update(trimmed).digest();
}

function masterKey() {
  const configured = process.env.WECHAT_PAY_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (configured) return decodeMasterKey(configured);
  const directory = dataDirectory();
  const filePath = path.join(directory, ".wechat-pay-credentials.key");
  mkdirSync(directory, { recursive: true });
  try {
    const existing = Buffer.from(readFileSync(filePath, "utf8").trim(), "base64url");
    if (existing.length === 32) return existing;
  } catch {
    // The first save creates a server-only encryption key beside the database.
  }
  const generated = randomBytes(32);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, generated.toString("base64url"), { encoding: "utf8" });
    return generated;
  } catch {
    const existing = Buffer.from(readFileSync(filePath, "utf8").trim(), "base64url");
    if (existing.length !== 32) throw new Error("微信支付凭证加密密钥无效，请检查服务器数据目录权限。");
    return existing;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function encryptCredentials(value: StoredWechatPayCredentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptCredentials(value: string): StoredWechatPayCredentials | null {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) return null;
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8")) as StoredWechatPayCredentials;
}

function readStoredCredentials() {
  const row = getDatabase().prepare("SELECT value_json FROM system_settings WHERE key = ? LIMIT 1")
    .get(SETTING_KEY) as { value_json?: string } | undefined;
  if (!row?.value_json) return null;
  try {
    return decryptCredentials(row.value_json);
  } catch (error) {
    console.error("Unable to decrypt WeChat Pay credentials", error);
    return null;
  }
}

function secretValue(valueName: string, pathName: string) {
  const inline = process.env[valueName]?.trim();
  if (inline) return inline.replace(/\\n/g, "\n");
  const filePath = process.env[pathName]?.trim();
  if (filePath && existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
  return "";
}

function environmentCredentials(): StoredWechatPayCredentials {
  return {
    mchId: process.env.WECHAT_PAY_MCH_ID?.trim() || "",
    appId: process.env.WECHAT_PAY_APP_ID?.trim() || "",
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY?.trim() || "",
    certSerialNo: process.env.WECHAT_PAY_CERT_SERIAL_NO?.trim() || "",
    privateKey: secretValue("WECHAT_PAY_PRIVATE_KEY", "WECHAT_PAY_PRIVATE_KEY_PATH"),
    platformPublicKey: secretValue("WECHAT_PAY_PLATFORM_PUBLIC_KEY", "WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH")
      || secretValue("WECHAT_PAY_PLATFORM_CERT", "WECHAT_PAY_PLATFORM_CERT_PATH"),
    platformSerialNo: process.env.WECHAT_PAY_PLATFORM_SERIAL_NO?.trim() || "",
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL?.trim() || "",
    updatedAt: 0,
    updatedBy: "environment",
  };
}

function cleanPem(value: string | undefined) {
  return (value || "").trim().replace(/\\n/g, "\n");
}

export function resolveWechatPayCredentials(input: WechatPayCredentialInput = {}) {
  const stored = readStoredCredentials();
  const environment = environmentCredentials();
  const current = stored || environment;
  return {
    mchId: input.mchId?.trim() || current.mchId?.trim() || "",
    appId: input.appId?.trim() || current.appId?.trim() || "",
    apiV3Key: input.apiV3Key?.trim() || current.apiV3Key?.trim() || "",
    certSerialNo: input.certSerialNo?.trim().toUpperCase() || current.certSerialNo?.trim().toUpperCase() || "",
    privateKey: cleanPem(input.privateKey) || cleanPem(current.privateKey),
    platformPublicKey: cleanPem(input.platformPublicKey) || cleanPem(current.platformPublicKey),
    platformSerialNo: input.platformSerialNo?.trim() || current.platformSerialNo?.trim() || "",
    notifyUrl: input.notifyUrl?.trim() || current.notifyUrl?.trim() || "",
    updatedAt: stored?.updatedAt || null,
    source: stored ? "admin" as const : isComplete(environment) ? "environment" as const : "none" as const,
  };
}

function isComplete(value: WechatPayCredentialInput) {
  return Boolean(value.mchId && value.appId && value.apiV3Key && value.certSerialNo
    && value.privateKey && value.platformPublicKey && value.notifyUrl);
}

export function validateWechatPayCredentials(input: WechatPayCredentialInput = {}) {
  const value = resolveWechatPayCredentials(input);
  if (!/^\d{6,32}$/.test(value.mchId)) throw new Error("微信支付商户号格式不正确。");
  if (!/^wx[a-zA-Z0-9]{8,40}$/.test(value.appId)) throw new Error("AppID 格式不正确，应以 wx 开头。");
  if (Buffer.byteLength(value.apiV3Key, "utf8") !== 32 || /\s/.test(value.apiV3Key)) {
    throw new Error("APIv3 密钥必须正好为 32 个字符，且不能包含空格或换行。");
  }
  if (!/^[A-F0-9]{16,128}$/.test(value.certSerialNo)) throw new Error("商户 API 证书序列号格式不正确。");
  if (!value.platformSerialNo) throw new Error("请填写微信支付公钥编号。");
  try { createPrivateKey(value.privateKey); } catch { throw new Error("商户私钥无法读取，请粘贴完整 PEM 私钥。"); }
  try { createPublicKey(value.platformPublicKey); } catch { throw new Error("微信支付公钥无法读取，请粘贴完整 PEM 公钥。"); }
  let notifyUrl: URL;
  try { notifyUrl = new URL(value.notifyUrl); } catch { throw new Error("支付回调地址格式不正确。"); }
  if (notifyUrl.protocol !== "https:" || notifyUrl.username || notifyUrl.password || notifyUrl.hash) {
    throw new Error("支付回调地址必须是安全的 HTTPS 地址。");
  }
  return value;
}

export function getWechatPayConfig(): WechatPayConfig {
  const value = validateWechatPayCredentials();
  return {
    mchId: value.mchId,
    appId: value.appId,
    apiV3Key: value.apiV3Key,
    serialNo: value.certSerialNo,
    privateKey: value.privateKey,
    platformKey: value.platformPublicKey,
    platformSerial: value.platformSerialNo,
    notifyUrl: value.notifyUrl,
  };
}

export function wechatPayMissingCredentialNames() {
  const value = resolveWechatPayCredentials();
  const checks = [
    ["商户号", value.mchId], ["AppID", value.appId], ["APIv3 密钥", value.apiV3Key],
    ["商户证书序列号", value.certSerialNo], ["商户私钥", value.privateKey],
    ["微信支付公钥", value.platformPublicKey], ["微信支付公钥编号", value.platformSerialNo],
    ["支付回调地址", value.notifyUrl],
  ] as const;
  return checks.filter(([, configured]) => !configured).map(([name]) => name);
}

export function getWechatPayCredentialSummary(): WechatPayCredentialSummary {
  const value = resolveWechatPayCredentials();
  return {
    configured: isComplete(value) && Boolean(value.platformSerialNo),
    source: value.source,
    mchId: value.mchId,
    appId: value.appId,
    certSerialNo: value.certSerialNo,
    platformSerialNo: value.platformSerialNo,
    notifyUrl: value.notifyUrl,
    hasApiV3Key: Boolean(value.apiV3Key),
    hasPrivateKey: Boolean(value.privateKey),
    hasPlatformPublicKey: Boolean(value.platformPublicKey),
    updatedAt: value.updatedAt,
  };
}

export function saveWechatPayCredentials(actorId: string, input: WechatPayCredentialInput) {
  const value = validateWechatPayCredentials(input);
  const now = unixNow();
  const stored: StoredWechatPayCredentials = {
    mchId: value.mchId,
    appId: value.appId,
    apiV3Key: value.apiV3Key,
    certSerialNo: value.certSerialNo,
    privateKey: value.privateKey,
    platformPublicKey: value.platformPublicKey,
    platformSerialNo: value.platformSerialNo,
    notifyUrl: value.notifyUrl,
    updatedAt: now,
    updatedBy: actorId,
  };
  getDatabase().prepare(`
    INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(SETTING_KEY, encryptCredentials(stored), actorId, now);
  return getWechatPayCredentialSummary();
}

export function importEnvironmentWechatPayCredentials() {
  if (readStoredCredentials()) return false;
  const environment = environmentCredentials();
  if (!isComplete(environment) || !environment.platformSerialNo) return false;
  saveWechatPayCredentials("environment-bootstrap", environment);
  return true;
}
