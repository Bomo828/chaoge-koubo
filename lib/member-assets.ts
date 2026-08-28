import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MemberSession } from "../app/member-session";
import { getDatabase, parseJson, unixNow } from "./server/db";
import { deleteCosObject, getCosObject, signedCosObjectUrl } from "./server/tencent-mps";
import type { ViralWorkflowManifest } from "./viral-workflow";
import { sanitizeViralWorkflowManifest } from "./viral-workflow";

export type MemberAssetRow = {
  id: string;
  member_id: string;
  project_name: string;
  kind: "image" | "video" | "audio" | "voice";
  name: string;
  storage_provider: "local" | "cos";
  object_key: string;
  content_type: string;
  size_bytes: number;
  source_task_id: string | null;
  cover_object_key: string | null;
  cover_content_type: string | null;
  viral_workflow: ViralWorkflowManifest | null;
  created_at: number;
  expires_at: number | null;
};

type AssetDbRow = {
  id: string;
  owner_id: string;
  kind: MemberAssetRow["kind"];
  name: string;
  storage_provider: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  metadata_json: string;
  created_at: number;
  expires_at: number | null;
};

const ASSET_RETENTION_SECONDS = {
  image: 30 * 24 * 60 * 60,
  video: 7 * 24 * 60 * 60,
} as const;

function dataDirectory() {
  return process.env.APP_DATA_DIR?.trim() || ".data";
}

function assetDirectory() {
  const directory = path.resolve(dataDirectory(), "member-assets");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function absoluteObjectPath(objectKey: string) {
  const base = assetDirectory();
  const resolved = path.resolve(base, objectKey);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error("资产路径无效。");
  return resolved;
}

function mapRow(row: AssetDbRow): MemberAssetRow {
  const metadata = parseJson<{
    projectName?: string;
    sourceTaskId?: string | null;
    coverObjectKey?: string | null;
    coverContentType?: string | null;
    viralWorkflow?: unknown;
  }>(row.metadata_json, {});
  return {
    id: row.id,
    member_id: row.owner_id,
    project_name: metadata.projectName || "未命名项目",
    kind: row.kind,
    name: row.name,
    storage_provider: row.storage_provider === "cos" ? "cos" : "local",
    object_key: row.object_key,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    source_task_id: metadata.sourceTaskId || null,
    cover_object_key: metadata.coverObjectKey || null,
    cover_content_type: metadata.coverContentType || null,
    viral_workflow: sanitizeViralWorkflowManifest(metadata.viralWorkflow),
    created_at: Number(row.created_at),
    expires_at: row.expires_at === null ? null : Number(row.expires_at),
  };
}

function retentionExpiry(kind: MemberAssetRow["kind"], createdAt: number) {
  if (kind !== "image" && kind !== "video") return null;
  return createdAt + ASSET_RETENTION_SECONDS[kind];
}

function extensionFor(contentType: string, kind: MemberAssetRow["kind"]) {
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("quicktime")) return "mov";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  return kind === "image" ? "png" : kind === "video" ? "mp4" : "bin";
}

function getAssetRow(memberId: string, id: string) {
  return getDatabase().prepare(`
    SELECT id, owner_id, kind, name, storage_provider, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
    FROM assets WHERE id = ? AND owner_id = ? LIMIT 1
  `).get(id, memberId) as AssetDbRow | undefined;
}

function removeAssetFiles(row: AssetDbRow) {
  if (row.storage_provider === "cos") return;
  const filename = absoluteObjectPath(row.object_key);
  if (existsSync(filename)) unlinkSync(filename);
  const asset = mapRow(row);
  if (asset.cover_object_key) {
    const coverFilename = absoluteObjectPath(asset.cover_object_key);
    if (existsSync(coverFilename)) unlinkSync(coverFilename);
  }
}

