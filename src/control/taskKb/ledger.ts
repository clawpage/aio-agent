import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../db.js";
import { KB_SCHEMA } from "../db.js";
import { reindexNode } from "./kernel.js";

/**
 * A shared library's own database file (docs/SHARED-KB.md §2.2) and its change record.
 *
 * Every row a write touches in the knowledge tables is recorded with its state before
 * and after, by triggers, while a change is open (`kb_change_cursor` holds its id). A
 * change is opened inside the writing transaction and closed before it commits, so no
 * write path can leave a gap, and undoing a change is putting its rows back.
 */

/** The tables a change records, with the columns that identify a row. */
const TRACKED: Record<string, string[]> = {
  kb_domains: ["owner_id", "name"],
  kb_nodes: ["id"],
  kb_claims: ["id"],
  kb_edges: ["id"],
  kb_sources: ["id"],
  kb_cites: ["item_id", "source_id"],
};

const LIBRARY_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
${KB_SCHEMA}
CREATE TABLE IF NOT EXISTS kb_rules (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  restored_from INTEGER
);
CREATE TABLE IF NOT EXISTS kb_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  by TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('maintainer','edit','undo','restore')),
  summary TEXT NOT NULL DEFAULT '',
  undoes INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_change_rows (
  change_id INTEGER NOT NULL REFERENCES kb_changes(id),
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  pk TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_change_rows_change ON kb_change_rows(change_id);
CREATE TABLE IF NOT EXISTS kb_change_cursor (one INTEGER PRIMARY KEY CHECK (one = 1), change_id INTEGER);
INSERT OR IGNORE INTO kb_change_cursor (one, change_id) VALUES (1, NULL);
`;

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

const rowJson = (prefix: "NEW" | "OLD", cols: string[]) => `json_object(${cols.map((c) => `'${c}', ${prefix}.${c}`).join(", ")})`;
const pkJson = (prefix: "NEW" | "OLD", pk: string[]) => `json_array(${pk.map((c) => `${prefix}.${c}`).join(", ")})`;

/** Open (creating when new) a library's file with its tables and recording triggers. */
export function openLibraryDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(LIBRARY_SCHEMA);
  const open = "(SELECT change_id FROM kb_change_cursor WHERE one=1)";
  for (const [table, pk] of Object.entries(TRACKED)) {
    const cols = columns(db, table);
    db.exec(`
CREATE TRIGGER IF NOT EXISTS ${table}_rec_ins AFTER INSERT ON ${table} WHEN ${open} IS NOT NULL BEGIN
  INSERT INTO kb_change_rows (change_id, tbl, pk, before_json, after_json) VALUES (${open}, '${table}', ${pkJson("NEW", pk)}, NULL, ${rowJson("NEW", cols)});
END;
CREATE TRIGGER IF NOT EXISTS ${table}_rec_upd AFTER UPDATE ON ${table} WHEN ${open} IS NOT NULL BEGIN
  INSERT INTO kb_change_rows (change_id, tbl, pk, before_json, after_json) VALUES (${open}, '${table}', ${pkJson("OLD", pk)}, ${rowJson("OLD", cols)}, ${rowJson("NEW", cols)});
END;
CREATE TRIGGER IF NOT EXISTS ${table}_rec_del AFTER DELETE ON ${table} WHEN ${open} IS NOT NULL BEGIN
  INSERT INTO kb_change_rows (change_id, tbl, pk, before_json, after_json) VALUES (${open}, '${table}', ${pkJson("OLD", pk)}, ${rowJson("OLD", cols)}, NULL);
END;`);
  }
  return db;
}

export type ChangeKind = "maintainer" | "edit" | "undo" | "restore";
export interface ChangeMeta { by: string; kind: ChangeKind; summary: string; undoes?: number | null }

/** Open a change inside the current transaction; every tracked write until `endChange` belongs to it. */
export function beginChange(db: Db, meta: ChangeMeta, now = Date.now()): number {
  const id = Number(db.prepare("INSERT INTO kb_changes (by, kind, summary, undoes, at) VALUES (?,?,?,?,?)").run(meta.by, meta.kind, meta.summary.slice(0, 300), meta.undoes ?? null, now).lastInsertRowid);
  db.prepare("UPDATE kb_change_cursor SET change_id=? WHERE one=1").run(id);
  return id;
}

/** Close the open change; one that recorded nothing is dropped. */
export function endChange(db: Db, id: number): boolean {
  db.prepare("UPDATE kb_change_cursor SET change_id=NULL WHERE one=1").run();
  if (db.prepare("SELECT 1 FROM kb_change_rows WHERE change_id=? LIMIT 1").get(id)) return true;
  db.prepare("DELETE FROM kb_changes WHERE id=?").run(id);
  return false;
}

/** Run `write` as one change in one transaction; returns the change id, or null when nothing changed. */
export function tracked<T>(db: Db, meta: ChangeMeta, write: () => T): { change: number | null; result: T } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const id = beginChange(db, meta);
    const result = write();
    const kept = endChange(db, id);
    db.exec("COMMIT");
    return { change: kept ? id : null, result };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

interface ChangeRow { seq: number; change_id: number; tbl: string; pk: string; before_json: string | null; after_json: string | null }

function currentRow(db: Db, tbl: string, pk: string): string | null {
  const keys = TRACKED[tbl]!;
  const values = JSON.parse(pk) as unknown[];
  const cols = columns(db, tbl);
  const row = db.prepare(`SELECT ${`json_object(${cols.map((c) => `'${c}', ${c}`).join(", ")})`} AS j FROM ${tbl} WHERE ${keys.map((k) => `${k}=?`).join(" AND ")}`)
    .get(...(values as Array<string | number | null>)) as { j: string } | undefined;
  return row ? row.j : null;
}

const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)));

/** Put one row back to `state` (null: it did not exist). */
function putRow(db: Db, tbl: string, pk: string, state: string | null): void {
  const keys = TRACKED[tbl]!;
  const values = JSON.parse(pk) as Array<string | number | null>;
  const where = keys.map((k) => `${k}=?`).join(" AND ");
  if (state === null) { db.prepare(`DELETE FROM ${tbl} WHERE ${where}`).run(...values); return; }
  const row = JSON.parse(state) as Record<string, string | number | null>;
  const cols = Object.keys(row).filter((c) => columns(db, tbl).includes(c));
  // Updated in place, never deleted and inserted again: deleting a node would cascade to its claims.
  if (db.prepare(`SELECT 1 FROM ${tbl} WHERE ${where}`).get(...values)) {
    db.prepare(`UPDATE ${tbl} SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE ${where}`).run(...cols.map((c) => row[c] ?? null), ...values);
  } else {
    db.prepare(`INSERT INTO ${tbl} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c] ?? null));
  }
}

