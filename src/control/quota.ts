import type { Db } from './db.js';
import { currentLocale, t } from './i18n/index.js';
import type { QuotaStatus } from '../common/usage.js';

/** A member's free tokens per day (input, cache included, plus output: the dashboard's total). */
export const DAILY_TOKEN_LIMIT = 100_000_000;
/** The day turns over at 02:00 Pacific time; what is left of a day is not carried over. */
export const QUOTA_TIMEZONE = 'America/Los_Angeles';
const RESET_HOUR = 2;
const DAY = 86_400_000;

const parts = new Intl.DateTimeFormat('en-US', { timeZone: QUOTA_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
/** How far Pacific wall-clock time is ahead of UTC at `at` (negative). */
function offset(at: number): number {
  const p = Object.fromEntries(parts.formatToParts(at).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
}
/**
 * The instant a Pacific wall-clock time (given as if it were UTC) happens: the earlier one when it happens twice;
 * when it never happens (the hour skipped in spring), the moment the clock jumps past it.
 */
function instant(wall: number): number {
  const tries = [offset(wall - 14 * 3_600_000), offset(wall + 14 * 3_600_000)].map(o => wall - o);
  const real = tries.filter(at => at + offset(at) === wall);
  return real.length ? Math.min(...real) : tries[0];
}

/** The quota day `now` falls in: from one 02:00 Pacific to the next. */
export function quotaWindow(now = Date.now()): { start: number; resetsAt: number } {
  const wall = now + offset(now);
  let day = Math.floor(wall / DAY) * DAY;
  if (wall - day < RESET_HOUR * 3_600_000) day -= DAY;
  return { start: instant(day + RESET_HOUR * 3_600_000), resetsAt: instant(day + DAY + RESET_HOUR * 3_600_000) };
}

/**
 * An account's use of today's quota, from its own ledger (src/control/usage.ts). Counting began when
 * the limit came in (`quota_started`), so nothing before it counts.
 */
export function quotaStatus(db: Db, now = Date.now()): QuotaStatus {
  const { start, resetsAt } = quotaWindow(now);
  const started = (db.prepare("SELECT value FROM token_usage_meta WHERE key='quota_started'").get() as { value: number } | undefined)?.value ?? now;
  const used = (db.prepare('SELECT COALESCE(SUM(input+output),0) n FROM token_usage WHERE created_at>=?').get(Math.max(start, started)) as { n: number }).n;
  return { limit: DAILY_TOKEN_LIMIT, used, resetsAt, exceeded: used >= DAILY_TOKEN_LIMIT };
}

/** The time zone the account last signed in from (its daily feed follows it, src/control/auth/loginTimezone.ts), if known. */
export function accountTimezone(db: Db): string | null {
  return (db.prepare("SELECT timezone FROM schedules WHERE builtin='daily_feed' LIMIT 1").get() as { timezone: string } | undefined)?.timezone ?? null;
}

/** What a person is told once the day's tokens are used up: when service comes back, in their own time zone and from now. */
export function limitMessage(resetsAt: number, timeZone: string, now = Date.now()): string {
  const locale = currentLocale();
  const at = new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(resetsAt);
  return t(locale).tasks.quota.exceeded(at, Math.max(1, Math.ceil((resetsAt - now) / 3_600_000)));
}

/** A new turn refused because the account has used today's tokens. */
export class DailyLimitError extends Error {
  constructor(readonly resetsAt: number, timeZone: string) {
    super(limitMessage(resetsAt, timeZone));
  }
}
