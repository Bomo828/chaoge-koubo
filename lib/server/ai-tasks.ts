import type { MemberSession } from "../../app/member-session";
import { getDatabase, parseJson, unixNow } from "./db";

export type AiTaskState = "pending" | "running" | "success" | "failed";

type AiTaskDbRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  template_id: string | null;
  kind: string;
  provider: string;
  provider_task_id: string | null;
  state: AiTaskState;
  progress: number;
  input_json: string;
  result_json: string;
  error: string | null;
  points_reserved: number;
  points_charged: number;
  created_at: number;
  updated_at: number;
};

function mapTask(row: AiTaskDbRow) {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    templateId: row.template_id,
    kind: row.kind,
    provider: row.provider,
    providerTaskIds: (row.provider_task_id || "").split(",").filter(Boolean),
    state: row.state,
    progress: Number(row.progress),
    input: parseJson<Record<string, unknown>>(row.input_json, {}),
    result: parseJson<Record<string, unknown>>(row.result_json, {}),
    error: row.error || "",
    pointsReserved: Number(row.points_reserved),
    pointsCharged: Number(row.points_charged),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const selectFields = `
  id, user_id, project_id, template_id, kind, provider, provider_task_id, state, progress,
  input_json, result_json, error, points_reserved, points_charged, created_at, updated_at
`;

export function createAiTask(member: MemberSession, input: {
  id: string;
  kind: string;
  provider: string;
  projectId?: string | null;
  templateId?: string | null;
  payload?: Record<string, unknown>;
  pointsReserved?: number;
}) {
  const now = unixNow();
  getDatabase().prepare(`
    INSERT INTO ai_tasks
      (id, user_id, project_id, template_id, kind, provider, state, progress, input_json,
       result_json, points_reserved, points_charged, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, '{}', ?, 0, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    input.id,
    member.id,
    input.projectId || null,
    input.templateId || null,
    input.kind,
    input.provider,
    JSON.stringify(input.payload || {}),
    Math.max(0, Math.ceil(input.pointsReserved || 0)),
    now,
    now,
  );
  return getAiTask(member, input.id);
}

export function updateAiTask(member: MemberSession, id: string, patch: {
  providerTaskIds?: string[];
  state?: AiTaskState;
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
  pointsCharged?: number;
}) {
  const current = getAiTask(member, id);
  if (!current) return null;
  const state = patch.state ?? current.state;
  const progress = Math.max(0, Math.min(100, Math.round(patch.progress ?? current.progress)));
  getDatabase().prepare(`
    UPDATE ai_tasks SET provider_task_id = ?, state = ?, progress = ?, result_json = ?, error = ?,
      points_charged = ?, updated_at = ? WHERE id = ? AND user_id = ?
  `).run(
    patch.providerTaskIds ? patch.providerTaskIds.filter(Boolean).join(",") : current.providerTaskIds.join(","),
    state,
    state === "success" || state === "failed" ? 100 : progress,
    JSON.stringify(patch.result ?? current.result),
    patch.error ?? current.error,
    Math.max(0, Math.ceil(patch.pointsCharged ?? current.pointsCharged)),
    unixNow(),
    id,
    member.id,
  );
  return getAiTask(member, id);
}

export function getAiTask(member: MemberSession, id: string) {
  const row = getDatabase().prepare(`SELECT ${selectFields} FROM ai_tasks WHERE id = ? AND user_id = ? LIMIT 1`)
    .get(id, member.id) as AiTaskDbRow | undefined;
  return row ? mapTask(row) : null;
}

export function listAiTasks(member: MemberSession, limit = 100) {
  const rows = getDatabase().prepare(`SELECT ${selectFields} FROM ai_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(member.id, Math.max(1, Math.min(300, Math.floor(limit)))) as AiTaskDbRow[];
  return rows.map(mapTask);
}