/** The nodes a set of recorded rows belongs to, for the search index. */
function nodesOf(rows: ChangeRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const state of [r.before_json, r.after_json]) {
    if (!state) continue;
    const row = JSON.parse(state) as Record<string, unknown>;
    if (r.tbl === "kb_nodes") out.add(String(row.id));
    if (r.tbl === "kb_claims") out.add(String(row.node_id));
    if (r.tbl === "kb_edges") { out.add(String(row.src)); out.add(String(row.dst)); }
  }
  return out;
}

/**
 * Restore rows to their state before the recorded changes, newest first. Each row must
 * still be as the change left it; a row changed again since is a conflict, and nothing
 * is written.
 */
function revert(db: Db, rows: ChangeRow[], meta: ChangeMeta): { ok: true; change: number | null } | { ok: false; conflicts: string[] } {
  // A row a later revert step expects is the one an earlier step restores: check against a running view.
  const expected = new Map<string, string | null>();
  const conflicts: string[] = [];
  const ordered = [...rows].sort((a, b) => b.seq - a.seq);
  for (const r of ordered) {
    const key = `${r.tbl}\u0000${r.pk}`;
    const now = expected.has(key) ? expected.get(key)! : currentRow(db, r.tbl, r.pk);
    if (!same(now, r.after_json)) conflicts.push(`${r.tbl} ${r.pk}`);
    expected.set(key, r.before_json);
  }
  if (conflicts.length) return { ok: false, conflicts: [...new Set(conflicts)] };
  const { change } = tracked(db, meta, () => {
    // Foreign keys are checked at commit: a claim may come back before its node does.
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const r of ordered) putRow(db, r.tbl, r.pk, r.before_json);
    for (const node of nodesOf(rows)) reindexNode(db, node);
  });
  return { ok: true, change };
}

