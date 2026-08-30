import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";
import { getDatabase, unixNow } from "./db";

const CREDENTIAL_SETTING_KEY = "ai_provider_credentials_v1";
const DEFAULT_LK888_BASE_URL = "https://api.lk888.ai";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_CHANJING_BASE_URL = "https://open-api.chanjing.cc";
const DEFAULT_TIKHUB_BASE_URL = "https://api.tikhub.io";

type StoredLk888Credential = {
  apiKey?: string;
  baseUrl?: string;
  updatedAt: number;
  updatedBy: string;
};

type StoredDeepSeekCredential = StoredLk888Credential;

type StoredChanjingCredential = {
  appId?: string;
  secretKey?: string;
  baseUrl?: string;
  updatedAt: number;
  updatedBy: string;
};

type StoredTikHubCredential = {
  apiKey?: string;
  baseUrl?: string;
  updatedAt: number;
  updatedBy: string;
};

type StoredCredentials = {
  lk888?: StoredLk888Credential;
  deepseek?: StoredDeepSeekCredential;
  chanjing?: StoredChanjingCredential;
  tikhub?: StoredTikHubCredential;
};

export type ProviderCredentialId = "lk888" | "deepseek" | "chanjing" | "tikhub";
export type ProviderCredentialInput = {
  apiKey?: string;
  appId?: string;
  secretKey?: string;
  baseUrl?: string;
};

export type Lk888CredentialSummary = {
  configured: boolean;
  maskedKey: string;
  baseUrl: string;
  source: "admin" | "environment" | "none";
  updatedAt: number | null;
};

export type DeepSeekCredentialSummary = Lk888CredentialSummary;

export type ChanjingCredentialSummary = {
  configured: boolean;
  maskedAppId: string;
  maskedSecretKey: string;
  baseUrl: string;
  source: "admin" | "environment" | "none";
  updatedAt: number | null;
};

export type TikHubCredentialSummary = Lk888CredentialSummary;

function dataDirectory() {
  return process.env.APP_DATA_DIR?.trim() || ".data";
}

function decodeMasterKey(value: string) {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  return createHash("sha256").update(trimmed).digest();
}

function masterKey() {
  const configured = process.env.AI_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (configured) return decodeMasterKey(configured);

  const directory = dataDirectory();
  const filePath = path.join(directory, ".ai-credentials.key");
  mkdirSync(directory, { recursive: true });
  try {
    const existing = Buffer.from(readFileSync(filePath, "utf8").trim(), "base64url");
    if (existing.length === 32) return existing;
  } catch {
    // The first credential save creates a server-only key beside the database.
  }

  const generated = randomBytes(32);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, generated.toString("base64url"), { encoding: "utf8" });
    return generated;
  } catch {
    const existing = Buffer.from(readFileSync(filePath, "utf8").trim(), "base64url");
    if (existing.length !== 32) throw new Error("AI 凭证加密密钥无效，请检查服务器数据目录权限。");
    return existing;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function encryptCredentials(value: StoredCredentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptCredentials(value: string): StoredCredentials {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) return {};
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as StoredCredentials;
}

function readStoredCredentials() {
  const row = getDatabase().prepare("SELECT value_json FROM system_settings WHERE key = ? LIMIT 1")
    .get(CREDENTIAL_SETTING_KEY) as { value_json?: string } | undefined;
  if (!row?.value_json) return {} as StoredCredentials;
  try {
    return decryptCredentials(row.value_json);
  } catch (error) {
    console.error("Unable to decrypt AI provider credentials", error);
    return {} as StoredCredentials;
  }
}

function normalizeBaseUrl(value: string | undefined, fallback = DEFAULT_LK888_BASE_URL) {
  const candidate = (value || fallback).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("接口地址格式不正确，请填写完整的 HTTPS 地址。");
  }
  const localDevelopment = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const allowInsecureLoopback = localDevelopment && (
    process.env.NODE_ENV !== "production"
    || process.env.ALLOW_INSECURE_LOCAL_PROVIDER_URLS === "true"
  );
  if (parsed.protocol !== "https:" && !allowInsecureLoopback) {
    throw new Error("接口地址必须使用 HTTPS。");
  }
  if (parsed.username || parsed.password) throw new Error("接口地址不能包含账号或密码。");
  return candidate;
}

function maskKey(value: string) {
  if (!value) return "尚未配置";
  const suffix = value.slice(-4);
  return `•••• •••• ${suffix}`;
}

function providerFetchError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return new Error("接口连接超时，请稍后重试。");
  return new Error("无法连接接口地址，请检查地址或网络后重试。");
}

