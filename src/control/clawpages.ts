import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Clawpages' data: the tables a published page (a "clawpage", see share.ts) reads
 * and writes through the browser SDK, the sandbox CLI and the console.
 *
 * The model follows clawpage.ai's data tables (permissions, record operations,
 * limits), scoped to one page instead of one account, so a page that misbehaves
 * or is abused never reaches another page's data. Everything lives in one SQLite
 * file beside the page snapshots in the central data directory: a visitor's read
 * or write never resolves, wakes or reaches an account's runtime or sandbox.
 *
 * Who may do what is decided by the caller: `owner` is the account itself (its
 * sandbox's share token, its console session, or an owner link's token);
 * a collaborator (someone else's agent holding a token the owner gave out for one
 * page) reads and writes every table like the owner but does not manage them;
 * everyone else is a visitor, held to the table's permission.
 */

export const TABLE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;
export const RECORD_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
export const PERMISSIONS = ["private", "read-public", "public"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const DATA_LIMITS = { tablesPerPage: 20, recordsPerTable: 10_000, valueBytes: 64 * 1024, depth: 16, accountBytes: 50 * 1024 * 1024, pageSize: 100, maxPageSize: 500 };
/** Anonymous traffic on public tables, per client address and page, per minute. */
export const RATE_LIMITS = { writes: 60, reads: 600 };
/** An owner link stays usable this long. */
export const OWNER_LINK_MS = 12 * 3600_000;
/** Collaborator tokens a page can have at once. */
export const COLLABORATORS_PER_PAGE = 20;
const COLLABORATOR_TOKEN = /^cpc_[A-Za-z0-9_-]{43}$/;

export class DataError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface TableSummary { name: string; permission: Permission; records: number; bytes: number; createdAt: number; updatedAt: number }
export interface RecordSummary { key: string; value: unknown; createdAt: number; updatedAt: number }
/**
 * `owner` may use every table. Managing tables (permissions, dropping) also takes `manage`: the account
 * itself has it, while an owner link (which runs whatever script the page holds) and a collaborator
 * (`collaborator`, its label) use the tables on the owner's behalf without it.
 */
export interface Caller { owner: boolean; manage?: boolean; collaborator?: string; ip?: string }
export interface Collaborator { id: string; label: string; createdAt: number; lastUsedAt: number | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cp_tables (
  user_id TEXT NOT NULL, page TEXT NOT NULL, name TEXT NOT NULL,
  permission TEXT NOT NULL, records INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page, name)
);
CREATE TABLE IF NOT EXISTS cp_records (
  user_id TEXT NOT NULL, page TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, bytes INTEGER NOT NULL, seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page, tbl, key)
);
CREATE INDEX IF NOT EXISTS cp_records_order ON cp_records (user_id, page, tbl, seq);
CREATE TABLE IF NOT EXISTS cp_collaborators (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page TEXT NOT NULL, label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS cp_collaborators_page ON cp_collaborators (user_id, page);
`;

type TableRow = { name: string; permission: Permission; records: number; bytes: number; seq: number; created_at: number; updated_at: number };
type RecordRow = { key: string; value: string; bytes: number; seq: number; created_at: number; updated_at: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function depthOf(v: unknown, level = 1): number {
  if (typeof v !== "object" || v === null) return level - 1;
  let max = level;
  for (const child of Object.values(v)) max = Math.max(max, depthOf(child, level + 1));
  return max;
}

/** Nested plain objects merge; arrays and other values replace. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** Collaborator tokens are kept as their hash: the database never holds one that works. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class ClawpageData {
  readonly db: DatabaseSync;
  #key: Buffer;
  #hits = new Map<string, number>();
  #window = 0;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, "clawpages.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    // Owner links are signed with a key of this deployment's own; it never leaves the host.
    const keyFile = path.join(dataDir, "clawpages-key");
    try {
      this.#key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
    } catch {
      const key = randomBytes(32).toString("hex");
      fs.writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" });
      this.#key = Buffer.from(key, "hex");
    }
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ owner links

  /** A token that makes its holder the owner of one page, for a while. */
  ownerToken(userId: string, page: string, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ u: userId, p: page, e: now + OWNER_LINK_MS })).toString("base64url");
    return `${body}.${createHmac("sha256", this.#key).update(body).digest("base64url")}`;
  }

  /** Whether a token is a live owner token for exactly this account's page. */
  isOwnerToken(token: string, userId: string, page: string, now = Date.now()): boolean {
    const [body, sig] = token.split(".");
    if (!body || !sig || token.length > 600) return false;
    const expected = createHmac("sha256", this.#key).update(body).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try {
      const claim = JSON.parse(Buffer.from(body, "base64url").toString()) as { u?: unknown; p?: unknown; e?: unknown };
      return claim.u === userId && claim.p === page && typeof claim.e === "number" && claim.e > now;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ collaborators

  /**
   * A token for someone else's agent to maintain one page: its files and its data, never deleting
   * the page or managing its tables. Shown once; only its hash is kept. It lasts until removed.
   */
  addCollaborator(userId: string, page: string, label: unknown): Collaborator & { token: string } {
    const name = typeof label === "string" ? label.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80) : "";
    if (!name) throw new DataError(400, "INVALID_LABEL", "Name the collaborator (whose agent gets the token)");
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM cp_collaborators WHERE user_id=? AND page=?").get(userId, page) as { n: number }).n;
    if (count >= COLLABORATORS_PER_PAGE) throw new DataError(409, "TOO_MANY_COLLABORATORS", `A page can have at most ${COLLABORATORS_PER_PAGE} collaborators`);
    const id = randomBytes(6).toString("hex");
    const token = `cpc_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    this.db.prepare("INSERT INTO cp_collaborators (id,user_id,page,label,token_hash,created_at) VALUES (?,?,?,?,?,?)").run(id, userId, page, name, hashToken(token), now);
    return { id, label: name, createdAt: now, lastUsedAt: null, token };
  }

  collaborators(userId: string, page: string): Collaborator[] {
    return (this.db.prepare("SELECT id,label,created_at,last_used_at FROM cp_collaborators WHERE user_id=? AND page=? ORDER BY created_at").all(userId, page) as Array<{ id: string; label: string; created_at: number; last_used_at: number | null }>)
      .map((c) => ({ id: c.id, label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at }));
  }

  /** How many collaborators each of the account's pages has. */
  collaboratorCounts(userId: string): Map<string, number> {
    return new Map((this.db.prepare("SELECT page, COUNT(*) AS n FROM cp_collaborators WHERE user_id=? GROUP BY page").all(userId) as Array<{ page: string; n: number }>).map((r) => [r.page, r.n]));
  }

  removeCollaborator(userId: string, page: string, id: string): boolean {
    return this.db.prepare("DELETE FROM cp_collaborators WHERE user_id=? AND page=? AND id=?").run(userId, page, id).changes > 0;
  }

  /** The collaborator a token belongs to, if it is a live token for exactly this account's page; marks it used. */
  collaboratorOf(token: string, userId: string, page: string, now = Date.now()): Collaborator | null {
    if (!COLLABORATOR_TOKEN.test(token)) return null;
    const row = this.db.prepare("SELECT id,label,created_at,last_used_at FROM cp_collaborators WHERE token_hash=? AND user_id=? AND page=?").get(hashToken(token), userId, page) as { id: string; label: string; created_at: number; last_used_at: number | null } | undefined;
    if (!row) return null;
    // At most once a minute, so a busy agent does not write on every read.
    if (!row.last_used_at || now - row.last_used_at > 60_000) this.db.prepare("UPDATE cp_collaborators SET last_used_at=? WHERE id=?").run(now, row.id);
    return { id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: now };
  }

  // ------------------------------------------------------------------ rate limits

  /** Count one anonymous request; false once the address went over its share this minute. */
  allow(ip: string, userId: string, page: string, kind: "reads" | "writes", now = Date.now()): boolean {
    const window = Math.floor(now / 60_000);
    if (window !== this.#window) {
      this.#window = window;
      this.#hits.clear();
    }
    const key = `${kind}\u0000${ip}\u0000${userId}\u0000${page}`;
    const n = (this.#hits.get(key) ?? 0) + 1;
    this.#hits.set(key, n);
    return n <= RATE_LIMITS[kind];
  }

  // ------------------------------------------------------------------ tables

  #table(userId: string, page: string, name: string): TableRow | undefined {
    return this.db.prepare("SELECT * FROM cp_tables WHERE user_id=? AND page=? AND name=?").get(userId, page, name) as TableRow | undefined;
  }

  #summary(t: TableRow): TableSummary {
    return { name: t.name, permission: t.permission, records: t.records, bytes: t.bytes, createdAt: t.created_at, updatedAt: t.updated_at };
  }

  tables(userId: string, page: string): TableSummary[] {
    return (this.db.prepare("SELECT * FROM cp_tables WHERE user_id=? AND page=? ORDER BY name").all(userId, page) as TableRow[]).map((t) => this.#summary(t));
  }

  /** Every page of the account that has tables, with them: what the console and the executor are told about. */
  overview(userId: string): Map<string, TableSummary[]> {
    const out = new Map<string, TableSummary[]>();
    for (const t of this.db.prepare("SELECT page, * FROM cp_tables WHERE user_id=? ORDER BY page, name").all(userId) as Array<TableRow & { page: string }>) {
      out.set(t.page, [...(out.get(t.page) ?? []), this.#summary(t)]);
    }
    return out;
  }

  createTable(userId: string, page: string, name: string, permission: unknown = "private"): TableSummary {
    if (!TABLE_NAME.test(name)) throw new DataError(400, "INVALID_TABLE", "Table names are 2-64 lowercase letters, digits, - or _, starting and ending with a letter or digit");
    if (!PERMISSIONS.includes(permission as Permission)) throw new DataError(400, "INVALID_PERMISSION", `permission must be one of ${PERMISSIONS.join(", ")}`);
    if (this.#table(userId, page, name)) throw new DataError(409, "TABLE_EXISTS", `Table ${name} already exists`);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM cp_tables WHERE user_id=? AND page=?").get(userId, page) as { n: number }).n;
    if (count >= DATA_LIMITS.tablesPerPage) throw new DataError(409, "TOO_MANY_TABLES", `A page can have at most ${DATA_LIMITS.tablesPerPage} tables`);
    const now = Date.now();
    this.db.prepare("INSERT INTO cp_tables (user_id,page,name,permission,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(userId, page, name, permission as string, now, now);
    return this.#summary(this.#table(userId, page, name)!);
  }

  setPermission(userId: string, page: string, name: string, permission: unknown): TableSummary {
    if (!PERMISSIONS.includes(permission as Permission)) throw new DataError(400, "INVALID_PERMISSION", `permission must be one of ${PERMISSIONS.join(", ")}`);
    if (!this.#table(userId, page, name)) throw new DataError(404, "TABLE_NOT_FOUND", `Table ${name} does not exist`);
    this.db.prepare("UPDATE cp_tables SET permission=? WHERE user_id=? AND page=? AND name=?").run(permission as string, userId, page, name);
    return this.#summary(this.#table(userId, page, name)!);
  }

  dropTable(userId: string, page: string, name: string): boolean {
    this.db.exec("BEGIN");
    try {
      const gone = this.db.prepare("DELETE FROM cp_tables WHERE user_id=? AND page=? AND name=?").run(userId, page, name).changes > 0;
      this.db.prepare("DELETE FROM cp_records WHERE user_id=? AND page=? AND tbl=?").run(userId, page, name);
      this.db.exec("COMMIT");
      return gone;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A deleted page takes its data and its collaborators with it. */
  dropPage(userId: string, page: string): void {
    this.db.prepare("DELETE FROM cp_tables WHERE user_id=? AND page=?").run(userId, page);
    this.db.prepare("DELETE FROM cp_records WHERE user_id=? AND page=?").run(userId, page);
    this.db.prepare("DELETE FROM cp_collaborators WHERE user_id=? AND page=?").run(userId, page);
  }

  // ------------------------------------------------------------------ records

  /**
   * The table a caller may use, or the reason not. A private table is invisible to a
   * visitor (it reads as missing, as on clawpage.ai); the owner writing to a table
   * that does not exist yet creates it, private.
   */
  #access(userId: string, page: string, name: string, caller: Caller, write: boolean): TableRow {
    if (!TABLE_NAME.test(name)) throw new DataError(400, "INVALID_TABLE", "Invalid table name");
    let t = this.#table(userId, page, name);
    if (!t && caller.owner && write) {
      this.createTable(userId, page, name, "private");
      t = this.#table(userId, page, name);
    }
    if (!t || (!caller.owner && t.permission === "private")) throw new DataError(404, "TABLE_NOT_FOUND", `Table ${name} does not exist`);
    if (write && !caller.owner && t.permission !== "public") throw new DataError(403, "PERMISSION_DENIED", `Table ${name} is read-only for visitors`);
    return t;
  }

  #record(r: RecordRow): RecordSummary {
    return { key: r.key, value: JSON.parse(r.value) as unknown, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  #encode(value: unknown): string {
    if (value === undefined) throw new DataError(400, "MISSING_VALUE", "value is required");
    if (depthOf(value) > DATA_LIMITS.depth) throw new DataError(400, "VALUE_TOO_DEEP", `Values nest at most ${DATA_LIMITS.depth} levels`);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > DATA_LIMITS.valueBytes) throw new DataError(413, "VALUE_TOO_LARGE", `A record holds at most ${DATA_LIMITS.valueBytes / 1024} KB`);
    return text;
  }

  #get(userId: string, page: string, table: string, key: string): RecordRow | undefined {
    return this.db.prepare("SELECT key,value,bytes,seq,created_at,updated_at FROM cp_records WHERE user_id=? AND page=? AND tbl=? AND key=?").get(userId, page, table, key) as RecordRow | undefined;
  }

  list(userId: string, page: string, table: string, caller: Caller, opts: { limit?: unknown; after?: unknown } = {}): { records: RecordSummary[]; nextCursor: string | null } {
    this.#access(userId, page, table, caller, false);
    const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || DATA_LIMITS.pageSize), 1), DATA_LIMITS.maxPageSize);
    let afterSeq = 0;
    if (typeof opts.after === "string" && opts.after) {
      const from = this.#get(userId, page, table, opts.after);
      if (!from) throw new DataError(400, "INVALID_CURSOR", "The cursor record no longer exists");
      afterSeq = from.seq;
    }
    const rows = this.db.prepare("SELECT key,value,bytes,seq,created_at,updated_at FROM cp_records WHERE user_id=? AND page=? AND tbl=? AND seq>? ORDER BY seq LIMIT ?")
      .all(userId, page, table, afterSeq, limit + 1) as RecordRow[];
    const records = rows.slice(0, limit).map((r) => this.#record(r));
    return { records, nextCursor: rows.length > limit ? records.at(-1)!.key : null };
  }

  get(userId: string, page: string, table: string, key: string, caller: Caller): RecordSummary {
    this.#access(userId, page, table, caller, false);
    const row = RECORD_KEY.test(key) ? this.#get(userId, page, table, key) : undefined;
    if (!row) throw new DataError(404, "RECORD_NOT_FOUND", `No record ${key}`);
    return this.#record(row);
  }

  /** Write one record (whole): every write path ends here, inside a transaction, with the quotas checked. */
  #write(userId: string, page: string, table: string, key: string, text: string): RecordSummary {
    const now = Date.now();
    const bytes = Buffer.byteLength(text) + Buffer.byteLength(key);
    const old = this.#get(userId, page, table, key);
    const t = this.#table(userId, page, table)!;
    if (!old && t.records >= DATA_LIMITS.recordsPerTable) throw new DataError(409, "TABLE_FULL", `A table holds at most ${DATA_LIMITS.recordsPerTable} records`);
    const used = (this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM cp_tables WHERE user_id=?").get(userId) as { n: number }).n;
    if (used - (old?.bytes ?? 0) + bytes > DATA_LIMITS.accountBytes) throw new DataError(413, "QUOTA_EXCEEDED", `An account's clawpage data holds at most ${DATA_LIMITS.accountBytes / 1024 / 1024} MB`);
    if (old) {
      this.db.prepare("UPDATE cp_records SET value=?, bytes=?, updated_at=? WHERE user_id=? AND page=? AND tbl=? AND key=?").run(text, bytes, now, userId, page, table, key);
      this.db.prepare("UPDATE cp_tables SET bytes=bytes+?, updated_at=? WHERE user_id=? AND page=? AND name=?").run(bytes - old.bytes, now, userId, page, table);
    } else {
      this.db.prepare("INSERT INTO cp_records (user_id,page,tbl,key,value,bytes,seq,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(userId, page, table, key, text, bytes, t.seq + 1, now, now);
      this.db.prepare("UPDATE cp_tables SET records=records+1, bytes=bytes+?, seq=seq+1, updated_at=? WHERE user_id=? AND page=? AND name=?").run(bytes, now, userId, page, table);
    }
    return this.#record(this.#get(userId, page, table, key)!);
  }

  #tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  #checkKey(key: string): void {
    if (!RECORD_KEY.test(key)) throw new DataError(400, "INVALID_KEY", "Keys are 1-128 letters, digits, . _ or -, starting and ending with a letter or digit");
  }

  put(userId: string, page: string, table: string, key: string, value: unknown, caller: Caller): RecordSummary {
    this.#checkKey(key);
    const text = this.#encode(value);
    return this.#tx(() => {
      this.#access(userId, page, table, caller, true);
      return this.#write(userId, page, table, key, text);
    });
  }

  post(userId: string, page: string, table: string, value: unknown, caller: Caller): RecordSummary {
    return this.put(userId, page, table, `rec_${randomBytes(6).toString("base64url").replace(/^[-_]|[-_]$/g, "x")}`, value, caller);
  }

  patch(userId: string, page: string, table: string, key: string, value: unknown, caller: Caller): RecordSummary {
    this.#checkKey(key);
    if (!isObject(value)) throw new DataError(400, "PATCH_NOT_OBJECT", "A patch must be an object");
    return this.#tx(() => {
      this.#access(userId, page, table, caller, true);
      const old = this.#get(userId, page, table, key);
      if (!old) throw new DataError(404, "RECORD_NOT_FOUND", `No record ${key}`);
      const base = JSON.parse(old.value) as unknown;
      if (!isObject(base)) throw new DataError(400, "PATCH_NOT_OBJECT", "The stored value is not an object");
      return this.#write(userId, page, table, key, this.#encode(deepMerge(base, value)));
    });
  }

  incr(userId: string, page: string, table: string, key: string, field: unknown, by: unknown, caller: Caller): RecordSummary {
    this.#checkKey(key);
    const step = by === undefined ? 1 : Number(by);
    if (typeof field !== "string" || !field || field.length > 128 || !Number.isFinite(step)) throw new DataError(400, "INVALID_INCR", "incr needs a field name and a finite number");
    return this.#tx(() => {
      this.#access(userId, page, table, caller, true);
      const old = this.#get(userId, page, table, key);
      const base = old ? JSON.parse(old.value) as unknown : {};
      if (!isObject(base)) throw new DataError(400, "INCR_NOT_OBJECT", "The stored value is not an object");
      const current = base[field] ?? 0;
      if (typeof current !== "number") throw new DataError(400, "INCR_FIELD_NOT_NUMBER", `Field ${field} is not a number`);
      return this.#write(userId, page, table, key, this.#encode({ ...base, [field]: current + step }));
    });
  }

  remove(userId: string, page: string, table: string, key: string, caller: Caller): boolean {
    this.#checkKey(key);
    return this.#tx(() => {
      this.#access(userId, page, table, caller, true);
      const old = this.#get(userId, page, table, key);
      if (!old) return false;
      this.db.prepare("DELETE FROM cp_records WHERE user_id=? AND page=? AND tbl=? AND key=?").run(userId, page, table, key);
      this.db.prepare("UPDATE cp_tables SET records=records-1, bytes=bytes-?, updated_at=? WHERE user_id=? AND page=? AND name=?").run(old.bytes, Date.now(), userId, page, table);
      return true;
    });
  }

  /** The whole table as `{key: value}`, in insertion order (owner only). */
  exportTable(userId: string, page: string, table: string): { table: string; permission: Permission; records: Record<string, unknown> } {
    const t = this.#access(userId, page, table, { owner: true }, false);
    const records: Record<string, unknown> = {};
    for (const r of this.db.prepare("SELECT key,value FROM cp_records WHERE user_id=? AND page=? AND tbl=? ORDER BY seq").all(userId, page, table) as Array<{ key: string; value: string }>) {
      records[r.key] = JSON.parse(r.value);
    }
    return { table, permission: t.permission, records };
  }

  /** Upsert many records at once, all or nothing (owner only). */
  importTable(userId: string, page: string, table: string, records: unknown): { imported: number } {
    if (!isObject(records)) throw new DataError(400, "INVALID_IMPORT", "records must be an object of key: value");
    const entries = Object.entries(records);
    for (const [key] of entries) this.#checkKey(key);
    const encoded = entries.map(([key, value]) => [key, this.#encode(value)] as const);
    return this.#tx(() => {
      this.#access(userId, page, table, { owner: true }, true);
      for (const [key, text] of encoded) this.#write(userId, page, table, key, text);
      return { imported: encoded.length };
    });
  }
}
