import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { userNamespace } from "./auth/workspaceHost.js";
import {
  FEATURES, PLATFORMS,
  type AccountRow, type ActiveAccount, type AnalyticsDay, type AnalyticsReport, type Cohort, type Feature, type FunnelEntry, type PeriodTotals, type Platform, type TaskQuality,
} from "../common/analytics.js";

/**
 * First-party product analytics: one table in the central control database,
 * read only by the owner's statistics page. An event is a name, a time, the
 * account (if signed in), the platform and a few small properties; never
 * message text, task content, file names, URLs, emails, IPs or anything that
 * identifies a device. Task figures are not recorded here: they are counted
 * from each account's own task table when the report is read, so they also
 * cover the time before events.
 */

/** Events older than this are deleted at start. */
const RETENTION_MS = 400 * 86400000;
const DAY = 86400000;
const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PROPS = 8;
const MAX_STRING = 64;
const GADGET_PREFIX = "gadget:";
const FAILED = new Set(["failed", "planning_failed", "unknown"]);
/** Events that are not the account using the product: someone visiting its page, its browser failing to come back. */
const PASSIVE = new Set(["clawpage_visit", "browser_restore_failed", "login_failed"]);
/** Throttled events remembered at most this many keys (`trackOnce`). */
const ONCE_KEYS = 5000;

export type EventProps = Record<string, string | number | boolean>;

/** Small scalar properties only; anything else is dropped rather than stored. */
export function cleanProps(raw: unknown): EventProps {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EventProps = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_PROPS || !PROP_KEY.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    else if (typeof value === "string" && value.length <= MAX_STRING) out[key] = value;
  }
  return out;
}

/** The platform a request names in `x-client-platform`; unknown values are not recorded. */
export function platformOf(header: string | undefined): Platform | null {
  return PLATFORMS.includes(header as Platform) ? (header as Platform) : null;
}

/** A tool's name as a property: a fixed identifier, never anything an executor wrote. */
export function toolName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) ? name : "other";
}

/** A file's kind from its extension, so a download says what was saved without naming it. */
export function fileKind(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (/^(png|jpe?g|gif|webp|heic|avif|bmp|svg)$/.test(ext)) return "image";
  if (/^(mp4|mov|m4v|webm)$/.test(ext)) return "video";
  if (/^(mp3|m4a|wav|ogg|aac)$/.test(ext)) return "audio";
  if (/^(pdf|docx?|xlsx?|pptx?|csv|txt|md|pages|numbers|key)$/.test(ext)) return "document";
  if (/^(zip|tar|gz|tgz|7z|rar)$/.test(ext)) return "archive";
  return "other";
}

/** Which features an event counts towards (the task-based ones are counted from the task tables). */
function featuresOf(name: string, p: EventProps): Feature[] {
  switch (name) {
    case "task_submit": {
      const images = Number(p.images) || 0, files = (Number(p.attachments) || 0) - images;
      return [...(files > 0 ? ["attachment" as const] : []), ...(images > 0 ? ["photo" as const] : [])];
    }
    case "voice_input": return p.ok === true ? ["voice_input"] : [];
    case "schedule_create": return ["schedule_create"];
    case "browser_takeover": case "user_browser_takeover": return ["browser_takeover"];
    case "clawpage_publish": return p.created === true ? ["clawpage_publish", "clawpage_create"] : ["clawpage_publish"];
    case "clawpage_visit": return ["clawpage_visit"];
    case "shared_kb_create": case "shared_kb_invite": case "shared_kb_join": return [name];
    case "knowledge_use": case "kb_use": return ["knowledge_use"];
    case "image_generate": return p.ok === false ? [] : p.animated === true ? ["image_generate", "image_gif"] : ["image_generate"];
    case "file_download": case "file_save": return ["file_save"];
    case "welcome_card": return ["welcome_card"];
    case "push_subscribe": return ["push_subscribe"];
    default: return [];
  }
}

const quantile = (values: number[], q = 0.5): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

const parse = (props: string | null): EventProps => {
  if (!props) return {};
  try { return JSON.parse(props) as EventProps; } catch { return {}; }
};

export class Analytics {
  #once = new Map<string, number>();

