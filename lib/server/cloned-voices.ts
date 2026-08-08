import { randomUUID } from "node:crypto";
import { getDatabase, unixNow } from "./db";

export type ClonedVoiceRecord = {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerUsername: string;
  name: string;
  provider: string;
  providerVoiceId: string;
  sampleAssetId: string;
  status: string;
  createdAt: number;
};

export function upsertClonedVoice(input: {
  ownerId: string;
  name: string;
  providerVoiceId: string;
  provider?: string;
  sampleAssetId?: string | null;
  status?: string;
}) {
  const db = getDatabase();
  const provider = input.provider || "chanjing";
  const now = unixNow();
  const existing = db.prepare(`
    SELECT id FROM cloned_voices
    WHERE owner_id = ? AND provider = ? AND provider_voice_id = ?
    LIMIT 1
  `).get(input.ownerId, provider, input.providerVoiceId) as { id: string } | undefined;
  const id = existing?.id || `voice_${randomUUID()}`;
  db.prepare(`
    INSERT INTO cloned_voices
      (id, owner_id, name, provider, provider_voice_id, sample_asset_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      sample_asset_id = COALESCE(excluded.sample_asset_id, cloned_voices.sample_asset_id),
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.ownerId,
    input.name.trim() || "克隆声音",
    provider,
    input.providerVoiceId,
    input.sampleAssetId || null,
    input.status || "ready",
    now,
    now,
  );
  return id;
}

export function listClonedVoicesForAdmin(): ClonedVoiceRecord[] {
  return (getDatabase().prepare(`
    SELECT cv.id, cv.owner_id, cv.name, cv.provider, cv.provider_voice_id,
      cv.sample_asset_id, cv.status, cv.created_at,
      u.display_name AS owner_name, u.username AS owner_username
    FROM cloned_voices cv
    LEFT JOIN users u ON u.id = cv.owner_id
    ORDER BY cv.created_at DESC, cv.name ASC
  `).all() as Array<{
    id: string;
    owner_id: string;
    name: string;
    provider: string;
    provider_voice_id: string;
    sample_asset_id: string | null;
    status: string;
    created_at: number;
    owner_name: string | null;
    owner_username: string | null;
  }>).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name || "未知会员",
    ownerUsername: row.owner_username || "—",
    name: row.name,
    provider: row.provider,
    providerVoiceId: row.provider_voice_id,
    sampleAssetId: row.sample_asset_id || "",
    status: row.status,
    createdAt: Number(row.created_at),
  }));
}

export function listClonedVoicesForMember(ownerId: string) {
  return (getDatabase().prepare(`
    SELECT name, provider_voice_id, sample_asset_id, created_at
    FROM cloned_voices
    WHERE owner_id = ? AND status = 'ready'
    ORDER BY created_at DESC, name ASC
  `).all(ownerId) as Array<{
    name: string;
    provider_voice_id: string;
    sample_asset_id: string | null;
    created_at: number;
  }>).map((row) => ({
    voiceId: row.provider_voice_id,
    name: row.name,
    demoAudio: row.sample_asset_id
      ? `/api/member/assets/${encodeURIComponent(row.sample_asset_id)}`
      : "",
    createdAt: Number(row.created_at) * 1000,
  }));
}
