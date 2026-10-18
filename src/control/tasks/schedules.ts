/**
 * Scheduled and recurring tasks: the rule a person asked for ("明早 9 点",
 * "每天 8 点", "每周一三", "每 2 小时"), when it runs next in their time zone,
 * and how to say it back to them (in the language this code runs for). Pure
 * functions; the task service stores the schedules and starts each run.
 */
import { t } from "../i18n/index.js";

export type ScheduleKind = "once" | "daily" | "weekly" | "monthly" | "interval" | "dates";

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** Local "HH:MM" (once, daily, weekly, monthly); with `times`, the first of them. */
  at?: string;
  /** Several local "HH:MM" a day, in order (daily, weekly, monthly). */
  times?: string[];
  /** Irregular local "YYYY-MM-DD HH:MM" moments, in order (dates). */
  dates?: string[];
  /** Local "YYYY-MM-DD" (once). */
  date?: string;
  /** 1 = Monday … 7 = Sunday (weekly). */
  weekdays?: number[];
  /** 1-31, the last day of a shorter month (monthly). */
  monthDay?: number;
  /** Minutes between runs (interval), from `anchorAt`. */
  everyMinutes?: number;
  anchorAt?: number;
  /** Stop after this many runs. */
  maxRuns?: number | null;
  /** Last local day ("YYYY-MM-DD") a run may happen on. */
  until?: string | null;
}

/** Shorter intervals would mostly burn model time on unchanged answers. */
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_ACTIVE_SCHEDULES = 20;
export const MAX_TIMES_A_DAY = 12;
export const MAX_DATES = 60;

const KINDS: ScheduleKind[] = ["once", "daily", "weekly", "monthly", "interval", "dates"];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOMENT = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
/** For the dispatcher, which reads English. */
const WEEKDAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Local { y: number; m: number; d: number; h: number; mi: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function local(ts: number, tz: string): Local {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday!) + 1 };
}

/** The instant a local wall-clock time names in `tz` (a time skipped by DST lands just after the gap). */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = local(guess, tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - wanted;
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}

function calendar(y: number, m: number, d: number) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: ((t.getUTCDay() + 6) % 7) + 1 };
}

const hm = (at: string) => { const [, h, mi] = TIME.exec(at)!; return [+h!, +mi!] as const; };
const ymd = (date: string) => { const [, y, m, d] = DATE.exec(date)!; return [+y!, +m!, +d!] as const; };
/** The times of day a rule runs at. */
const timesOf = (spec: ScheduleSpec) => spec.times?.length ? spec.times : [spec.at!];
const momentAt = (moment: string, tz: string) => { const [date, time] = moment.split(" "); return zonedTime(...ymd(date!), ...hm(time!), tz); };

/** The first run strictly after `after`, or null when the rule has none left. */
export function nextRun(spec: ScheduleSpec, after: number, tz: string): number | null {
  let next: number | null = null;
  if (spec.kind === "interval") {
    const step = spec.everyMinutes! * 60_000;
    const anchor = spec.anchorAt ?? after;
    next = after < anchor + step ? anchor + step : anchor + (Math.floor((after - anchor) / step) + 1) * step;
  } else if (spec.kind === "once") {
    const [y, m, d] = ymd(spec.date!);
    const t = zonedTime(y, m, d, ...hm(spec.at!), tz);
    next = t > after ? t : null;
  } else if (spec.kind === "dates") {
    next = spec.dates!.map((moment) => momentAt(moment, tz)).filter((t) => t > after).sort((a, b) => a - b)[0] ?? null;
  } else {
    const times = timesOf(spec).map(hm);
    // The earliest of the day's times still ahead, on the first day that has one.
    const firstOn = (y: number, m: number, d: number) => times.map(([h, mi]) => zonedTime(y, m, d, h, mi, tz)).filter((t) => t > after).sort((a, b) => a - b)[0] ?? null;
    const today = local(after, tz);
    if (spec.kind === "monthly") {
      for (let i = 0; i < 14 && next === null; i++) {
        const first = calendar(today.y, today.m + i, 1);
        const last = calendar(first.y, first.m + 1, 0).d;
        next = firstOn(first.y, first.m, Math.min(spec.monthDay!, last));
      }
    } else {
      for (let i = 0; i < 9 && next === null; i++) {
        const day = calendar(today.y, today.m, today.d + i);
        if (spec.kind === "weekly" && !spec.weekdays!.includes(day.weekday)) continue;
        next = firstOn(day.y, day.m, day.d);
      }
    }
  }
  if (next !== null && spec.until) {
    const [y, m, d] = ymd(spec.until);
    if (next >= zonedTime(y, m, d + 1, 0, 0, tz)) return null;
  }
  return next;
}

const validDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const [y, m, d] = ymd(s);
  const c = calendar(y, m, d);
  return c.y === y && c.m === m && c.d === d;
};

/**
 * A schedule the dispatcher proposed, checked and normalised; or why it cannot
 * be used. `now` anchors intervals and rules out a one-off time already past.
 */
