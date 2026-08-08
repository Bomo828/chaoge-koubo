import { randomUUID } from "node:crypto";
import { getDatabase, parseJson, unixNow } from "./db";
import { hashPassword } from "./auth";

export type AdminTemplate = {
  id: string;
  slug: string;
  category: string;
  name: string;
  version: number;
  status: string;
  previewUrl: string;
  coverUrl: string;
  description: string;
  config: Record<string, unknown>;
  updatedAt: number;
};

export type AdminProject = {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  status: string;
  coverUrl: string;
  config: Record<string, unknown>;
  updatedAt: number;
};

export type AdminUser = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  level: string;
  points: number;
  status: string;
  createdAt: number;
};

type TemplateRow = {
  id: string;
  slug: string;
  category: string;
  name: string;
  version: number;
  status: string;
  preview_url: string;
  cover_url: string;
  description: string;
  config_json: string;
  updated_at: number;
};

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  status: string;
  cover_url: string | null;
  config_json: string;
  updated_at: number;
};

function mapTemplate(row: TemplateRow): AdminTemplate {
  return {
    id: row.id,
    slug: row.slug,
    category: row.category,
    name: row.name,
    version: Number(row.version),
    status: row.status,
    previewUrl: row.preview_url,
    coverUrl: row.cover_url,
    description: row.description,
    config: parseJson(row.config_json, {}),
    updatedAt: Number(row.updated_at),
  };
}

function mapProject(row: ProjectRow): AdminProject {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    type: row.type,
    status: row.status,
    coverUrl: row.cover_url || "",
    config: parseJson(row.config_json, {}),
    updatedAt: Number(row.updated_at),
  };
}

export function adminStats() {
  const db = getDatabase();
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value?: number } | undefined)?.value || 0);
  return {
    users: count("users"),
    projects: count("projects"),
    templates: count("templates"),
    tasks: count("ai_tasks"),
  };
}

export function listTemplates(input?: { category?: string; includeDrafts?: boolean }) {
  const db = getDatabase();
  const category = input?.category?.trim();
  const includeDrafts = Boolean(input?.includeDrafts);
  let sql = "SELECT id, slug, category, name, version, status, preview_url, cover_url, description, config_json, updated_at FROM templates";
  const params: string[] = [];
  const conditions: string[] = [];
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (!includeDrafts) conditions.push("status = 'published'");
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += " ORDER BY updated_at DESC, name ASC";
  return (db.prepare(sql).all(...params) as TemplateRow[]).map(mapTemplate);
}

export function createTemplate(actorId: string, input: Partial<AdminTemplate>) {
  const db = getDatabase();
  const now = unixNow();
  const id = `template_${randomUUID()}`;
  db.prepare(`
    INSERT INTO templates
      (id, slug, category, name, version, status, preview_url, cover_url, description, config_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(input.slug || "").trim(),
    String(input.category || "viral_video").trim(),
    String(input.name || "未命名模板").trim(),
    Math.max(1, Number(input.version) || 1),
    input.status === "draft" ? "draft" : "published",
    String(input.previewUrl || "").trim(),
    String(input.coverUrl || "").trim(),
    String(input.description || "").trim(),
    JSON.stringify(input.config || {}),
    actorId,
    now,
    now,
  );
  return getTemplate(id);
}

export function getTemplate(id: string) {
  const row = getDatabase().prepare(`
    SELECT id, slug, category, name, version, status, preview_url, cover_url, description, config_json, updated_at
    FROM templates WHERE id = ? LIMIT 1
  `).get(id) as TemplateRow | undefined;
  return row ? mapTemplate(row) : null;
}

export function updateTemplate(id: string, input: Partial<AdminTemplate>) {
  const current = getTemplate(id);
  if (!current) return null;
  const next: AdminTemplate = {
    ...current,
    slug: input.slug ?? current.slug,
    category: input.category ?? current.category,
    name: input.name ?? current.name,
    version: input.version ?? current.version,
    status: input.status ?? current.status,
    previewUrl: input.previewUrl ?? current.previewUrl,
    coverUrl: input.coverUrl ?? current.coverUrl,
    description: input.description ?? current.description,
    config: input.config ?? current.config,
  };
  getDatabase().prepare(`
    UPDATE templates SET slug = ?, category = ?, name = ?, version = ?, status = ?,
      preview_url = ?, cover_url = ?, description = ?, config_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.slug.trim(), next.category.trim(), next.name.trim(), Math.max(1, Number(next.version) || 1),
    next.status === "draft" ? "draft" : "published", next.previewUrl.trim(), next.coverUrl.trim(),
    next.description.trim(), JSON.stringify(next.config), unixNow(), id,
  );
  return getTemplate(id);
}

