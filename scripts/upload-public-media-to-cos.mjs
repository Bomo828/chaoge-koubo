#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const bucket = process.env.TENCENT_MPS_COS_BUCKET?.trim();
const region = process.env.TENCENT_MPS_COS_REGION?.trim() || "ap-guangzhou";
const secretId = process.env.TENCENT_CLOUD_SECRET_ID?.trim();
const secretKey = process.env.TENCENT_CLOUD_SECRET_KEY?.trim();
const mainAccountUin = process.env.TENCENT_MAIN_ACCOUNT_UIN?.trim();
const authorizeCdn = process.argv.includes("--authorize-cdn");
const sourceRoot = path.resolve(process.argv[2] || "public");
const uploadFolders = (process.argv.slice(3).length ? process.argv.slice(3) : ["media", "template-covers"])
  .filter((value) => !value.startsWith("--"))
  .map((value) => value.replace(/^\/+|\/+$/g, ""));

for (const [name, value] of Object.entries({
  TENCENT_MPS_COS_BUCKET: bucket,
  TENCENT_CLOUD_SECRET_ID: secretId,
  TENCENT_CLOUD_SECRET_KEY: secretKey,
})) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

const mimeTypes = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"],
  [".webp", "image/webp"], [".gif", "image/gif"], [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"], [".webm", "video/webm"], [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"], [".json", "application/json"], [".css", "text/css"],
  [".js", "text/javascript"], [".woff2", "font/woff2"], [".woff", "font/woff"],
]);

const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (value) => `/${value.replace(/^\/+/, "").split("/").map(encode).join("/")}`;

function authorization(method, pathname, headers, query = {}, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${Math.max(0, now - 60)};${now + expiresIn}`;
  const normalized = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  const headerList = normalized.map(([key]) => key).join(";");
  const httpHeaders = normalized.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const normalizedQuery = Object.entries(query)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  const parameterList = normalizedQuery.map(([key]) => key).join(";");
  const httpParameters = normalizedQuery.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const httpString = `${method.toLowerCase()}\n${pathname}\n${httpParameters}\n${httpHeaders}\n`;
  const signKey = crypto.createHmac("sha1", secretKey).update(keyTime).digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${crypto.createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = crypto.createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return `q-sign-algorithm=sha1&q-ak=${encode(secretId)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${parameterList}&q-signature=${signature}`;
}

async function readBucketPolicy(host) {
  const headers = { host };
  const response = await fetch(`https://${host}/?policy`, {
    headers: { Host: host, Authorization: authorization("GET", "/", headers, { policy: "" }) },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return { version: "2.0", Statement: [] };
  if (!response.ok) throw new Error(`COS policy read failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  return response.json();
}

async function authorizeCdnService() {
  if (!mainAccountUin) throw new Error("Missing required environment variable: TENCENT_MAIN_ACCOUNT_UIN");
  const appId = bucket.match(/-(\d+)$/)?.[1];
  if (!appId) throw new Error("Unable to read APPID from the COS bucket name.");
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const current = await readBucketPolicy(host);
  const existingStatements = Array.isArray(current.Statement)
    ? current.Statement
    : Array.isArray(current.statement) ? current.statement : [];
  const statements = existingStatements.filter((statement) => statement?.Sid !== "CDNServiceAccessPublicMedia");
  statements.push({
    Sid: "CDNServiceAccessPublicMedia",
    Principal: { qcs: [`qcs::cam::uin/${mainAccountUin}:service/cdn`] },
    Effect: "allow",
    Action: ["name/cos:GetObject", "name/cos:HeadObject", "name/cos:OptionsObject"],
    Resource: [`qcs::cos:${region}:uid/${appId}:${bucket}/public/*`],
  });
  const body = Buffer.from(JSON.stringify({ version: current.version || current.Version || "2.0", Statement: statements }));
  const contentMd5 = crypto.createHash("md5").update(body).digest("base64");
  const contentType = "application/json";
  const signedHeaders = { host, "content-md5": contentMd5, "content-type": contentType };
  const response = await fetch(`https://${host}/?policy`, {
    method: "PUT",
    headers: {
      Host: host,
      "Content-MD5": contentMd5,
      "Content-Type": contentType,
      Authorization: authorization("PUT", "/", signedHeaders, { policy: "" }),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`COS policy update failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  console.log(JSON.stringify({ result: "cdn-service-authorized", prefix: "public/" }, null, 2));
}

async function filesUnder(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function uploadFile(filename) {
  const relative = path.relative(sourceRoot, filename).split(path.sep).join("/");
  const objectKey = `public/${relative}`;
  const pathname = encodePath(objectKey);
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const bytes = await fs.readFile(filename);
  const contentType = mimeTypes.get(path.extname(filename).toLowerCase()) || "application/octet-stream";
  const contentMd5 = crypto.createHash("md5").update(bytes).digest("base64");
  const cacheControl = "public, max-age=31536000, immutable";
  const signedHeaders = { host, "content-md5": contentMd5, "content-type": contentType, "cache-control": cacheControl };
  const response = await fetch(`https://${host}${pathname}`, {
    method: "PUT",
    headers: {
      Host: host,
      "Content-MD5": contentMd5,
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      Authorization: authorization("PUT", pathname, signedHeaders),
    },
    body: bytes,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`COS upload failed for ${relative} (${response.status}): ${detail.slice(0, 240)}`);
  }
  return { relative, bytes: bytes.length };
}

if (authorizeCdn) {
  await authorizeCdnService();
  process.exit(0);
}

const files = [];
for (const folder of uploadFolders) files.push(...await filesUnder(path.join(sourceRoot, folder)));

let uploadedBytes = 0;
for (const filename of files) {
  const result = await uploadFile(filename);
  uploadedBytes += result.bytes;
  console.log(`UPLOADED ${result.relative}`);
}

console.log(JSON.stringify({ result: "completed", files: files.length, bytes: uploadedBytes, prefix: "public/" }, null, 2));