export function getLk888Config() {
  const stored = readStoredCredentials().lk888;
  const storedKey = stored?.apiKey?.trim() || "";
  const environmentKey = process.env.LK888_API_KEY?.trim() || "";
  return {
    apiKey: storedKey || environmentKey,
    baseUrl: normalizeBaseUrl(stored?.baseUrl || process.env.LK888_API_BASE_URL || DEFAULT_LK888_BASE_URL),
    source: storedKey ? "admin" as const : environmentKey ? "environment" as const : "none" as const,
    updatedAt: stored?.updatedAt || null,
  };
}

export function getDeepSeekConfig() {
  const stored = readStoredCredentials().deepseek;
  const storedKey = stored?.apiKey?.trim() || "";
  const environmentKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
  return {
    apiKey: storedKey || environmentKey,
    baseUrl: normalizeBaseUrl(
      stored?.baseUrl || process.env.DEEPSEEK_API_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
      DEFAULT_DEEPSEEK_BASE_URL,
    ),
    source: storedKey ? "admin" as const : environmentKey ? "environment" as const : "none" as const,
    updatedAt: stored?.updatedAt || null,
  };
}

export function getChanjingConfig() {
  const stored = readStoredCredentials().chanjing;
  const storedAppId = stored?.appId?.trim() || "";
  const storedSecretKey = stored?.secretKey?.trim() || "";
  const environmentAppId = process.env.CHANJING_APP_ID?.trim() || "";
  const environmentSecretKey = process.env.CHANJING_SECRET_KEY?.trim() || "";
  const hasStoredCredential = Boolean(storedAppId && storedSecretKey);
  const hasEnvironmentCredential = Boolean(environmentAppId && environmentSecretKey);
  return {
    appId: hasStoredCredential ? storedAppId : environmentAppId,
    secretKey: hasStoredCredential ? storedSecretKey : environmentSecretKey,
    baseUrl: normalizeBaseUrl(stored?.baseUrl || process.env.CHANJING_BASE_URL || DEFAULT_CHANJING_BASE_URL, DEFAULT_CHANJING_BASE_URL),
    source: hasStoredCredential ? "admin" as const : hasEnvironmentCredential ? "environment" as const : "none" as const,
    updatedAt: stored?.updatedAt || null,
  };
}

export function getTikHubConfig() {
  const stored = readStoredCredentials().tikhub;
  const storedKey = stored?.apiKey?.trim() || "";
  const environmentKey = process.env.TIKHUB_API_KEY?.trim() || "";
  return {
    apiKey: storedKey || environmentKey,
    baseUrl: normalizeBaseUrl(stored?.baseUrl || process.env.TIKHUB_API_BASE_URL || DEFAULT_TIKHUB_BASE_URL, DEFAULT_TIKHUB_BASE_URL),
    source: storedKey ? "admin" as const : environmentKey ? "environment" as const : "none" as const,
    updatedAt: stored?.updatedAt || null,
  };
}

export function getLk888CredentialSummary(): Lk888CredentialSummary {
  const config = getLk888Config();
  return {
    configured: Boolean(config.apiKey),
    maskedKey: maskKey(config.apiKey),
    baseUrl: config.baseUrl,
    source: config.source,
    updatedAt: config.updatedAt,
  };
}

export function getDeepSeekCredentialSummary(): DeepSeekCredentialSummary {
  const config = getDeepSeekConfig();
  return {
    configured: Boolean(config.apiKey),
    maskedKey: maskKey(config.apiKey),
    baseUrl: config.baseUrl,
    source: config.source,
    updatedAt: config.updatedAt,
  };
}

export function getChanjingCredentialSummary(): ChanjingCredentialSummary {
  const config = getChanjingConfig();
  return {
    configured: Boolean(config.appId && config.secretKey),
    maskedAppId: maskKey(config.appId),
    maskedSecretKey: maskKey(config.secretKey),
    baseUrl: config.baseUrl,
    source: config.source,
    updatedAt: config.updatedAt,
  };
}

export function getTikHubCredentialSummary(): TikHubCredentialSummary {
  const config = getTikHubConfig();
  return {
    configured: Boolean(config.apiKey),
    maskedKey: maskKey(config.apiKey),
    baseUrl: config.baseUrl,
    source: config.source,
    updatedAt: config.updatedAt,
  };
}