export async function purgeExpiredMemberAssets(memberId?: string) {
  const now = unixNow();
  const database = getDatabase();
  const rows = (memberId
    ? database.prepare(`
        SELECT id, owner_id, kind, name, storage_provider, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
        FROM assets WHERE owner_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(memberId, now)
    : database.prepare(`
        SELECT id, owner_id, kind, name, storage_provider, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
        FROM assets WHERE expires_at IS NOT NULL AND expires_at <= ?
      `).all(now)) as AssetDbRow[];

  for (const row of rows) {
    try {
      if (row.storage_provider === "cos") {
        await deleteCosObject(row.object_key);
        const asset = mapRow(row);
        if (asset.cover_object_key) await deleteCosObject(asset.cover_object_key);
      } else {
        removeAssetFiles(row);
      }
      database.prepare("DELETE FROM assets WHERE id = ? AND expires_at IS NOT NULL AND expires_at <= ?").run(row.id, now);
    } catch (error) {
      console.error(`Purge expired member asset failed: ${row.id}`, error);
    }
  }
  return rows.length;
}

function getActiveAssetRow(memberId: string, id: string) {
  const source = getAssetRow(memberId, id);
  if (!source) return undefined;
  if (source.expires_at !== null && Number(source.expires_at) <= unixNow()) {
    try {
      removeAssetFiles(source);
      getDatabase().prepare("DELETE FROM assets WHERE id = ? AND owner_id = ?").run(id, memberId);
    } catch (error) {
      console.error(`Remove expired member asset failed: ${id}`, error);
    }
    return undefined;
  }
  return source;
}

export async function listMemberAssets(member: MemberSession) {
  await purgeExpiredMemberAssets(member.id);
  const rows = getDatabase().prepare(`
    SELECT id, owner_id, kind, name, storage_provider, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
    FROM assets
    WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC LIMIT 300
  `).all(member.id, unixNow()) as AssetDbRow[];
  return rows.map(mapRow);
}

export async function getMemberAsset(member: MemberSession, id: string, rangeHeader = "") {
  const source = getActiveAssetRow(member.id, id);
  if (!source) return null;
  const row = mapRow(source);
  if (row.storage_provider === "cos") {
    const response = await getCosObject(row.object_key, rangeHeader);
    if (!response.ok || !response.body) return null;
    const contentRange = response.headers.get("content-range") || "";
    const rangeMatch = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
    const range = rangeMatch
      ? { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]), total: Number(rangeMatch[3]) }
      : null;
    const size = Number(response.headers.get("content-length") || 0) || (range ? range.end - range.start + 1 : row.size_bytes);
    return {
      row,
      object: {
        body: response.body,
        size,
        range,
        httpMetadata: { contentType: response.headers.get("content-type") || row.content_type },
      },
    };
  }
  const filename = absoluteObjectPath(row.object_key);
  if (!existsSync(filename)) return null;
  const stat = statSync(filename);
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  let range: { start: number; end: number; total: number } | null = null;
  if (match && stat.size > 0) {
    const requestedStart = match[1] ? Number(match[1]) : Number.NaN;
    const requestedEnd = match[2] ? Number(match[2]) : Number.NaN;
    if (Number.isFinite(requestedStart)) {
      const start = Math.max(0, Math.min(stat.size - 1, requestedStart));
      const end = Number.isFinite(requestedEnd) ? Math.max(start, Math.min(stat.size - 1, requestedEnd)) : stat.size - 1;
      range = { start, end, total: stat.size };
    } else if (Number.isFinite(requestedEnd) && requestedEnd > 0) {
      const length = Math.min(stat.size, requestedEnd);
      range = { start: stat.size - length, end: stat.size - 1, total: stat.size };
    }
  }
  return {
    row,
    object: {
      body: Readable.toWeb(createReadStream(filename, range ? { start: range.start, end: range.end } : undefined)) as ReadableStream<Uint8Array>,
      size: range ? range.end - range.start + 1 : stat.size,
      range,
      httpMetadata: { contentType: row.content_type },
    },
  };
}

export async function getMemberAssetCover(member: MemberSession, id: string) {
  const source = getActiveAssetRow(member.id, id);
  if (!source) return null;
  const row = mapRow(source);
  if (!row.cover_object_key) return null;
  if (row.storage_provider === "cos") {
    const response = await getCosObject(row.cover_object_key);
    if (!response.ok || !response.body) return null;
    return {
      body: response.body,
      size: Number(response.headers.get("content-length") || 0),
      contentType: response.headers.get("content-type") || row.cover_content_type || "image/jpeg",
    };
  }
  const filename = absoluteObjectPath(row.cover_object_key);
  if (!existsSync(filename)) return null;
  const stat = statSync(filename);
  return {
    body: Readable.toWeb(createReadStream(filename)) as ReadableStream<Uint8Array>,
    size: stat.size,
    contentType: row.cover_content_type || "image/jpeg",
  };
}

function insertAsset(member: MemberSession, input: {
  id: string;
  projectName: string;
  kind: MemberAssetRow["kind"];
  name: string;
  storageProvider?: "local" | "cos";
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sourceTaskId?: string | null;
  coverObjectKey?: string | null;
  coverContentType?: string | null;
  viralWorkflow?: ViralWorkflowManifest | null;
  createdAt?: number;
}) {
  const now = unixNow();
  const rawCreatedAt = Number(input.createdAt);
  const createdAt = Number.isFinite(rawCreatedAt)
    ? Math.floor(rawCreatedAt / (rawCreatedAt > 10_000_000_000 ? 1000 : 1))
    : now;
  const expiresAt = retentionExpiry(input.kind, createdAt);
  getDatabase().prepare(`
    INSERT OR IGNORE INTO assets
      (id, owner_id, kind, name, storage_provider, object_key, content_type, size_bytes, metadata_json, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    member.id,
    input.kind,
    input.name,
    input.storageProvider || "local",
    input.objectKey,
    input.contentType,
    input.sizeBytes,
    JSON.stringify({
      projectName: input.projectName,
      sourceTaskId: input.sourceTaskId || null,
      coverObjectKey: input.coverObjectKey || null,
      coverContentType: input.coverContentType || null,
      viralWorkflow: sanitizeViralWorkflowManifest(input.viralWorkflow),
    }),
    createdAt,
    now,
    expiresAt,
  );
  const saved = getAssetRow(member.id, input.id);
  return saved ? mapRow(saved) : null;
}

export async function saveCosMemberAsset(member: MemberSession, input: {
  id: string;
  projectName: string;
  kind: MemberAssetRow["kind"];
  name: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sourceTaskId?: string | null;
  coverObjectKey?: string | null;
  coverContentType?: string | null;
  viralWorkflow?: ViralWorkflowManifest | null;
  createdAt?: number;
}) {
  const existing = getActiveAssetRow(member.id, input.id);
  if (existing) return mapRow(existing);
  return insertAsset(member, {
    ...input,
    storageProvider: "cos",
  });
}

function safeDownloadFilename(row: MemberAssetRow) {
  const safeName = row.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 140) || "会员资产";
  return /\.[a-z0-9]{2,5}$/i.test(safeName) ? safeName : `${safeName}.${extensionFor(row.content_type, row.kind)}`;
}

export function getMemberAssetDirectUrl(member: MemberSession, id: string, cover = false, download = false) {
  const source = getActiveAssetRow(member.id, id);
  if (!source || source.storage_provider !== "cos") return "";
  const row = mapRow(source);
  const objectKey = cover ? row.cover_object_key : row.object_key;
  if (!objectKey) return "";
  const parameters: Record<string, string> = download
    ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadFilename(row))}` }
    : {};
  // 播放需要覆盖一次正常观看；下载链接更短，封面则允许更长的私有缓存。
  const expiresIn = download ? 15 * 60 : cover ? 4 * 60 * 60 : 60 * 60;
  return signedCosObjectUrl(objectKey, expiresIn, parameters);
}

export async function saveMemberAsset(member: MemberSession, input: {
  id: string;
  projectName: string;
  kind: MemberAssetRow["kind"];
  name: string;
  sourceUrl: string;
  coverUrl?: string;
  sourceTaskId?: string | null;
  createdAt?: number;
  viralWorkflow?: ViralWorkflowManifest | null;
}) {
  const existing = getActiveAssetRow(member.id, input.id);
  if (existing) return mapRow(existing);
  const source = await fetch(input.sourceUrl);
  if (!source.ok || !source.body) throw new Error("生成文件暂时无法保存，请稍后在资产空间重试同步。");
  const contentType = source.headers.get("content-type") || (input.kind === "video" ? "video/mp4" : input.kind === "audio" ? "audio/mpeg" : "image/png");
  const objectKey = path.join(member.id, input.kind, `${input.id}.${extensionFor(contentType, input.kind)}`);
  const filename = absoluteObjectPath(objectKey);
  mkdirSync(path.dirname(filename), { recursive: true });
  await pipeline(Readable.fromWeb(source.body as never), createWriteStream(filename));
  const sizeBytes = statSync(filename).size;
  let coverObjectKey: string | null = null;
  let coverContentType: string | null = null;
  if (input.kind === "video" && input.coverUrl) {
    const coverSource = await fetch(input.coverUrl);
    if (coverSource.ok && coverSource.body) {
      coverContentType = coverSource.headers.get("content-type") || "image/jpeg";
      coverObjectKey = path.join(member.id, input.kind, `${input.id}-cover.${extensionFor(coverContentType, "image")}`);
      const coverFilename = absoluteObjectPath(coverObjectKey);
      mkdirSync(path.dirname(coverFilename), { recursive: true });
      await pipeline(Readable.fromWeb(coverSource.body as never), createWriteStream(coverFilename));
    }
  }
  return insertAsset(member, {
    ...input,
    objectKey,
    contentType,
    sizeBytes,
    coverObjectKey,
    coverContentType,
  });
}

export async function saveUploadedMemberAsset(member: MemberSession, input: {
  id: string;
  projectName: string;
  kind: MemberAssetRow["kind"];
  name: string;
  contentType: string;
  data: ArrayBuffer;
  coverData?: ArrayBuffer | null;
  coverContentType?: string | null;
  sourceTaskId?: string | null;
  createdAt?: number;
  viralWorkflow?: ViralWorkflowManifest | null;
}) {
  const existing = getActiveAssetRow(member.id, input.id);
  if (existing) return mapRow(existing);
  const contentType = input.contentType || (input.kind === "video" ? "video/webm" : "application/octet-stream");
  const objectKey = path.join(member.id, input.kind, `${input.id}.${extensionFor(contentType, input.kind)}`);
  const filename = absoluteObjectPath(objectKey);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, Buffer.from(input.data));
  let coverObjectKey: string | null = null;
  const coverContentType = input.coverContentType || "image/jpeg";
  if (input.kind === "video" && input.coverData?.byteLength) {
    coverObjectKey = path.join(member.id, input.kind, `${input.id}-cover.${extensionFor(coverContentType, "image")}`);
    const coverFilename = absoluteObjectPath(coverObjectKey);
    mkdirSync(path.dirname(coverFilename), { recursive: true });
    writeFileSync(coverFilename, Buffer.from(input.coverData));
  }
  return insertAsset(member, {
    ...input,
    objectKey,
    contentType,
    sizeBytes: input.data.byteLength,
    coverObjectKey,
    coverContentType: coverObjectKey ? coverContentType : null,
  });
}

export async function deleteMemberAsset(member: MemberSession, id: string) {
  const source = getAssetRow(member.id, id);
  if (!source) return false;
  if (source.storage_provider === "cos") {
    await deleteCosObject(source.object_key);
    const asset = mapRow(source);
    if (asset.cover_object_key) await deleteCosObject(asset.cover_object_key);
  } else {
    removeAssetFiles(source);
  }
  const result = getDatabase().prepare("DELETE FROM assets WHERE id = ? AND owner_id = ?").run(id, member.id);
  return Number(result.changes) > 0;
}
