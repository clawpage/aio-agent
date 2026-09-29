import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_params TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  parent_session_id TEXT,
  prev_token_hash TEXT,
  prev_valid_until INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_prev ON sessions(prev_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  codex_thread_id TEXT,
  model TEXT,
  model_provider TEXT,
  cwd TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_id, archived, updated_at);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  client_message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  codex_turn_id TEXT,
  input_text TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  browser_required INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  effort TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, id);

CREATE TABLE IF NOT EXISTS server_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT,
  codex_request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_server_requests_pending ON server_requests(status, conversation_id);

CREATE TABLE IF NOT EXISTS workspace_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  client_message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
  execution_conversation_id TEXT REFERENCES conversations(id),
  turn_id TEXT,
  title TEXT NOT NULL,
  input_text TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  related_task_id TEXT REFERENCES tasks(id),
  merged_into TEXT REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'planning',
  plan_json TEXT,
  model TEXT,
  effort TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE TRIGGER IF NOT EXISTS task_revision AFTER UPDATE ON tasks
WHEN NEW.revision = OLD.revision
BEGIN UPDATE tasks SET revision=OLD.revision+1 WHERE id=NEW.id; END;

-- Dispatcher recall: past tasks indexed as CJK bigrams + latin words (BM25),
-- and what each dispatch saw and chose, for monitoring.
CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(task_id UNINDEXED, owner_id UNINDEXED, title, body);
CREATE TABLE IF NOT EXISTS task_search_state (
  task_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recall_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  candidates_json TEXT NOT NULL,
  searches_json TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  chosen_json TEXT NOT NULL,
  gold_task_id TEXT,
  gold_rank INTEGER,
  gold_in_window INTEGER,
  latency_ms INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  fail_reason TEXT,
  repairs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_recall_events_created ON recall_events(created_at);

CREATE TABLE IF NOT EXISTS agent_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_turn_id TEXT,
  active_conversation_id TEXT,
  queue_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO agent_state (id, active_turn_id, active_conversation_id, queue_json, updated_at)
  VALUES (1, NULL, NULL, '[]', 0);
`;

/** Tables that hold auth material and must be wipeable in tests. */
export const AUTH_TABLES = ["sessions", "login_failures", "workspace_tickets"];

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  const current = getMeta(db, "schema_version");
  if (current === null) {
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
  } else if (Number(current) !== SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${current}, expected ${SCHEMA_VERSION}`);
  }
  return db;
}

/**
 * Idempotent, additive migrations for databases created before a column existed.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so each new column
 * is added here when the live schema is missing it. Safe to run on every open.
 */
function migrate(db: Db): void {
  const users = db.prepare("PRAGMA table_info(owners)").all() as Array<{ name: string }>;
  if (!users.some(c => c.name === "role")) {
    db.exec("ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member'))");
    db.exec("UPDATE owners SET role='owner' WHERE id='owner_1'");
  }
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!taskColumns.some(c => c.name === "execution_conversation_id")) db.exec("ALTER TABLE tasks ADD COLUMN execution_conversation_id TEXT REFERENCES conversations(id)");
  if (!taskColumns.some(c => c.name === "merged_into")) db.exec("ALTER TABLE tasks ADD COLUMN merged_into TEXT REFERENCES tasks(id)");
  const recallColumns = db.prepare("PRAGMA table_info(recall_events)").all() as Array<{ name: string }>;
  if (!recallColumns.some(c => c.name === "fail_reason")) db.exec("ALTER TABLE recall_events ADD COLUMN fail_reason TEXT");
  if (!recallColumns.some(c => c.name === "repairs_json")) db.exec("ALTER TABLE recall_events ADD COLUMN repairs_json TEXT NOT NULL DEFAULT '[]'");
  const columns = (db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("browser_required")) db.exec("ALTER TABLE turns ADD COLUMN browser_required INTEGER NOT NULL DEFAULT 1");
  if (!columns.includes("model")) {
    db.exec("ALTER TABLE turns ADD COLUMN model TEXT");
  }
  // Which Codex provider a conversation's thread currently runs on. NULL means
  // the ChatGPT provider, which is what every conversation predating the
  // optional bridge used.
  const conversationColumns = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (!conversationColumns.includes("model_provider")) {
    db.exec("ALTER TABLE conversations ADD COLUMN model_provider TEXT");
  }
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function audit(db: Db, kind: string, detail?: string, ip?: string): void {
  db.prepare("INSERT INTO audit_log (ts, kind, detail, ip) VALUES (?, ?, ?, ?)").run(
    Date.now(),
    kind,
    detail ?? null,
    ip ?? null,
  );
}
