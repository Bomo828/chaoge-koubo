import { createHash, createHmac } from "node:crypto";

const MPS_HOST = "mps.tencentcloudapi.com";
const MPS_VERSION = "2019-06-12";

type TencentMpsConfig = {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  inputPrefix: string;
  outputPrefix: string;
};

function cleanPrefix(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replace(/^\/+|\/+$/g, "");
}

export function getTencentMpsConfig(): TencentMpsConfig {
  return {
    secretId: process.env.TENCENT_CLOUD_SECRET_ID?.trim() || "",
    secretKey: process.env.TENCENT_CLOUD_SECRET_KEY?.trim() || "",
    bucket: process.env.TENCENT_MPS_COS_BUCKET?.trim() || "",
    region: process.env.TENCENT_MPS_COS_REGION?.trim() || "ap-guangzhou",
    inputPrefix: cleanPrefix(process.env.TENCENT_MPS_INPUT_PREFIX, "ai-director/input"),
    outputPrefix: cleanPrefix(process.env.TENCENT_MPS_OUTPUT_PREFIX, "ai-director/output"),
  };
}

export function tencentMpsConfigStatus() {
  const config = getTencentMpsConfig();
  const fields = [
    ["TENCENT_CLOUD_SECRET_ID", config.secretId],
    ["TENCENT_CLOUD_SECRET_KEY", config.secretKey],
    ["TENCENT_MPS_COS_BUCKET", config.bucket],
    ["TENCENT_MPS_COS_REGION", config.region],
  ] as const;
  const missing = fields.filter(([, value]) => !value).map(([name]) => name);
  return { configured: missing.length === 0, missing, bucket: config.bucket, region: config.region };
}

function requireConfig() {
  const status = tencentMpsConfigStatus();
  if (!status.configured) throw new Error(`腾讯云 MPS 尚未配置：${status.missing.join("、")}`);
  return getTencentMpsConfig();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

export async function callTencentMps<T>(action: string, payload: Record<string, unknown>) {
  const config = requireConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${MPS_HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256(body)].join("\n");
  const credentialScope = `${date}/mps/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, credentialScope, sha256(canonicalRequest)].join("\n");
  const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
  const secretService = hmacSha256(secretDate, "mps");
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${MPS_HOST}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json; charset=utf-8", Host: MPS_HOST, "X-TC-Action": action, "X-TC-Timestamp": String(timestamp), "X-TC-Version": MPS_VERSION },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({})) as { Response?: T & { Error?: { Code?: string; Message?: string } } };
  const result = data.Response;
  if (!response.ok || !result || result.Error) throw new Error(result?.Error?.Message || `腾讯云 MPS 请求失败（${response.status}）`);
  return result;
}

function encodeCosPath(objectKey: string) {
  return `/${objectKey.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`;
}

function encodeCosValue(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizedCosParameters(parameters: Record<string, string>) {
  return Object.entries(parameters)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function cosAuthorization(method: string, pathname: string, headers: Record<string, string>, expiresIn = 3600, parameters: Record<string, string> = {}) {
  const config = requireConfig();
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${Math.max(0, now - 60)};${now + expiresIn}`;
  const normalized = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()] as const).sort(([left], [right]) => left.localeCompare(right));
  const normalizedParameters = normalizedCosParameters(parameters);
  const headerList = normalized.map(([key]) => key).join(";");
  const parameterList = normalizedParameters.map(([key]) => key).join(";");
  const httpHeaders = normalized.map(([key, value]) => `${encodeCosValue(key)}=${encodeCosValue(value)}`).join("&");
  const httpParameters = normalizedParameters.map(([key, value]) => `${encodeCosValue(key)}=${encodeCosValue(value)}`).join("&");
  const httpString = `${method.toLowerCase()}\n${pathname}\n${httpParameters}\n${httpHeaders}\n`;
  const signKey = createHmac("sha1", config.secretKey).update(keyTime).digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return `q-sign-algorithm=sha1&q-ak=${encodeCosValue(config.secretId)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${parameterList}&q-signature=${signature}`;
}

