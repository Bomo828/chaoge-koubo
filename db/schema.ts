import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  externalId: text("external_id").unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  level: text("level").notNull().default("basic"),
  points: integer("points").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const merchants = sqliteTable("merchants", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  name: text("name").notNull(),
  industry: text("industry"),
  sourceId: text("source_id"),
  syncStatus: text("sync_status").notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  merchantId: text("merchant_id").references(() => merchants.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  status: text("status").notNull().default("ready"),
  sourceTaskId: text("source_task_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const memberAssetItems = sqliteTable("member_asset_items", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull(),
  projectName: text("project_name").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  sourceTaskId: text("source_task_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const clonedVoices = sqliteTable("cloned_voices", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  merchantId: text("merchant_id").references(() => merchants.id),
  name: text("name").notNull(),
  providerVoiceId: text("provider_voice_id").notNull(),
  sampleAssetId: text("sample_asset_id").references(() => assets.id),
  status: text("status").notNull().default("ready"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const pointLedger = sqliteTable("point_ledger", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  taskId: text("task_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const aiPointCharges = sqliteTable("ai_point_charges", {
  requestId: text("request_id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  action: text("action").notNull(),
  reservedCost: integer("reserved_cost").notNull(),
  actualCost: integer("actual_cost"),
  state: text("state").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
