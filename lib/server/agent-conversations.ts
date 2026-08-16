import { getDatabase, unixNow } from "./db";

export type AgentConversation = {
  conversationId: string;
  model: string;
  title: string;
  lastCost: number;
  createdAt: number;
  updatedAt: number;
};

type ConversationRow = {
  conversation_id: string;
  model: string;
  title: string;
  last_cost: number;
  created_at: number;
  updated_at: number;
};

function ensureAgentTables() {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      conversation_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话',
      last_cost REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_conversations_owner_idx
      ON agent_conversations(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS agent_generation_tasks (
      task_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT,
      result_type TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_generation_tasks_owner_idx
      ON agent_generation_tasks(owner_id, updated_at DESC);
  `);
}

function mapConversation(row: ConversationRow): AgentConversation {
  return {
    conversationId: row.conversation_id,
    model: row.model,
    title: row.title,
    lastCost: Number(row.last_cost) || 0,
    createdAt: Number(row.created_at) * 1000,
    updatedAt: Number(row.updated_at) * 1000,
  };
}

export function rememberAgentConversation(ownerId: string, input: {
  conversationId: string;
  model: string;
  title?: string;
  cost?: number;
}) {
  ensureAgentTables();
  const now = unixNow();
  const title = (input.title || "新对话").trim().slice(0, 80) || "新对话";
  getDatabase().prepare(`
    INSERT INTO agent_conversations (conversation_id, owner_id, model, title, last_cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      model = excluded.model,
      title = CASE WHEN agent_conversations.title = '新对话' THEN excluded.title ELSE agent_conversations.title END,
      last_cost = CASE WHEN excluded.last_cost > 0 THEN excluded.last_cost ELSE agent_conversations.last_cost END,
      updated_at = excluded.updated_at
    WHERE agent_conversations.owner_id = excluded.owner_id
  `).run(input.conversationId, ownerId, input.model, title, Math.max(0, Number(input.cost) || 0), now, now);
}

export function listAgentConversations(ownerId: string, limit = 50) {
  ensureAgentTables();
  const rows = getDatabase().prepare(`
    SELECT conversation_id, model, title, last_cost, created_at, updated_at
    FROM agent_conversations WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?
  `).all(ownerId, Math.max(1, Math.min(limit, 100))) as ConversationRow[];
  return rows.map(mapConversation);
}

export function ownsAgentConversation(ownerId: string, conversationId: string) {
  ensureAgentTables();
  return Boolean(getDatabase().prepare(`
    SELECT 1 FROM agent_conversations WHERE owner_id = ? AND conversation_id = ? LIMIT 1
  `).get(ownerId, conversationId));
}

export function forgetAgentConversation(ownerId: string, conversationId: string) {
  ensureAgentTables();
  getDatabase().prepare("DELETE FROM agent_conversations WHERE owner_id = ? AND conversation_id = ?")
    .run(ownerId, conversationId);
}

export function rememberAgentTask(ownerId: string, taskId: string, conversationId = "", resultType = "") {
  ensureAgentTables();
  const now = unixNow();
  getDatabase().prepare(`
    INSERT INTO agent_generation_tasks (task_id, owner_id, conversation_id, result_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET updated_at = excluded.updated_at
    WHERE agent_generation_tasks.owner_id = excluded.owner_id
  `).run(taskId, ownerId, conversationId, resultType, now, now);
}

export function ownsAgentTask(ownerId: string, taskId: string) {
  ensureAgentTables();
  return Boolean(getDatabase().prepare(`
    SELECT 1 FROM agent_generation_tasks WHERE owner_id = ? AND task_id = ? LIMIT 1
  `).get(ownerId, taskId));
}