export async function testLk888Credentials(input: { apiKey?: string; baseUrl?: string }) {
  const current = getLk888Config();
  const apiKey = input.apiKey?.trim() || current.apiKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl);
  if (!apiKey) throw new Error("请填写 API Key 后再测试连接。");
  if (apiKey.length < 12 || /\s/.test(apiKey)) throw new Error("API Key 格式不正确，请检查后重试。");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/skills/balance`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw providerFetchError(error);
  }
  const payload = await response.json().catch(() => ({})) as {
    code?: number;
    msg?: string;
    error?: string | { message?: string };
    balance?: number;
    unit?: string;
  };
  const businessFailed = payload.code !== undefined && Number(payload.code) !== 200;
  if (!response.ok || businessFailed) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error?.message || payload.msg || `接口连接失败（${response.status}）`;
    throw new Error(message);
  }
  return {
    connected: true,
    balance: Number.isFinite(Number(payload.balance)) ? Number(payload.balance) : null,
    unit: payload.unit || "算力",
    baseUrl,
  };
}

export async function testDeepSeekCredentials(input: { apiKey?: string; baseUrl?: string }) {
  const current = getDeepSeekConfig();
  const apiKey = input.apiKey?.trim() || current.apiKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl, DEFAULT_DEEPSEEK_BASE_URL);
  if (!apiKey) throw new Error("请填写 DeepSeek API Key 后再测试连接。");
  if (apiKey.length < 12 || /\s/.test(apiKey)) throw new Error("DeepSeek API Key 格式不正确，请检查后重试。");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw providerFetchError(error);
  }
  const payload = await response.json().catch(() => ({})) as {
    data?: Array<{ id?: string }>;
    error?: string | { message?: string };
  };
  if (!response.ok) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error?.message || `DeepSeek 接口连接失败（${response.status}）`;
    throw new Error(message);
  }
  const models = Array.isArray(payload.data)
    ? payload.data.map((item) => item.id || "").filter(Boolean)
    : [];
  if (!models.includes("deepseek-v4-flash")) {
    throw new Error("DeepSeek 连接成功，但当前 Key 暂不可用 deepseek-v4-flash。");
  }
  return { connected: true, balance: null, unit: "可用", baseUrl };
}

function chanjingMessage(payload: Record<string, unknown>, fallback: string) {
  const value = typeof payload.msg === "string" ? payload.msg : typeof payload.message === "string" ? payload.message : "";
  return value.trim() || fallback;
}

export async function testChanjingCredentials(input: ProviderCredentialInput) {
  const current = getChanjingConfig();
  const appId = input.appId?.trim() || current.appId;
  const secretKey = input.secretKey?.trim() || current.secretKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl, DEFAULT_CHANJING_BASE_URL);
  if (!appId) throw new Error("请填写蝉镜 AppID 后再测试连接。");
  if (!secretKey) throw new Error("请填写蝉镜 Secret Key 后再测试连接。");
  if (/\s/.test(appId) || /\s/.test(secretKey)) throw new Error("AppID 或 Secret Key 格式不正确，请检查后重试。");

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${baseUrl}/open/v1/access_token`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, secret_key: secretKey }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw providerFetchError(error);
  }
  const tokenPayload = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok || Number(tokenPayload.code ?? 0) !== 0) {
    throw new Error(chanjingMessage(tokenPayload, `蝉镜接口连接失败（${tokenResponse.status}）`));
  }
  const tokenData = tokenPayload.data && typeof tokenPayload.data === "object" ? tokenPayload.data as Record<string, unknown> : {};
  const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  if (!accessToken) throw new Error("蝉镜接口没有返回 access_token，请检查凭证。");

  let balanceResponse: Response;
  try {
    balanceResponse = await fetch(`${baseUrl}/open/v1/user_duration`, {
      method: "GET",
      cache: "no-store",
      headers: { access_token: accessToken },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw providerFetchError(error);
  }
  const balancePayload = await balanceResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!balanceResponse.ok || Number(balancePayload.code ?? 0) !== 0) {
    throw new Error(chanjingMessage(balancePayload, `蝉镜余额读取失败（${balanceResponse.status}）`));
  }
  const balanceData = balancePayload.data && typeof balancePayload.data === "object" ? balancePayload.data as Record<string, unknown> : {};
  const balance = Number(balanceData.resi_total_bean);
  return { connected: true, balance: Number.isFinite(balance) ? balance : null, unit: "蝉豆", baseUrl };
}