export function deleteTemplate(id: string) {
  const result = getDatabase().prepare("DELETE FROM templates WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function listProjects() {
  return (getDatabase().prepare(`
    SELECT id, owner_id, name, type, status, cover_url, config_json, updated_at
    FROM projects ORDER BY updated_at DESC
  `).all() as ProjectRow[]).map(mapProject);
}

export function createProject(ownerId: string, input: Partial<AdminProject>) {
  const db = getDatabase();
  const id = `project_${randomUUID()}`;
  const now = unixNow();
  db.prepare(`
    INSERT INTO projects (id, owner_id, name, type, status, config_json, cover_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, ownerId, String(input.name || "未命名项目").trim(), String(input.type || "image").trim(),
    input.status === "archived" ? "archived" : input.status === "published" ? "published" : "draft",
    JSON.stringify(input.config || {}), String(input.coverUrl || "").trim(), now, now,
  );
  return getProject(id);
}

export function getProject(id: string) {
  const row = getDatabase().prepare(`
    SELECT id, owner_id, name, type, status, cover_url, config_json, updated_at
    FROM projects WHERE id = ? LIMIT 1
  `).get(id) as ProjectRow | undefined;
  return row ? mapProject(row) : null;
}

export function updateProject(id: string, input: Partial<AdminProject>) {
  const current = getProject(id);
  if (!current) return null;
  const next: AdminProject = {
    ...current,
    ownerId: input.ownerId ?? current.ownerId,
    name: input.name ?? current.name,
    type: input.type ?? current.type,
    status: input.status ?? current.status,
    coverUrl: input.coverUrl ?? current.coverUrl,
    config: input.config ?? current.config,
  };
  getDatabase().prepare(`
    UPDATE projects SET name = ?, type = ?, status = ?, cover_url = ?, config_json = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name.trim(), next.type.trim(), next.status, next.coverUrl.trim(), JSON.stringify(next.config), unixNow(), id);
  return getProject(id);
}

export function deleteProject(id: string) {
  const result = getDatabase().prepare("DELETE FROM projects WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function listUsers() {
  return (getDatabase().prepare(`
    SELECT id, username, display_name, role, level, points, status, created_at
    FROM users ORDER BY created_at DESC
  `).all() as Array<{
    id: string;
    username: string;
    display_name: string;
    role: string;
    level: string;
    points: number;
    status: string;
    created_at: number;
  }>).map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    level: row.level,
    points: Number(row.points),
    status: row.status,
    createdAt: Number(row.created_at),
  }));
}

export function createUserByAdmin(
  actorId: string,
  input: { username: string; displayName: string; password: string; level?: string; points?: number },
) {
  const db = getDatabase();
  const id = `user_${randomUUID()}`;
  const now = unixNow();
  const points = Math.max(0, Math.trunc(Number(input.points) || 0));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO users
        (id, username, password_hash, display_name, role, level, points, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'member', ?, ?, 'active', ?, ?)
    `).run(
      id,
      input.username.trim(),
      hashPassword(input.password),
      input.displayName.trim(),
      input.level?.trim() || "basic",
      points,
      now,
      now,
    );
    if (points > 0) {
      db.prepare(`
        INSERT INTO point_ledger (id, user_id, delta, balance_after, reason, operator_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`ledger_${randomUUID()}`, id, points, points, "管理员创建会员并设置初始积分", actorId, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listUsers().find((user) => user.id === id) || null;
}

export function updateUserByAdmin(
  actorId: string,
  id: string,
  input: { username?: string; displayName?: string; password?: string; role?: string; level?: string; status?: string; pointDelta?: number },
) {
  const db = getDatabase();
  const current = db.prepare(`
    SELECT id, username, display_name, role, level, points, status FROM users WHERE id = ? LIMIT 1
  `).get(id) as { id: string; username: string; display_name: string; role: string; level: string; points: number; status: string } | undefined;
  if (!current) return null;

  const role = input.role === "admin" || input.role === "super_admin" ? input.role : input.role === "member" ? "member" : current.role;
  const status = input.status === "disabled" ? "disabled" : input.status === "active" ? "active" : current.status;
  const pointDelta = Math.trunc(Number(input.pointDelta) || 0);
  const nextPoints = Math.max(0, Number(current.points) + pointDelta);
  const now = unixNow();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE users SET username = ?, display_name = ?, role = ?, level = ?, points = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.username?.trim() || current.username,
      input.displayName?.trim() || current.display_name,
      role,
      input.level?.trim() || current.level,
      nextPoints,
      status,
      now,
      id,
    );
    if (input.password) {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPassword(input.password), now, id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    if (pointDelta !== 0) {
      db.prepare(`
        INSERT INTO point_ledger (id, user_id, delta, balance_after, reason, operator_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`ledger_${randomUUID()}`, id, nextPoints - Number(current.points), nextPoints, "管理员调整积分", actorId, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listUsers().find((user) => user.id === id) || null;
}