/** Undo one change (docs/SHARED-KB.md §4). */
export function undoChange(db: Db, changeId: number, by: string): { ok: true; change: number | null } | { ok: false; conflicts: string[] } | null {
  const change = db.prepare("SELECT id, summary FROM kb_changes WHERE id=?").get(changeId) as { id: number; summary: string } | undefined;
  if (!change) return null;
  const rows = db.prepare("SELECT * FROM kb_change_rows WHERE change_id=? ORDER BY seq").all(changeId) as unknown as ChangeRow[];
  return revert(db, rows, { by, kind: "undo", summary: change.summary, undoes: changeId });
}

/** The recorded rows that belong to one node: the node, its claims, its links, and their citations. */
function nodeRows(db: Db, nodeId: string, after: number): ChangeRow[] {
  const rows = db.prepare("SELECT * FROM kb_change_rows WHERE change_id>? ORDER BY seq").all(after) as unknown as ChangeRow[];
  const items = new Set<string>([nodeId]);
  const mine = (r: ChangeRow) => [r.before_json, r.after_json].some((state) => {
    if (!state) return false;
    const row = JSON.parse(state) as Record<string, unknown>;
    if (r.tbl === "kb_nodes") return row.id === nodeId;
    if (r.tbl === "kb_claims") return row.node_id === nodeId;
    if (r.tbl === "kb_edges") return row.src === nodeId || row.dst === nodeId;
    return false;
  });
  const out = rows.filter(mine);
  for (const r of out) if (r.tbl !== "kb_nodes") items.add((JSON.parse(r.pk) as string[])[0]!);
  return [...out, ...rows.filter((r) => r.tbl === "kb_cites" && items.has(String((JSON.parse(r.pk) as unknown[])[0])))];
}

/** Put one node back as it was right after change `afterChange` (0: before it existed). */
export function restoreNode(db: Db, nodeId: string, afterChange: number, by: string): { ok: true; change: number | null } | { ok: false; conflicts: string[] } {
  const title = (db.prepare("SELECT title FROM kb_nodes WHERE id=?").get(nodeId) as { title: string } | undefined)?.title ?? nodeId;
  return revert(db, nodeRows(db, nodeId, afterChange), { by, kind: "restore", summary: title });
}

/** The changes that touched one node, newest first. */
export function nodeChanges(db: Db, nodeId: string): Array<{ id: number; by: string; kind: string; summary: string; at: number }> {
  const ids = new Set(nodeRows(db, nodeId, 0).map((r) => r.change_id));
  if (!ids.size) return [];
  return db.prepare(`SELECT id, by, kind, summary, at FROM kb_changes WHERE id IN (${[...ids].map(() => "?").join(",")}) ORDER BY id DESC`).all(...ids) as Array<{ id: number; by: string; kind: string; summary: string; at: number }>;
}

/** The library's changes, newest first, with how many rows each touched. */
export function listChanges(db: Db, opts: { before?: number; limit?: number } = {}): Array<{ id: number; by: string; kind: string; summary: string; undoes: number | null; at: number; rows: number; undone: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return (db.prepare(`SELECT c.id, c.by, c.kind, c.summary, c.undoes, c.at, (SELECT count(*) FROM kb_change_rows r WHERE r.change_id=c.id) AS rows,
      EXISTS (SELECT 1 FROM kb_changes u WHERE u.undoes=c.id) AS undone
    FROM kb_changes c WHERE c.id < ? ORDER BY c.id DESC LIMIT ?`).all(opts.before ?? Number.MAX_SAFE_INTEGER, limit) as Array<{ id: number; by: string; kind: string; summary: string; undoes: number | null; at: number; rows: number; undone: number }>)
    .map((c) => ({ ...c, undone: !!c.undone }));
}