export function validateSchedule(raw: unknown, now: number, tz: string): { spec: ScheduleSpec; next: number } | { error: string } {
  const invalid = t().tasks.schedules.invalid;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: invalid.notObject };
  const r = raw as Record<string, unknown>;
  const kind = r.kind as ScheduleKind;
  if (!KINDS.includes(kind)) return { error: invalid.kind(KINDS.join("/")) };
  const spec: ScheduleSpec = { kind };
  if (kind === "interval") {
    const every = Number(r.everyMinutes);
    if (!Number.isInteger(every) || every < MIN_INTERVAL_MINUTES || every > 31 * 24 * 60) return { error: invalid.everyMinutes(MIN_INTERVAL_MINUTES, 31 * 24 * 60) };
    spec.everyMinutes = every;
    spec.anchorAt = now;
  } else if (kind === "dates") {
    const dates = Array.isArray(r.dates) ? [...new Set(r.dates.map((d) => String(d).trim().replace("T", " ")))].sort() : [];
    if (!dates.length || dates.length > MAX_DATES) return { error: invalid.dates(MAX_DATES) };
    const bad = dates.find((d) => !MOMENT.test(d) || !validDate(d.slice(0, 10)));
    if (bad) return { error: invalid.badDate(bad) };
    spec.dates = dates;
  } else if (kind !== "once" && Array.isArray(r.times) && r.times.length) {
    const times = [...new Set(r.times.map(String))].sort();
    if (times.length > MAX_TIMES_A_DAY || times.some((t) => !TIME.test(t))) return { error: invalid.times(MAX_TIMES_A_DAY) };
    spec.at = times[0];
    if (times.length > 1) spec.times = times;
  } else {
    if (typeof r.at !== "string" || !TIME.test(r.at)) return { error: invalid.at };
    spec.at = r.at;
  }
  if (kind === "once") {
    if (!validDate(r.date)) return { error: invalid.date };
    spec.date = r.date;
  }
  if (kind === "weekly") {
    const days = Array.isArray(r.weekdays) ? [...new Set(r.weekdays.map(Number))].sort() : [];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { error: invalid.weekdays };
    spec.weekdays = days;
  }
  if (kind === "monthly") {
    const day = Number(r.monthDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) return { error: invalid.monthDay };
    spec.monthDay = day;
  }
  if (r.maxRuns != null) {
    const n = Number(r.maxRuns);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return { error: invalid.maxRuns };
    if (kind !== "once" && kind !== "dates") spec.maxRuns = n;
  }
  if (r.until != null) {
    if (!validDate(r.until)) return { error: invalid.until };
    if (kind !== "once" && kind !== "dates") spec.until = r.until;
  }
  const next = nextRun(spec, now, tz);
  if (next === null) return { error: kind === "once" ? invalid.past : kind === "dates" ? invalid.allPast : invalid.noNext };
  return { spec, next };
}

/** The rule in words: "每天 08:00", "Every Mon, Wed at 09:30", "Cada 2 horas", "10月8日 09:00、10月15日 14:30（共 2 次）"… */
export function describeSchedule(spec: ScheduleSpec): string {
  const words = t().tasks.schedules;
  const md = (date: string) => { const [, m, d] = ymd(date); return words.monthDay(m, d); };
  const at = spec.kind === "once" || spec.kind === "dates" || spec.kind === "interval" ? [] : timesOf(spec);
  let text: string;
  if (spec.kind === "once") text = words.rule.once(md(spec.date!), spec.at!);
  else if (spec.kind === "dates") text = words.rule.dates(spec.dates!.slice(0, 3).map((d) => `${md(d.slice(0, 10))} ${d.slice(11)}`), spec.dates!.length > 3, spec.dates!.length);
  else if (spec.kind === "daily") text = words.rule.daily(at);
  else if (spec.kind === "weekly") text = words.rule.weekly(spec.weekdays!.map((d) => words.weekdays[d - 1]!), at);
  else if (spec.kind === "monthly") text = words.rule.monthly(spec.monthDay!, at);
  else text = spec.everyMinutes! % 60 === 0 ? words.rule.hours(spec.everyMinutes! / 60) : words.rule.minutes(spec.everyMinutes!);
  if (spec.maxRuns) text += words.rule.maxRuns(spec.maxRuns);
  if (spec.until) text += words.rule.until(md(spec.until));
  return text;
}

/** An instant as the person reads it: "10月3日 周五 08:00", "Fri, Oct 3, 08:00". */
export function formatWhen(ts: number, tz: string): string {
  const words = t().tasks.schedules;
  const p = local(ts, tz);
  return words.when(words.monthDay(p.m, p.d), words.weekdays[p.weekday - 1]!, `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`);
}

/** "now" for the dispatcher: local date, weekday and time. */
export function describeNow(ts: number, tz: string): string {
  const p = local(ts, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${WEEKDAY_NAMES[p.weekday]} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}