  constructor(private db: Db, private log?: Logger, now = Date.now()) {
    db.exec(`CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, name TEXT NOT NULL,
      user_id TEXT, platform TEXT, props TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics_events(ts);
    CREATE INDEX IF NOT EXISTS idx_analytics_name ON analytics_events(name, ts);`);
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('analytics_started',?)").run(String(now));
    db.prepare("DELETE FROM analytics_events WHERE ts<?").run(now - RETENTION_MS);
  }

  /** Record one event. Never throws: analytics must not break the request it describes. */
  track(name: string, e: { userId?: string | null; platform?: string | null; props?: unknown } = {}, at = Date.now()): void {
    try {
      const props = cleanProps(e.props);
      this.db.prepare("INSERT INTO analytics_events(ts,name,user_id,platform,props) VALUES(?,?,?,?,?)")
        .run(at, name, e.userId ?? null, platformOf(e.platform ?? undefined), Object.keys(props).length ? JSON.stringify(props) : null);
    } catch (err) {
      this.log?.warn("analytics event not recorded", { name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Record an event at most once per `key` every `everyMs`: frequent, repetitive
   * things (an executor reading the knowledge base, a visitor reloading a page)
   * count as one use per window instead of filling the table.
   */
  trackOnce(key: string, everyMs: number, name: string, e: Parameters<Analytics["track"]>[1] = {}, at = Date.now()): void {
    const last = this.#once.get(key);
    if (last !== undefined && at - last < everyMs) return;
    if (this.#once.size >= ONCE_KEYS) {
      for (const [k, t] of this.#once) if (at - t >= everyMs) this.#once.delete(k);
      if (this.#once.size >= ONCE_KEYS) this.#once.clear();
    }
    this.#once.set(key, at);
    this.track(name, e, at);
  }

  /** Reads control-plane stores only (opens members' databases read-only); does not wake any runtime. */
  report(cfg: Config, days: number, now = Date.now()): AnalyticsReport {
    const timezone = cfg.browser.timezone;
    const dateAt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format;
    const today = dateAt(now), anchor = Date.parse(`${today}T12:00:00Z`);
    const shift = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
    // The range, the same number of days before it (for the change figures) and at least 30 days (for the monthly figures).
    const window = Math.max(2 * days, 30);
    const allDates = Array.from({ length: window }, (_, i) => new Date(anchor - (window - 1 - i) * DAY).toISOString().slice(0, 10));
    const dates = allDates.slice(-days);
    const prevDates = allDates.slice(-2 * days, -days);
    // Three-day padding covers all IANA offsets and DST; rows are partitioned by local date below.
    const since = Date.parse(`${allDates[0]}T00:00:00Z`) - 3 * DAY;
    const inRange = new Set(dates), inPrev = new Set(prevDates);
    const periodOf = (date: string) => (inRange.has(date) ? "current" : inPrev.has(date) ? "previous" : null);
    const daily = new Map<string, AnalyticsDay>(dates.map(date => [date, { date, active: 0, signups: 0, logins: 0, tasks: 0, completed: 0, failed: 0, sessions: 0, wau: 0 }]));
    const blank = (): PeriodTotals => ({ active: 0, signups: 0, tasks: 0, completed: 0, failed: 0, interrupted: 0, sessions: 0, medianTaskMs: null });
    const period = { current: blank(), previous: blank() };
    const durations = { current: [] as number[], previous: [] as number[] };

    // Who was active on each date of the window, and each account's figures.
    const activeOn = new Map<string, Set<string>>(allDates.map(date => [date, new Set()]));
    type Acc = { lastSeenAt: number | null; days: Set<string>; sessions: number; tasks: number; completed: number; failed: number; platforms: Set<string>; model: string | null; modelAt: number; firstTask: number | null; firstCompleted: number | null };
    const accs = new Map<string, Acc>();
    const acc = (id: string) => {
      let a = accs.get(id);
      if (!a) accs.set(id, a = { lastSeenAt: null, days: new Set(), sessions: 0, tasks: 0, completed: 0, failed: 0, platforms: new Set(), model: null, modelAt: 0, firstTask: null, firstCompleted: null });
      return a;
    };
    // Today's detail per active account, for the list behind the "active today" figure.
    const todayBy = new Map<string, { lastSeenAt: number; events: number; tasks: number; platforms: Set<string> }>();
    const mark = (date: string, userId: string, at: number, kind: "event" | "task", platform: string | null = null) => {
      activeOn.get(date)?.add(userId);
      const a = acc(userId);
      a.lastSeenAt = Math.max(a.lastSeenAt ?? 0, at);
      if (inRange.has(date)) { a.days.add(date); if (platform) a.platforms.add(platform); }
      if (date !== today) return;
      const d = todayBy.get(userId) ?? { lastSeenAt: 0, events: 0, tasks: 0, platforms: new Set<string>() };
      d.lastSeenAt = Math.max(d.lastSeenAt, at);
      if (kind === "event") d.events++; else d.tasks++;
      if (platform) d.platforms.add(platform);
      todayBy.set(userId, d);
    };

    const users = this.db.prepare("SELECT id,username,role,created_at FROM owners ORDER BY created_at,id").all() as Array<{ id: string; username: string; role: string; created_at: number }>;
    for (const u of users) {
      const date = dateAt(u.created_at), p = periodOf(date);
      const d = daily.get(date); if (d) d.signups++;
      if (p) period[p].signups++;
    }

    const events = new Map<string, { count: number; users: Set<string> }>();
    const platforms = new Map<string, { users: Set<string>; events: number }>();
    const features = new Map<Feature, { count: number; users: Set<string>; prevUsers: Set<string> }>(FEATURES.map(f => [f, { count: 0, users: new Set(), prevUsers: new Set() }]));
    const useFeature = (f: Feature, date: string, userId: string | null) => {
      const x = features.get(f)!;
      if (inRange.has(date)) { x.count++; if (userId) x.users.add(userId); }
      else if (inPrev.has(date) && userId) x.prevUsers.add(userId);
    };
    const versions = new Map<string, { platform: string; version: string; users: Set<string> }>();
    const welcome = new Map<string, { count: number; users: Set<string> }>();
    const quality = { stops: 0, retries: 0, reports: 0, restoreFailures: 0 };
    // The funnel compares like with like: register-page views and the password sign-ups made from that page,
    // both recorded as events (account creation dates reach back before views were recorded).
    let registerViews = 0, loginViews = 0, formSignups = 0;
    for (const row of this.db.prepare("SELECT ts,name,user_id,platform,props FROM analytics_events WHERE ts>=? AND ts<=?").iterate(since, now) as Iterable<{ ts: number; name: string; user_id: string | null; platform: string | null; props: string | null }>) {
      const date = dateAt(row.ts), props = parse(row.props), p = periodOf(date);
      // An executor's tool use is the agent at work (perhaps on a schedule), not the person.
      const passive = PASSIVE.has(row.name) || props.via === "agent";
      if (row.user_id && !passive) mark(date, row.user_id, row.ts, "event", row.platform);
      for (const f of featuresOf(row.name, props)) useFeature(f, date, row.user_id);
      if (row.name === "app_open" && p) {
        period[p].sessions++;
        if (p === "current" && row.user_id) acc(row.user_id).sessions++;
      }
      if (!inRange.has(date)) continue;
      const day = daily.get(date)!;
      const e = events.get(row.name) ?? { count: 0, users: new Set<string>() };
      e.count++; if (row.user_id) e.users.add(row.user_id); events.set(row.name, e);
      const pl = platforms.get(row.platform ?? "unknown") ?? { users: new Set<string>(), events: 0 };
      pl.events++; if (row.user_id) pl.users.add(row.user_id); platforms.set(row.platform ?? "unknown", pl);
      switch (row.name) {
        case "login": day.logins++; break;
        case "signup": if (props.method === "password") formSignups++; break;
        case "auth_view": if (props.mode === "register") registerViews++; else if (props.mode === "login") loginViews++; break;
        case "app_open": {
          day.sessions!++;
          if (typeof props.ui === "string" && row.user_id) {
            const key = `${row.platform ?? "unknown"}|${props.ui}`;
            const v = versions.get(key) ?? { platform: row.platform ?? "unknown", version: props.ui, users: new Set<string>() };
            v.users.add(row.user_id); versions.set(key, v);
          }
          break;
        }
        case "welcome_card": {
          const key = `${props.kind === "starter" ? "starter" : "feature"}:${typeof props.card === "string" || typeof props.card === "number" ? props.card : "other"}`;
          const w = welcome.get(key) ?? { count: 0, users: new Set<string>() };
          w.count++; if (row.user_id) w.users.add(row.user_id); welcome.set(key, w);
          break;
        }
        case "task_stop": quality.stops++; break;
        case "task_retry": case "retry_tap": quality.retries++; break;
        case "support_request": if (props.kind === "content") quality.reports++; break;
        case "browser_restore_failed": quality.restoreFailures++; break;
      }
    }

    const totals: AnalyticsReport["totals"] = { accounts: users.length, signups: 0, activeToday: 0, active7: 0, active30: 0, tasks: 0, completed: 0, failed: 0, sources: { manual: 0, schedule: 0, gadget: 0 } };
    const outcomes: TaskQuality["outcomes"] = { completed: 0, failed: 0, interrupted: 0, unknown: 0, other: 0 };
    for (const user of users) {
      let db: Db | null = null;
      try {
        const file = path.join(cfg.dataDir, "users", userNamespace(user.id), "agent.sqlite");
        db = user.role === "owner" ? this.db : fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
        if (!db || !db.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get()) continue;
        // Supplements merged into another task are part of that task, not tasks of their own.
        for (const t of db.prepare("SELECT t.created_at,t.completed_at,t.status,t.schedule_id,t.client_message_id,t.model FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE c.owner_id=? AND t.merged_into IS NULL AND t.created_at>=? AND t.created_at<=?").iterate(user.id, since, now) as Iterable<{ created_at: number; completed_at: number | null; status: string; schedule_id: string | null; client_message_id: string; model: string | null }>) {
          const date = dateAt(t.created_at), p = periodOf(date);
          const scheduled = Boolean(t.schedule_id), gadget = t.client_message_id.startsWith(GADGET_PREFIX);
          const a = acc(user.id);
          if (t.model && t.created_at >= a.modelAt) { a.model = t.model; a.modelAt = t.created_at; }
          // A schedule running on its own is not the person using the product.
          if (!scheduled) {
            mark(date, user.id, t.created_at, "task");
            if (a.firstTask === null || t.created_at < a.firstTask) a.firstTask = t.created_at;
            if (t.status === "completed" && (a.firstCompleted === null || t.created_at < a.firstCompleted)) a.firstCompleted = t.created_at;
          }
          useFeature(scheduled ? "task_scheduled" : gadget ? "task_gadget" : "task_typed", date, user.id);
          if (!p) continue;
          const failed = FAILED.has(t.status);
          const pt = period[p];
          pt.tasks++;
          if (t.status === "completed") { pt.completed++; if (t.completed_at && t.completed_at >= t.created_at) durations[p].push(t.completed_at - t.created_at); }
          else if (failed) pt.failed++;
          else if (t.status === "interrupted") pt.interrupted++;
          const d = daily.get(date);
          if (!d) continue;
          d.tasks++; totals.tasks++;
          a.tasks++;
          if (t.status === "completed") { d.completed++; totals.completed++; a.completed++; outcomes.completed++; }
          else if (failed) { d.failed++; totals.failed++; a.failed++; if (t.status === "unknown") outcomes.unknown++; else outcomes.failed++; }
          else if (t.status === "interrupted") outcomes.interrupted++;
          else outcomes.other++;
          totals.sources[scheduled ? "schedule" : gadget ? "gadget" : "manual"]++;
        }
      } catch (err) {
        this.log?.warn("analytics: tasks not counted for an account", { error: err instanceof Error ? err.message : String(err) });
      } finally { if (db && db !== this.db) db.close(); }
    }

    const distinct = (list: string[]) => new Set(list.flatMap(date => [...activeOn.get(date)!])).size;
    for (const d of daily.values()) {
      d.active = activeOn.get(d.date)!.size; totals.signups += d.signups;
      d.wau = distinct(allDates.slice(Math.max(0, allDates.indexOf(d.date) - 6), allDates.indexOf(d.date) + 1));
    }
    totals.activeToday = distinct(allDates.slice(-1)); totals.active7 = distinct(allDates.slice(-7)); totals.active30 = distinct(allDates.slice(-30));
    period.current.active = distinct(dates); period.previous.active = distinct(prevDates);
    period.current.medianTaskMs = quantile(durations.current); period.previous.medianTaskMs = quantile(durations.previous);

    // Activation and retention of the accounts that signed up in the range.
    const signedUp = users.filter(u => inRange.has(dateAt(u.created_at)));
    const back = (id: string, date: string, from: number, to: number) => {
      for (let n = from; n <= to; n++) if (activeOn.get(shift(date, n))?.has(id)) return true;
      return false;
    };
    const eligible = (date: string, n: number) => shift(date, n) <= today;
    const activation: FunnelEntry[] = [
      { step: "register_view", count: registerViews, eligible: null },
      { step: "signup", count: signedUp.length, eligible: null },
      { step: "first_task", count: signedUp.filter(u => accs.get(u.id)?.firstTask != null).length, eligible: null },
      { step: "first_completed", count: signedUp.filter(u => accs.get(u.id)?.firstCompleted != null).length, eligible: null },
      { step: "day1", count: signedUp.filter(u => eligible(dateAt(u.created_at), 1) && back(u.id, dateAt(u.created_at), 1, 1)).length, eligible: signedUp.filter(u => eligible(dateAt(u.created_at), 1)).length },
      { step: "day7", count: signedUp.filter(u => eligible(dateAt(u.created_at), 7) && back(u.id, dateAt(u.created_at), 1, 7)).length, eligible: signedUp.filter(u => eligible(dateAt(u.created_at), 7)).length },
    ];
    const weekOf = (date: string) => shift(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    const cohortMap = new Map<string, Cohort>();
    for (const u of signedUp) {
      const date = dateAt(u.created_at), start = weekOf(date);
      const c = cohortMap.get(start) ?? { start, size: 0, d1: { eligible: 0, retained: 0 }, d7: { eligible: 0, retained: 0 } };
      c.size++;
      if (eligible(date, 1)) { c.d1.eligible++; if (back(u.id, date, 1, 1)) c.d1.retained++; }
      if (eligible(date, 7)) { c.d7.eligible++; if (back(u.id, date, 1, 7)) c.d7.retained++; }
      cohortMap.set(start, c);
    }

    const byId = new Map(users.map(u => [u.id, u]));
    const activeTodayAccounts: ActiveAccount[] = [...todayBy].map(([id, a]) => ({
      username: byId.get(id)?.username ?? null, role: byId.get(id)?.role ?? null,
      lastSeenAt: a.lastSeenAt, events: a.events, tasks: a.tasks, platforms: [...a.platforms].sort(),
    })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const accounts: AccountRow[] = users.map(u => {
      const a = accs.get(u.id);
      return {
        id: u.id, username: u.username, role: u.role, createdAt: u.created_at, lastSeenAt: a?.lastSeenAt ?? null,
        activeDays: a?.days.size ?? 0, sessions: a?.sessions ?? 0, tasks: a?.tasks ?? 0, completed: a?.completed ?? 0, failed: a?.failed ?? 0,
        platforms: [...(a?.platforms ?? [])].sort(), model: a?.model ?? null,
      };
    }).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.username.localeCompare(b.username));
    const started = this.db.prepare("SELECT value FROM meta WHERE key='analytics_started'").get() as { value: string } | undefined;
    return {
      timezone, days, dates, generatedAt: now, totals,
      daily: [...daily.values()],
      activeTodayAccounts,
      events: [...events].map(([name, e]) => ({ name, count: e.count, users: e.users.size })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      platforms: [...platforms].map(([platform, p]) => ({ platform, users: p.users.size, events: p.events })).sort((a, b) => b.events - a.events),
      funnel: { registerViews, loginViews, signups: formSignups },
      collectionStartedAt: started ? Number(started.value) : null,
      current: period.current,
      previous: period.previous,
      activation,
      cohorts: [...cohortMap.values()].sort((a, b) => a.start.localeCompare(b.start)),
      features: [...features].map(([feature, f]) => ({ feature, count: f.count, users: f.users.size, prevUsers: f.prevUsers.size })),
      quality: { outcomes, medianMs: period.current.medianTaskMs, p90Ms: quantile(durations.current, 0.9), ...quality },
      accounts,
      versions: [...versions.values()].map(v => ({ platform: v.platform, version: v.version, users: v.users.size })).sort((a, b) => b.users - a.users || b.version.localeCompare(a.version)),
      welcomeCards: [...welcome].map(([card, w]) => ({ card, count: w.count, users: w.users.size })).sort((a, b) => b.count - a.count || a.card.localeCompare(b.card)),
    };
  }
}
