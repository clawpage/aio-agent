import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';
import { userNamespace } from './auth/workspaceHost.js';
import type { Config } from './config.js';
import type { TokenCounts, UsageReport, UsageDay } from '../common/usage.js';

type Json = Record<string, any>;
const empty = (): TokenCounts => ({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
const number = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
function counts(raw: Json | undefined, claude: boolean): TokenCounts | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = number(raw.inputTokens ?? raw.input_tokens), output = number(raw.outputTokens ?? raw.output_tokens);
  const cached = number(raw.cachedInputTokens ?? raw.cacheReadInputTokens ?? raw.cache_read_input_tokens ?? 0);
  const cacheWrite = number(raw.cacheWriteInputTokens ?? raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens ?? 0);
  if (input === null || output === null || cached === null || cacheWrite === null) return null;
  // Claude separates cache reads/writes from input; Codex includes them in input.
  const totalInput = input + (claude ? cached + cacheWrite : 0);
  if (!Number.isSafeInteger(totalInput + output) || cached + cacheWrite > totalInput) return null;
  return { input: totalInput, output, cached, cacheWrite };
}

/** Account-local control database; only numeric provider counters and opaque dedup keys. */
export class UsageLedger {
  constructor(private db: Db, private userId = 'owner_1') {
    db.exec(`CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(created_at);
    CREATE TABLE IF NOT EXISTS token_usage_counters (key TEXT PRIMARY KEY, counts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS token_usage_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO token_usage_meta VALUES ('collection_started',?)").run(Date.now());
  }
  private add(key: string, value: TokenCounts, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO token_usage(source_key,created_at,input,output,cached,cache_write) VALUES(?,?,?,?,?,?)')
      .run(key, at, value.input, value.output, value.cached, value.cacheWrite);
  }
  private snapshot(key: string, value: TokenCounts, first: TokenCounts | null, at: number): void {
    const row = this.db.prepare('SELECT counts FROM token_usage_counters WHERE key=?').get(key) as { counts: string } | undefined;
    const prev: TokenCounts | null = row ? JSON.parse(row.counts) : null;
    // Duplicates, delayed snapshots and regressing provider counters cannot inflate usage.
    if (prev && Object.keys(value).some(k => value[k as keyof TokenCounts] < prev[k as keyof TokenCounts])) return;
    const delta = prev ? Object.fromEntries(Object.keys(value).map(k => [k, value[k as keyof TokenCounts] - prev[k as keyof TokenCounts]])) as TokenCounts : first;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (delta && delta.input + delta.output > 0) this.add(`${key}:${JSON.stringify(value)}`, delta, at);
      this.db.prepare('INSERT INTO token_usage_counters VALUES(?,?) ON CONFLICT(key) DO UPDATE SET counts=excluded.counts').run(key, JSON.stringify(value));
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  codex(params: unknown, at = Date.now()): void {
    const p = params as Json | null;
    if (!p || typeof p.threadId !== 'string') return;
    const total = counts(p.tokenUsage?.total, false), last = counts(p.tokenUsage?.last, false);
    if (total && (!last || Object.keys(total).every(k => last[k as keyof TokenCounts] <= total[k as keyof TokenCounts]))) this.snapshot(`codex:${p.threadId}`, total, last, at);
  }
  claude(result: Json, session: string, resumed: boolean, at = Date.now()): void {
    const models = result.modelUsage ?? result.model_usage;
    if (models && typeof models === 'object' && Object.keys(models).length) {
      const valid = Object.entries(models).map(([model, raw]) => [model, counts(raw as Json, true)] as const);
      if (valid.some(([, value]) => !value)) return;
      const known = valid.some(([model]) => this.db.prepare('SELECT key FROM token_usage_counters WHERE key=?').get(`claude:${session}:${model}`));
      // On the first observed resume, old cumulative spend has no reliable date.
      // Count this turn's main-loop usage, then establish a baseline for whole-tree totals.
      if (resumed && !known) this.claudeTurn(result, session, at);
      for (const [model, value] of valid) this.snapshot(`claude:${session}:${model}`, value!, resumed && !known ? null : value!, at);
    } else this.claudeTurn(result, session, at);
  }
  private claudeTurn(result: Json, session: string, at: number): void {
    const value = counts(result.usage, true);
    // Result UUID is stable across replay; never invent a key for unidentified results.
    if (value && typeof result.uuid === 'string') this.add(`claude-result:${session}:${result.uuid}`, value, at);
  }
  backfill(source = this.db): void {
    if (this.db.prepare("SELECT value FROM token_usage_meta WHERE key='backfilled'").get()) return;
    const exists = source.prepare("SELECT name FROM sqlite_master WHERE name='events'").get();
    if (exists) for (const row of source.prepare("SELECT e.payload,e.created_at FROM events e JOIN conversations c ON c.id=e.conversation_id WHERE e.type='thread/tokenUsage/updated' AND c.owner_id=? ORDER BY e.id").iterate(this.userId) as Iterable<{ payload: string; created_at: number }>) {
      try { this.codex(JSON.parse(row.payload), row.created_at); } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    }
    this.db.prepare("INSERT INTO token_usage_meta VALUES ('backfilled',1)").run();
  }
}

/** Reads control-plane stores only. Does not initialize agents or wake sandboxes. */
export function usageReport(root: Db, cfg: Config, days: number, now = Date.now()): UsageReport {
  const timezone = cfg.browser.timezone;
  const dateAt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format;
  const today = dateAt(now), anchor = Date.parse(`${today}T12:00:00Z`);
  const dates = Array.from({ length: days }, (_, i) => new Date(anchor - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
  const users = root.prepare('SELECT id,username,role FROM owners ORDER BY created_at,id').all() as { id: string; username: string; role: string }[];
  const accounts = users.map(user => {
    const buckets = new Map(dates.map(date => [date, { date, ...empty(), total: 0 } as UsageDay]));
    let db: Db | null = null, temporary: Db | null = null;
    let available = true, collectionStartedAt: number | null = null, firstRecordAt: number | null = null;
    try {
      const file = path.join(cfg.dataDir, 'users', userNamespace(user.id), 'agent.sqlite');
      db = user.role === 'owner' ? root : fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
      if (!db && root.prepare('SELECT value FROM meta WHERE key=?').get(`sandbox_port:${user.id}`)) available = false;
      if (db) {
        let source = db;
        if (!db.prepare("SELECT name FROM sqlite_master WHERE name='token_usage'").get()) {
          temporary = new DatabaseSync(':memory:');
          new UsageLedger(temporary, user.id).backfill(db); source = temporary;
        } else collectionStartedAt = (db.prepare("SELECT value FROM token_usage_meta WHERE key='collection_started'").get() as { value: number } | undefined)?.value ?? null;
        firstRecordAt = (source.prepare('SELECT MIN(created_at) at FROM token_usage').get() as { at: number | null }).at;
        // Three-day padding covers all IANA offsets and DST; partition by local calendar date below.
        const since = Date.parse(`${dates[0]}T00:00:00Z`) - 3 * 86400000;
        for (const row of source.prepare('SELECT created_at,input,output,cached,cache_write FROM token_usage WHERE created_at>=? AND created_at<=?').iterate(since, now) as Iterable<{ created_at: number; input: number; output: number; cached: number; cache_write: number }>) {
          const bucket = buckets.get(dateAt(row.created_at));
          if (bucket) { bucket.input += row.input; bucket.output += row.output; bucket.cached += row.cached; bucket.cacheWrite += row.cache_write; bucket.total += row.input + row.output; }
        }
      }
    } catch { available = false; } finally { temporary?.close(); if (db && db !== root) db.close(); }
    if (!available) for (const bucket of buckets.values()) Object.assign(bucket, empty(), { total: 0 });
    const values = [...buckets.values()];
    const totals = values.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total }), { ...empty(), total: 0 });
    return { ...user, available, collectionStartedAt, firstRecordAt, days: values, totals };
  });
  return { timezone, days, dates, accounts, generatedAt: now };
}
