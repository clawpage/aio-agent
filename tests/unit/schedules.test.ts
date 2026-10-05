import { describe, expect, it } from "vitest";
import { describeNow, describeSchedule, formatWhen, nextRun, validateSchedule, zonedTime, type ScheduleSpec } from "../../src/control/tasks/schedules.js";

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

describe("several times a day and irregular dates", () => {
  it("runs a daily rule at each of its times, then the next day's first", () => {
    const twice: ScheduleSpec = { kind: "daily", at: "08:00", times: ["08:00", "18:30"] };
    expect(formatWhen(nextRun(twice, at("2026-10-02T14:00:00Z"), LA)!, LA)).toBe("10月2日 周五 08:00");
    expect(formatWhen(nextRun(twice, at("2026-10-02T16:00:00Z"), LA)!, LA)).toBe("10月2日 周五 18:30");
    expect(formatWhen(nextRun(twice, at("2026-10-03T02:00:00Z"), LA)!, LA)).toBe("10月3日 周六 08:00");
    const weekly: ScheduleSpec = { kind: "weekly", at: "09:00", times: ["09:00", "21:00"], weekdays: [1] };
    expect(formatWhen(nextRun(weekly, at("2026-10-05T17:00:00Z"), LA)!, LA)).toBe("10月5日 周一 21:00");
    const monthly: ScheduleSpec = { kind: "monthly", at: "07:00", times: ["07:00", "12:00"], monthDay: 2 };
    expect(formatWhen(nextRun(monthly, at("2026-10-02T17:00:00Z"), LA)!, LA)).toBe("10月2日 周五 12:00");
  });

  it("runs irregular dates in order and ends after the last", () => {
    const dates: ScheduleSpec = { kind: "dates", dates: ["2026-10-08 09:00", "2026-10-15 14:30", "2026-11-02 08:00"] };
    expect(formatWhen(nextRun(dates, at("2026-10-02T17:00:00Z"), LA)!, LA)).toBe("10月8日 周四 09:00");
    expect(formatWhen(nextRun(dates, at("2026-10-08T16:00:00Z"), LA)!, LA)).toBe("10月15日 周四 14:30");
    expect(formatWhen(nextRun(dates, at("2026-10-20T00:00:00Z"), LA)!, LA)).toBe("11月2日 周一 08:00"); // PST by then
    expect(nextRun(dates, at("2026-11-03T00:00:00Z"), LA)).toBeNull();
  });

  it("normalises and checks the lists", () => {
    const now = at("2026-10-02T17:00:00Z");
    expect(validateSchedule({ kind: "daily", times: ["18:00", "08:00", "18:00"] }, now, LA)).toMatchObject({ spec: { kind: "daily", at: "08:00", times: ["08:00", "18:00"] } });
    expect(validateSchedule({ kind: "daily", times: ["08:00"] }, now, LA)).toEqual(expect.objectContaining({ spec: { kind: "daily", at: "08:00" } }));
    expect(validateSchedule({ kind: "dates", dates: ["2026-10-15T14:30", "2026-10-08 09:00", "2026-09-01 09:00"], maxRuns: 2, until: "2026-12-01" }, now, LA)).toMatchObject({ spec: { kind: "dates", dates: ["2026-09-01 09:00", "2026-10-08 09:00", "2026-10-15 14:30"] }, next: at("2026-10-08T16:00:00Z") });
    const error = (raw: unknown) => (validateSchedule(raw, now, LA) as { error?: string }).error;
    expect(error({ kind: "daily", times: ["8点"] })).toContain("times");
    expect(error({ kind: "daily", times: Array.from({ length: 13 }, (_, i) => `${String(i + 8).padStart(2, "0")}:00`) })).toContain("12");
    expect(error({ kind: "dates", dates: [] })).toContain("dates");
    expect(error({ kind: "dates", dates: ["2026-02-30 09:00"] })).toContain("2026-02-30 09:00");
    expect(error({ kind: "dates", dates: ["2026-10-01 09:00"] })).toBe("这些时间都已经过去了");
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
    expect(describeSchedule({ kind: "daily", at: "08:00", times: ["08:00", "18:30"] })).toBe("每天 08:00、18:30");
    expect(describeSchedule({ kind: "weekly", at: "09:00", times: ["09:00", "21:00"], weekdays: [1, 5] })).toBe("每周一、五 09:00、21:00");
    expect(describeSchedule({ kind: "dates", dates: ["2026-10-08 09:00", "2026-10-15 14:30"] })).toBe("10月8日 09:00、10月15日 14:30（共 2 次）");
    expect(describeSchedule({ kind: "dates", dates: ["2026-10-08 09:00", "2026-10-15 14:30", "2026-11-02 08:00", "2026-12-01 10:00"] })).toBe("10月8日 09:00、10月15日 14:30、11月2日 08:00 等（共 4 次）");
    expect(describeNow(at("2026-10-02T17:05:00Z"), LA)).toBe("2026-10-02 周五 10:05");
  });
});