export async function testTikHubCredentials(input: { apiKey?: string; baseUrl?: string }) {
  const current = getTikHubConfig();
  const apiKey = input.apiKey?.trim() || current.apiKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl, DEFAULT_TIKHUB_BASE_URL);
  if (!apiKey) throw new Error("请填写 TikHub API Key 后再测试连接。");
  if (apiKey.length < 12 || /\s/.test(apiKey)) throw new Error("TikHub API Key 格式不正确，请检查后重试。");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/tikhub/user/get_user_info`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw providerFetchError(error);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || Number(payload.code ?? 0) !== 200) {
    const message = typeof payload.message === "string"
      ? payload.message
      : typeof payload.detail === "string"
        ? payload.detail
        : `TikHub 接口连接失败（${response.status}）`;
    throw new Error(message);
  }
  const userData = payload.user_data && typeof payload.user_data === "object"
    ? payload.user_data as Record<string, unknown>
    : {};
  const paidBalance = Number(userData.balance);
  const freeCredit = Number(userData.free_credit);
  const balance = (Number.isFinite(paidBalance) ? paidBalance : 0) + (Number.isFinite(freeCredit) ? freeCredit : 0);
  return { connected: true, balance, unit: "额度", baseUrl };
}

export async function saveLk888Credentials(actorId: string, input: { apiKey?: string; baseUrl?: string }) {
  const current = getLk888Config();
  const stored = readStoredCredentials();
  const newKey = input.apiKey?.trim() || "";
  const apiKey = newKey || current.apiKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl);
  await testLk888Credentials({ apiKey, baseUrl });

  const now = unixNow();
  const next: StoredCredentials = {
    ...stored,
    lk888: {
      apiKey,
      baseUrl,
      updatedAt: now,
      updatedBy: actorId,
    },
  };
  getDatabase().prepare(`
    INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(CREDENTIAL_SETTING_KEY, encryptCredentials(next), actorId, now);
  return getLk888CredentialSummary();
}

export async function saveDeepSeekCredentials(actorId: string, input: { apiKey?: string; baseUrl?: string }) {
  const current = getDeepSeekConfig();
  const stored = readStoredCredentials();
  const apiKey = input.apiKey?.trim() || current.apiKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl, DEFAULT_DEEPSEEK_BASE_URL);
  await testDeepSeekCredentials({ apiKey, baseUrl });

  const now = unixNow();
  const next: StoredCredentials = {
    ...stored,
    deepseek: { apiKey, baseUrl, updatedAt: now, updatedBy: actorId },
  };
  getDatabase().prepare(`
    INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(CREDENTIAL_SETTING_KEY, encryptCredentials(next), actorId, now);
  return getDeepSeekCredentialSummary();
}

export async function saveChanjingCredentials(actorId: string, input: ProviderCredentialInput) {
  const current = getChanjingConfig();
  const stored = readStoredCredentials();
  const appId = input.appId?.trim() || current.appId;
  const secretKey = input.secretKey?.trim() || current.secretKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl, DEFAULT_CHANJING_BASE_URL);
  await testChanjingCredentials({ appId, secretKey, baseUrl });

  const now = unixNow();
  const next: StoredCredentials = {
    ...stored,
    chanjing: { appId, secretKey, baseUrl, updatedAt: now, updatedBy: actorId },
  };
  getDatabase().prepare(`
    INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(CREDENTIAL_SETTING_KEY, encryptCredentials(next), actorId, now);
  return getChanjingCredentialSummary();
}

export async function saveTikHubCredentials(actorId: string, input: { apiKey?: string; baseUrl?: string }) {
  const current = getTikHubConfig();
  const stored = readStoredCredentials();
  const apiKey = input.apiKey?.trim() || current.apiKey;
  const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl, DEFAULT_TIKHUB_BASE_URL);
  await testTikHubCredentials({ apiKey, baseUrl });

  const now = unixNow();
  const next: StoredCredentials = {
    ...stored,
    tikhub: { apiKey, baseUrl, updatedAt: now, updatedBy: actorId },
  };
  getDatabase().prepare(`
    INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(CREDENTIAL_SETTING_KEY, encryptCredentials(next), actorId, now);
  return getTikHubCredentialSummary();
}

export function getProviderCredentialSummary(providerId: ProviderCredentialId) {
  if (providerId === "lk888") return getLk888CredentialSummary();
  if (providerId === "deepseek") return getDeepSeekCredentialSummary();
  if (providerId === "tikhub") return getTikHubCredentialSummary();
  return getChanjingCredentialSummary();
}

export function testProviderCredentials(providerId: ProviderCredentialId, input: ProviderCredentialInput) {
  if (providerId === "lk888") return testLk888Credentials(input);
  if (providerId === "deepseek") return testDeepSeekCredentials(input);
  if (providerId === "tikhub") return testTikHubCredentials(input);
  return testChanjingCredentials(input);
}

export function saveProviderCredentials(providerId: ProviderCredentialId, actorId: string, input: ProviderCredentialInput) {
  if (providerId === "lk888") return saveLk888Credentials(actorId, input);
  if (providerId === "deepseek") return saveDeepSeekCredentials(actorId, input);
  if (providerId === "tikhub") return saveTikHubCredentials(actorId, input);
  return saveChanjingCredentials(actorId, input);
}
