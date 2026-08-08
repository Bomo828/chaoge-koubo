import type { MemberSession } from "../../app/member-session";
import { getDatabase, parseJson, unixNow } from "./db";

type MerchantDbRow = {
  id: string;
  name: string;
  miniapp_name: string | null;
  display_name: string | null;
  address: string | null;
  phone: string | null;
  industry: string | null;
  average_spend: string | null;
  service_tags: string;
  store_tags: string;
  profile_json: string;
  updated_at: number;
};

export type MerchantProfileInput = {
  name: string;
  miniAppName: string;
  storeDisplayName: string;
  address: string;
  phone: string;
  categoryPerCapita: string;
  serviceTags: string[];
  storeTags: string[];
  industry: string;
  positioning: string;
  audience: string;
  keywords: string[];
  materialSummary: string;
};

function cleanText(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanList(value: unknown, max = 12) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 40)).filter(Boolean).slice(0, max)
    : [];
}

function mapMerchant(row: MerchantDbRow): MerchantProfileInput & { id: string; updatedAt: number } {
  const profile = parseJson<Partial<MerchantProfileInput>>(row.profile_json, {});
  return {
    id: row.id,
    name: row.name,
    miniAppName: row.miniapp_name || "",
    storeDisplayName: row.display_name || "",
    address: row.address || "",
    phone: row.phone || "",
    categoryPerCapita: row.average_spend || "",
    serviceTags: parseJson<string[]>(row.service_tags, []),
    storeTags: parseJson<string[]>(row.store_tags, []),
    industry: row.industry || "",
    positioning: profile.positioning || "",
    audience: profile.audience || "",
    keywords: Array.isArray(profile.keywords) ? profile.keywords : [],
    materialSummary: profile.materialSummary || "",
    updatedAt: Number(row.updated_at),
  };
}

export function getMerchantProfile(member: MemberSession) {
  const row = getDatabase().prepare(`
    SELECT id, name, miniapp_name, display_name, address, phone, industry, average_spend,
      service_tags, store_tags, profile_json, updated_at
    FROM merchants WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 1
  `).get(member.id) as MerchantDbRow | undefined;
  return row ? mapMerchant(row) : null;
}

export function saveMerchantProfile(member: MemberSession, raw: Partial<MerchantProfileInput>) {
  const current = getMerchantProfile(member);
  const input: MerchantProfileInput = {
    name: cleanText(raw.name, 80) || current?.name || "我的商家",
    miniAppName: cleanText(raw.miniAppName, 80),
    storeDisplayName: cleanText(raw.storeDisplayName, 100),
    address: cleanText(raw.address, 240),
    phone: cleanText(raw.phone, 30),
    categoryPerCapita: cleanText(raw.categoryPerCapita, 80),
    serviceTags: cleanList(raw.serviceTags, 12),
    storeTags: cleanList(raw.storeTags, 12),
    industry: cleanText(raw.industry, 80),
    positioning: cleanText(raw.positioning, 500),
    audience: cleanText(raw.audience, 500),
    keywords: cleanList(raw.keywords, 16),
    materialSummary: cleanText(raw.materialSummary, 1000),
  };
  const id = current?.id || `merchant_${crypto.randomUUID()}`;
  const now = unixNow();
  getDatabase().prepare(`
    INSERT INTO merchants
      (id, owner_id, name, miniapp_name, display_name, address, phone, industry, average_spend,
       service_tags, store_tags, profile_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, miniapp_name = excluded.miniapp_name, display_name = excluded.display_name,
      address = excluded.address, phone = excluded.phone, industry = excluded.industry,
      average_spend = excluded.average_spend, service_tags = excluded.service_tags,
      store_tags = excluded.store_tags, profile_json = excluded.profile_json, updated_at = excluded.updated_at
  `).run(
    id,
    member.id,
    input.name,
    input.miniAppName,
    input.storeDisplayName,
    input.address,
    input.phone,
    input.industry,
    input.categoryPerCapita,
    JSON.stringify(input.serviceTags),
    JSON.stringify(input.storeTags),
    JSON.stringify({
      positioning: input.positioning,
      audience: input.audience,
      keywords: input.keywords,
      materialSummary: input.materialSummary,
    }),
    now,
    now,
  );
  return getMerchantProfile(member);
}
