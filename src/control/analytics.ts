import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { userNamespace } from "./auth/workspaceHost.js";
import { PLATFORMS, type ActiveAccount, type AnalyticsDay, type AnalyticsReport, type Platform } from "../common/analytics.js";

/**
 * First-party product analytics: one table in the central control database,
 * read only by the owner's statistics page. An event is a name, a time, the
 * account (if signed in), the platform and a few small properties; never
 * message text, task content, emails, IPs or anything that identifies a device.
 * Task figures are not recorded here: they are counted from each account's own
 * task table when the report is read, so they also cover the time before events.
 */

/** Events older than this are deleted at start. */
const RETENTION_MS = 400 * 86400000;
const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PROPS = 8;
const MAX_STRING = 64;
const GADGET_PREFIX = "gadget:";
const FAILED = new Set(["failed", "planning_failed", "unknown"]);

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

export class Analytics {
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

  /** Reads control-plane stores only (opens members' databases read-only); does not wake any runtime. */
  report(cfg: Config, days: number, now = Date.now()): AnalyticsReport {
    const timezone = cfg.browser.timezone;
    const dateAt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format;
    const today = dateAt(now), anchor = Date.parse(`${today}T12:00:00Z`);
    const window = Math.max(days, 30);
    const allDates = Array.from({ length: window }, (_, i) => new Date(anchor - (window - 1 - i) * 86400000).toISOString().slice(0, 10));
    const dates = allDates.slice(-days);
    // Three-day padding covers all IANA offsets and DST; rows are partitioned by local date below.
    const since = Date.parse(`${allDates[0]}T00:00:00Z`) - 3 * 86400000;
    const inRange = new Set(dates);
    const daily = new Map<string, AnalyticsDay>(dates.map(date => [date, { date, active: 0, signups: 0, logins: 0, tasks: 0, completed: 0, failed: 0 }]));
    // Who was active on each date of the wider window (for the 7/30-day figures).
    const activeOn = new Map<string, Set<string>>(allDates.map(date => [date, new Set()]));
    // Today's detail per active account, for the list behind the "active today" figure.
    const todayBy = new Map<string, { lastSeenAt: number; events: number; tasks: number; platforms: Set<string> }>();
    const mark = (date: string, userId: string | null, at: number, kind: "event" | "task", platform: string | null = null) => {
      if (!userId) return;
      activeOn.get(date)?.add(userId);
      if (date !== today) return;
      const a = todayBy.get(userId) ?? { lastSeenAt: 0, events: 0, tasks: 0, platforms: new Set<string>() };
      a.lastSeenAt = Math.max(a.lastSeenAt, at);
      if (kind === "event") a.events++; else a.tasks++;
      if (platform) a.platforms.add(platform);
      todayBy.set(userId, a);
    };

    const users = this.db.prepare("SELECT id,username,role,created_at FROM owners ORDER BY created_at,id").all() as Array<{ id: string; username: string; role: string; created_at: number }>;
    for (const u of users) { const d = daily.get(dateAt(u.created_at)); if (d) d.signups++; }

    const events = new Map<string, { count: number; users: Set<string> }>();
    const platforms = new Map<string, { users: Set<string>; events: number }>();
    // The funnel compares like with like: register-page views and the password sign-ups made from that page,
    // both recorded as events (account creation dates reach back before views were recorded).
    let registerViews = 0, loginViews = 0, formSignups = 0;
    for (const row of this.db.prepare("SELECT ts,name,user_id,platform,props FROM analytics_events WHERE ts>=? AND ts<=?").iterate(since, now) as Iterable<{ ts: number; name: string; user_id: string | null; platform: string | null; props: string | null }>) {
      const date = dateAt(row.ts);
      mark(date, row.user_id, row.ts, "event", row.platform);
      if (!inRange.has(date)) continue;
      const e = events.get(row.name) ?? { count: 0, users: new Set<string>() };
      e.count++; if (row.user_id) e.users.add(row.user_id); events.set(row.name, e);
      const p = platforms.get(row.platform ?? "unknown") ?? { users: new Set<string>(), events: 0 };
      p.events++; if (row.user_id) p.users.add(row.user_id); platforms.set(row.platform ?? "unknown", p);
      if (row.name === "login") daily.get(date)!.logins++;
      if (row.name === "signup" && row.props && (JSON.parse(row.props) as EventProps).method === "password") formSignups++;
      if (row.name === "auth_view") {
        const mode = row.props ? (JSON.parse(row.props) as EventProps).mode : null;
        if (mode === "register") registerViews++; else if (mode === "login") loginViews++;
      }
    }

    const totals: AnalyticsReport["totals"] = { accounts: users.length, signups: 0, activeToday: 0, active7: 0, active30: 0, tasks: 0, completed: 0, failed: 0, sources: { manual: 0, schedule: 0, gadget: 0 } };
    for (const user of users) {
      let db: Db | null = null;
      try {
        const file = path.join(cfg.dataDir, "users", userNamespace(user.id), "agent.sqlite");
        db = user.role === "owner" ? this.db : fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
        if (!db || !db.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get()) continue;
        // Supplements merged into another task are part of that task, not tasks of their own.
        for (const t of db.prepare("SELECT t.created_at,t.status,t.schedule_id,t.client_message_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE c.owner_id=? AND t.merged_into IS NULL AND t.created_at>=? AND t.created_at<=?").iterate(user.id, since, now) as Iterable<{ created_at: number; status: string; schedule_id: string | null; client_message_id: string }>) {
          const date = dateAt(t.created_at);
          const scheduled = Boolean(t.schedule_id), gadget = t.client_message_id.startsWith(GADGET_PREFIX);
          // A schedule running on its own is not the person using the product.
          if (!scheduled) mark(date, user.id, t.created_at, "task");
          const d = daily.get(date);
          if (!d) continue;
          d.tasks++; totals.tasks++;
          if (t.status === "completed") { d.completed++; totals.completed++; }
          else if (FAILED.has(t.status)) { d.failed++; totals.failed++; }
          totals.sources[scheduled ? "schedule" : gadget ? "gadget" : "manual"]++;
        }
      } catch (err) {
        this.log?.warn("analytics: tasks not counted for an account", { error: err instanceof Error ? err.message : String(err) });
      } finally { if (db && db !== this.db) db.close(); }
    }

    for (const d of daily.values()) { d.active = activeOn.get(d.date)!.size; totals.signups += d.signups; }
    const distinct = (n: number) => new Set(allDates.slice(-n).flatMap(date => [...activeOn.get(date)!])).size;
    totals.activeToday = distinct(1); totals.active7 = distinct(7); totals.active30 = distinct(30);
    const byId = new Map(users.map(u => [u.id, u]));
    const activeTodayAccounts: ActiveAccount[] = [...todayBy].map(([id, a]) => ({
      username: byId.get(id)?.username ?? null, role: byId.get(id)?.role ?? null,
      lastSeenAt: a.lastSeenAt, events: a.events, tasks: a.tasks, platforms: [...a.platforms].sort(),
    })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const started = this.db.prepare("SELECT value FROM meta WHERE key='analytics_started'").get() as { value: string } | undefined;
    return {
      timezone, days, dates, generatedAt: now, totals,
      daily: [...daily.values()],
      activeTodayAccounts,
      events: [...events].map(([name, e]) => ({ name, count: e.count, users: e.users.size })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      platforms: [...platforms].map(([platform, p]) => ({ platform, users: p.users.size, events: p.events })).sort((a, b) => b.events - a.events),
      funnel: { registerViews, loginViews, signups: formSignups },
      collectionStartedAt: started ? Number(started.value) : null,
    };
  }
}
