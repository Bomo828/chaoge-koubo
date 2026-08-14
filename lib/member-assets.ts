import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MemberSession } from "../app/member-session";
import { getDatabase, parseJson, unixNow } from "./server/db";

export type MemberAssetRow = {
  id: string;
  member_id: string;
  project_name: string;
  kind: "image" | "video" | "audio" | "voice";
  name: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  source_task_id: string | null;
  cover_object_key: string | null;
  cover_content_type: string | null;
  created_at: number;
  expires_at: number | null;
};

type AssetDbRow = {
  id: string;
  owner_id: string;
  kind: MemberAssetRow["kind"];
  name: string;
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
  }>(row.metadata_json, {});
  return {
    id: row.id,
    member_id: row.owner_id,
    project_name: metadata.projectName || "未命名项目",
    kind: row.kind,
    name: row.name,
    object_key: row.object_key,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    source_task_id: metadata.sourceTaskId || null,
    cover_object_key: metadata.coverObjectKey || null,
    cover_content_type: metadata.coverContentType || null,
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
    SELECT id, owner_id, kind, name, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
    FROM assets WHERE id = ? AND owner_id = ? LIMIT 1
  `).get(id, memberId) as AssetDbRow | undefined;
}

function removeAssetFiles(row: AssetDbRow) {
  const filename = absoluteObjectPath(row.object_key);
  if (existsSync(filename)) unlinkSync(filename);
  const asset = mapRow(row);
  if (asset.cover_object_key) {
    const coverFilename = absoluteObjectPath(asset.cover_object_key);
    if (existsSync(coverFilename)) unlinkSync(coverFilename);
  }
}

export function purgeExpiredMemberAssets(memberId?: string) {
  const now = unixNow();
  const database = getDatabase();
  const rows = (memberId
    ? database.prepare(`
        SELECT id, owner_id, kind, name, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
        FROM assets WHERE owner_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(memberId, now)
    : database.prepare(`
        SELECT id, owner_id, kind, name, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
        FROM assets WHERE expires_at IS NOT NULL AND expires_at <= ?
      `).all(now)) as AssetDbRow[];

  for (const row of rows) {
    try {
      removeAssetFiles(row);
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
  purgeExpiredMemberAssets(member.id);
  const rows = getDatabase().prepare(`
    SELECT id, owner_id, kind, name, object_key, content_type, size_bytes, metadata_json, created_at, expires_at
    FROM assets
    WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC LIMIT 300
  `).all(member.id, unixNow()) as AssetDbRow[];
  return rows.map(mapRow);
}

export async function getMemberAsset(member: MemberSession, id: string) {
  const source = getActiveAssetRow(member.id, id);
  if (!source) return null;
  const row = mapRow(source);
  const filename = absoluteObjectPath(row.object_key);
  if (!existsSync(filename)) return null;
  const stat = statSync(filename);
  return {
    row,
    object: {
      body: Readable.toWeb(createReadStream(filename)) as ReadableStream<Uint8Array>,
      size: stat.size,
      httpMetadata: { contentType: row.content_type },
    },
  };
}

export async function getMemberAssetCover(member: MemberSession, id: string) {
  const source = getActiveAssetRow(member.id, id);
  if (!source) return null;
  const row = mapRow(source);
  if (!row.cover_object_key) return null;
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
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sourceTaskId?: string | null;
  coverObjectKey?: string | null;
  coverContentType?: string | null;
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
    VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    member.id,
    input.kind,
    input.name,
    input.objectKey,
    input.contentType,
    input.sizeBytes,
    JSON.stringify({
      projectName: input.projectName,
      sourceTaskId: input.sourceTaskId || null,
      coverObjectKey: input.coverObjectKey || null,
      coverContentType: input.coverContentType || null,
    }),
    createdAt,
    now,
    expiresAt,
  );
  const saved = getAssetRow(member.id, input.id);
  return saved ? mapRow(saved) : null;
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
  removeAssetFiles(source);
  const result = getDatabase().prepare("DELETE FROM assets WHERE id = ? AND owner_id = ?").run(id, member.id);
  return Number(result.changes) > 0;
}