function cosHost(config: TencentMpsConfig) {
  return `${config.bucket}.cos.${config.region}.myqcloud.com`;
}

export function inputObjectKey(jobId: string, filename: string) {
  const config = requireConfig();
  return `${config.inputPrefix}/${jobId}/${filename.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

export function viralSourceObjectKey(memberId: string, uploadId: string, filename: string) {
  const config = requireConfig();
  const day = new Date().toISOString().slice(0, 10);
  const safeMember = memberId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "member";
  const safeUpload = uploadId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "upload";
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-160) || "source.mp4";
  return `${config.inputPrefix}/viral/${day}/${safeMember}/${safeUpload}-${safeFilename}`;
}

export function outputObjectKey(jobId: string) {
  const config = requireConfig();
  return `${config.outputPrefix}/${jobId}/clean.mp4`;
}

export function cosInputInfo(objectKey: string) {
  const config = requireConfig();
  return { Type: "COS", CosInputInfo: { Bucket: config.bucket, Region: config.region, Object: `/${objectKey.replace(/^\/+/, "")}` } };
}

export function cosOutputStorage() {
  const config = requireConfig();
  return { Type: "COS", CosOutputStorage: { Bucket: config.bucket, Region: config.region } };
}

export async function putCosObject(objectKey: string, bytes: Buffer, contentType: string) {
  const config = requireConfig();
  const host = cosHost(config);
  const pathname = encodeCosPath(objectKey);
  const contentMd5 = createHash("md5").update(bytes).digest("base64");
  const signed = { host, "content-md5": contentMd5, "content-type": contentType || "application/octet-stream" };
  const body = Uint8Array.from(bytes);
  const response = await fetch(`https://${host}${pathname}`, {
    method: "PUT",
    headers: { Host: host, "Content-MD5": contentMd5, "Content-Type": signed["content-type"], Authorization: cosAuthorization("PUT", pathname, signed) },
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`素材上传腾讯云 COS 失败（${response.status}）：${detail.slice(0, 180)}`);
  }
}

export function signedCosObjectUrl(objectKey: string, expiresIn = 2 * 60 * 60, parameters: Record<string, string> = {}) {
  const config = requireConfig();
  const host = cosHost(config);
  const pathname = encodeCosPath(objectKey);
  const normalizedParameters = normalizedCosParameters(parameters);
  const requestParameters = normalizedParameters.map(([key, value]) => `${encodeCosValue(key)}=${encodeCosValue(value)}`).join("&");
  const authorization = cosAuthorization("GET", pathname, { host }, Math.max(300, Math.min(expiresIn, 24 * 60 * 60)), parameters);
  return `https://${host}${pathname}?${requestParameters ? `${requestParameters}&` : ""}${authorization}`;
}

export function signedCosUploadUrl(objectKey: string, expiresIn = 30 * 60) {
  const config = requireConfig();
  const host = cosHost(config);
  const pathname = encodeCosPath(objectKey);
  const authorization = cosAuthorization("PUT", pathname, { host }, Math.max(300, Math.min(expiresIn, 2 * 60 * 60)));
  return `https://${host}${pathname}?${authorization}`;
}

export async function deleteCosObject(objectKey: string) {
  const config = requireConfig();
  const host = cosHost(config);
  const pathname = encodeCosPath(objectKey);
  const response = await fetch(`https://${host}${pathname}`, {
    method: "DELETE",
    headers: { Host: host, Authorization: cosAuthorization("DELETE", pathname, { host }, 600) },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(`删除腾讯云 COS 文件失败（${response.status}）：${detail.slice(0, 180)}`);
  }
}

export async function getCosObject(objectKey: string, range = "") {
  const config = requireConfig();
  const host = cosHost(config);
  const pathname = encodeCosPath(objectKey);
  const signedHeaders: Record<string, string> = { host };
  if (range) signedHeaders.range = range;
  return fetch(`https://${host}${pathname}`, {
    headers: { Host: host, ...(range ? { Range: range } : {}), Authorization: cosAuthorization("GET", pathname, signedHeaders, 600) },
    signal: AbortSignal.timeout(120_000),
  });
}
