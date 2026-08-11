import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { templateSeeds } from "./template-seeds";

type DatabaseGlobal = typeof globalThis & { __merchantStudioDb?: DatabaseSync };

function dataDirectory() {
  return process.env.APP_DATA_DIR?.trim() || ".data";
}

function initialize(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      level TEXT NOT NULL DEFAULT 'basic',
      points INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      config_json TEXT NOT NULL DEFAULT '{}',
      cover_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'published',
      preview_url TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS templates_category_idx ON templates(category, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ai_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_task_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      points_reserved INTEGER NOT NULL DEFAULT 0,
      points_charged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_tasks_user_idx ON ai_tasks(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES ai_tasks(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      storage_provider TEXT NOT NULL DEFAULT 'local',
      object_key TEXT NOT NULL,
      public_url TEXT,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assets_owner_idx ON assets(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cloned_voices (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_voice_id TEXT NOT NULL,
      sample_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      language TEXT NOT NULL DEFAULT 'cn',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS point_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      task_id TEXT,
      operator_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_task_unique ON point_ledger(task_id) WHERE task_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ai_point_charges (
      request_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      reserved_cost INTEGER NOT NULL,
      actual_cost INTEGER,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_point_charges_user_idx ON ai_point_charges(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_by TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  const clonedVoiceColumns = db.prepare("PRAGMA table_info(cloned_voices)").all() as Array<{ name: string }>;
  if (!clonedVoiceColumns.some((column) => column.name === "language")) {
    db.exec("ALTER TABLE cloned_voices ADD COLUMN language TEXT NOT NULL DEFAULT 'cn'");
  }

  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT INTO templates
      (id, slug, category, name, version, status, preview_url, description, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      category = excluded.category,
      name = excluded.name,
      version = excluded.version,
      preview_url = excluded.preview_url,
      description = excluded.description,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
    WHERE excluded.version > templates.version
  `);
  for (const template of templateSeeds) {
    insert.run(
      template.id,
      template.slug,
      template.category,
      template.name,
      template.version,
      template.previewUrl,
      template.description,
      JSON.stringify(template.config),
      now,
      now,
    );
  }

  // These were early visual demos rather than renderer-backed template
  // packages. Keep the records for administrators, but do not expose them in
  // the member catalog now that the four validated packages are available.
  db.prepare(`
    UPDATE templates
    SET status = 'archived', updated_at = ?
    WHERE id IN (
      'tpl_viral_soft_white',
      'tpl_viral_brand_card',
      'tpl_viral_bold_yellow',
      'tpl_viral_classic_blue',
      'tpl_viral_warm_brown'
    )
  `).run(now);
}

export function getDatabase() {
  const root = globalThis as DatabaseGlobal;
  if (root.__merchantStudioDb) return root.__merchantStudioDb;
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "merchant-studio.sqlite"));
  initialize(db);
  root.__merchantStudioDb = db;
  return db;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}
