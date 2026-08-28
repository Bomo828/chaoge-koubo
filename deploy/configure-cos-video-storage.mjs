#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) return [];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [[match[1], value]];
  }));
}

const envPath = process.argv[2] || ".env.local";
const fileEnv = await parseEnv(await readFile(envPath, "utf8"));
const env = { ...fileEnv, ...process.env };
const secretId = String(env.TENCENT_CLOUD_SECRET_ID || "").trim();
const secretKey = String(env.TENCENT_CLOUD_SECRET_KEY || "").trim();
const bucket = String(env.TENCENT_MPS_COS_BUCKET || "").trim();
const region = String(env.TENCENT_MPS_COS_REGION || "ap-guangzhou").trim();
const inputPrefix = String(env.TENCENT_MPS_INPUT_PREFIX || "ai-director/input").replace(/^\/+|\/+$/g, "");
const outputPrefix = String(env.VIDEO_WORKER_COS_OUTPUT_PREFIX || "video-worker/outputs").replace(/^\/+|\/+$/g, "");
const corsOrigins = String(env.COS_CORS_ORIGINS || "https://studio.example.com,http://127.0.0.1:3012,http://localhost:3012")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!secretId || !secretKey || !bucket || !region) throw new Error("COS 配置不完整。请检查腾讯云密钥、存储桶和地域。\n");
const hasInvalidCorsOrigin = corsOrigins.some((origin) => {
  try {
    const parsed = new URL(origin);
    return !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin;
  } catch {
    return true;
  }
});
if (!corsOrigins.length || hasInvalidCorsOrigin) {
  throw new Error("COS_CORS_ORIGINS 必须是逗号分隔的 HTTP/HTTPS Origin，且不能包含路径。\n");
}

const host = `${bucket}.cos.${region}.myqcloud.com`;
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

function authorization(method, query, headers, expiresIn = 600) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${Math.max(0, now - 60)};${now + expiresIn}`;
  const normalizedHeaders = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()]).sort(([left], [right]) => left.localeCompare(right));
  const normalizedQuery = Object.entries(query).map(([key, value]) => [key.toLowerCase(), String(value)]).sort(([left], [right]) => left.localeCompare(right));
  const headerList = normalizedHeaders.map(([key]) => key).join(";");
  const queryList = normalizedQuery.map(([key]) => key).join(";");
  const headerString = normalizedHeaders.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const queryString = normalizedQuery.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const httpString = `${method.toLowerCase()}\n/\n${queryString}\n${headerString}\n`;
  const signKey = createHmac("sha1", secretKey).update(keyTime).digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return `q-sign-algorithm=sha1&q-ak=${encode(secretId)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${queryList}&q-signature=${signature}`;
}

async function getConfig(name) {
  const query = { [name]: "" };
  const response = await fetch(`https://${host}/?${name}`, {
    headers: { Host: host, Authorization: authorization("GET", query, { host }) },
  });
  const body = await response.text();
  if (response.status === 404) return "";
  if (!response.ok) throw new Error(`读取 COS ${name} 配置失败（${response.status}）：${body.slice(0, 300)}`);
  return body;
}

async function putConfig(name, xml) {
  const query = { [name]: "" };
  const contentMd5 = createHash("md5").update(xml).digest("base64");
  const contentType = "application/xml";
  const headers = { host, "content-md5": contentMd5, "content-type": contentType };
  const response = await fetch(`https://${host}/?${name}`, {
    method: "PUT",
    headers: {
      Host: host,
      "Content-MD5": contentMd5,
      "Content-Type": contentType,
      Authorization: authorization("PUT", query, headers),
    },
    body: xml,
  });
  const detail = await response.text();
  if (!response.ok) throw new Error(`保存 COS ${name} 配置失败（${response.status}）：${detail.slice(0, 300)}`);
}

function appendRule(current, root, rule) {
  if (!current.trim()) return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>${rule}</${root}>`;
  const close = `</${root}>`;
  if (!current.includes(close)) throw new Error(`COS 返回的 ${root} XML 无法识别。`);
  return current.replace(close, `${rule}${close}`);
}

const corsRuleId = "merchant-studio-direct-upload-v1";
let cors = await getConfig("cors");
if (!cors.includes(`<ID>${corsRuleId}</ID>`)) {
  const allowedOrigins = corsOrigins.map((origin) => `<AllowedOrigin>${origin}</AllowedOrigin>`).join("");
  const rule = `<CORSRule><ID>${corsRuleId}</ID>${allowedOrigins}<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>`;
  cors = appendRule(cors, "CORSConfiguration", rule);
  await putConfig("cors", cors);
}

const lifecycleRules = [
  {
    id: "merchant-studio-viral-input-expire-v1",
    prefix: `${inputPrefix}/viral/`,
    days: 1,
  },
  {
    id: "merchant-studio-video-output-expire-v1",
    prefix: `${outputPrefix}/`,
    days: 8,
  },
];
let lifecycle = await getConfig("lifecycle");
for (const item of lifecycleRules) {
  if (lifecycle.includes(`<ID>${item.id}</ID>`)) continue;
  const rule = `<Rule><ID>${item.id}</ID><Filter><Prefix>${item.prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>${item.days}</Days></Expiration><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`;
  lifecycle = appendRule(lifecycle, "LifecycleConfiguration", rule);
}
await putConfig("lifecycle", lifecycle);

console.log(JSON.stringify({ ok: true, bucket, region, corsRuleId, lifecycleRules: lifecycleRules.map((item) => item.id) }));
