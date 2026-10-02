import { describe, expect, it } from "vitest";
import { describeNow, describeSchedule, formatWhen, nextRun, validateSchedule, zonedTime, type ScheduleSpec } from "../../src/server/tasks/schedules.js";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

describe("schedule times in the person's time zone", () => {
  it("maps a local wall-clock time to the right instant, across daylight saving", () => {
    expect(new Date(zonedTime(2026, 10, 2, 8, 0, LA)).toISOString()).toBe("2026-10-02T15:00:00.000Z"); // PDT
    expect(new Date(zonedTime(2026, 12, 2, 8, 0, LA)).toISOString()).toBe("2026-12-02T16:00:00.000Z"); // PST
    expect(new Date(zonedTime(2026, 10, 2, 8, 0, "Asia/Shanghai")).toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });

  it("runs a daily rule at the same local time on both sides of the DST change", () => {
    const daily: ScheduleSpec = { kind: "daily", at: "08:00" };
    const before = nextRun(daily, at("2026-10-31T16:00:00Z"), LA)!;   // Sat 09:00 PDT → Sun 08:00
    expect(new Date(before).toISOString()).toBe("2026-11-01T16:00:00.000Z"); // Sun Nov 1 is PST already
    expect(formatWhen(before, LA)).toBe("11月1日 周日 08:00");
    expect(nextRun(daily, at("2026-10-02T14:59:00Z"), LA)).toBe(at("2026-10-02T15:00:00Z"));
    expect(nextRun(daily, at("2026-10-02T15:00:00Z"), LA)).toBe(at("2026-10-03T15:00:00Z")); // strictly after
  });

  it("picks the next listed weekday", () => {
    const weekly: ScheduleSpec = { kind: "weekly", at: "09:30", weekdays: [1, 3] };
    // Fri Oct 2 → Mon Oct 5 09:30 PDT
    expect(formatWhen(nextRun(weekly, at("2026-10-02T20:00:00Z"), LA)!, LA)).toBe("10月5日 周一 09:30");
  });

  it("clamps a monthly day to the end of a short month", () => {
    const monthly: ScheduleSpec = { kind: "monthly", at: "10:00", monthDay: 31 };
    expect(formatWhen(nextRun(monthly, at("2026-11-05T00:00:00Z"), LA)!, LA)).toBe("11月30日 周一 10:00");
    expect(formatWhen(nextRun(monthly, at("2027-02-01T00:00:00Z"), LA)!, LA)).toBe("2月28日 周日 10:00");
  });

  it("keeps an interval on its original beat, skipping missed beats", () => {
    const anchor = at("2026-10-02T10:00:00Z");
    const every: ScheduleSpec = { kind: "interval", everyMinutes: 120, anchorAt: anchor };
    expect(nextRun(every, anchor, LA)).toBe(anchor + 2 * 3600_000);
    expect(nextRun(every, anchor + 5 * 3600_000, LA)).toBe(anchor + 6 * 3600_000);
  });

  it("ends a one-off after it ran, and a rule at its last day", () => {
    const once: ScheduleSpec = { kind: "once", at: "15:00", date: "2026-10-03" };
    expect(nextRun(once, at("2026-10-02T00:00:00Z"), LA)).toBe(at("2026-10-03T22:00:00Z"));
    expect(nextRun(once, at("2026-10-03T22:00:00Z"), LA)).toBeNull();
    const until: ScheduleSpec = { kind: "daily", at: "08:00", until: "2026-10-03" };
    expect(nextRun(until, at("2026-10-03T14:00:00Z"), LA)).toBe(at("2026-10-03T15:00:00Z"));
    expect(nextRun(until, at("2026-10-03T15:00:00Z"), LA)).toBeNull();
  });
});

describe("validating what the dispatcher proposed", () => {
  const now = at("2026-10-02T17:00:00Z"); // Fri 10:00 PDT

  it("accepts each kind and returns its first run", () => {
    expect(validateSchedule({ kind: "daily", at: "08:00" }, now, LA)).toMatchObject({ next: at("2026-10-03T15:00:00Z") });
    expect(validateSchedule({ kind: "once", at: "15:00", date: "2026-10-02" }, now, LA)).toMatchObject({ next: at("2026-10-02T22:00:00Z") });
    expect(validateSchedule({ kind: "weekly", at: "09:00", weekdays: [5, 1, 1] }, now, LA)).toMatchObject({ spec: { weekdays: [1, 5] } });
    expect(validateSchedule({ kind: "interval", everyMinutes: 30 }, now, LA)).toMatchObject({ spec: { anchorAt: now }, next: now + 30 * 60_000 });
    expect(validateSchedule({ kind: "monthly", at: "09:00", monthDay: 1, maxRuns: 3, until: null }, now, LA)).toMatchObject({ spec: { maxRuns: 3 } });
  });

  it("explains what is wrong instead of guessing", () => {
    const error = (raw: unknown) => (validateSchedule(raw, now, LA) as { error?: string }).error;
    expect(error({ kind: "hourly" })).toContain("kind");
    expect(error({ kind: "daily", at: "8点" })).toContain("HH:MM");
    expect(error({ kind: "once", at: "09:00", date: "2026-10-02" })).toBe("这个时间已经过去了");
    expect(error({ kind: "once", at: "09:00", date: "2026-02-30" })).toContain("date");
    expect(error({ kind: "interval", everyMinutes: 5 })).toContain("15");
    expect(error({ kind: "weekly", at: "09:00", weekdays: [0] })).toContain("weekdays");
    expect(error({ kind: "daily", at: "09:00", until: "2026-10-01" })).toContain("结束日期");
    expect(error(null)).toBeTruthy();
  });
});

describe("saying it back", () => {
  it("describes rules and the current time in Chinese", () => {
    expect(describeSchedule({ kind: "daily", at: "08:00" })).toBe("每天 08:00");
    expect(describeSchedule({ kind: "weekly", at: "09:30", weekdays: [1, 3] })).toBe("每周一、三 09:30");
    expect(describeSchedule({ kind: "monthly", at: "10:00", monthDay: 15, maxRuns: 6 })).toBe("每月 15 日 10:00，共 6 次");
    expect(describeSchedule({ kind: "interval", everyMinutes: 120 })).toBe("每 2 小时");
    expect(describeSchedule({ kind: "interval", everyMinutes: 45, until: "2026-10-09" })).toBe("每 45 分钟，到 10月9日为止");
    expect(describeSchedule({ kind: "once", at: "15:00", date: "2026-10-03" })).toBe("10月3日 15:00（一次）");
    expect(describeNow(at("2026-10-02T17:05:00Z"), LA)).toBe("2026-10-02 周五 10:05");
  });
});
