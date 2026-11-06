import { afterEach, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/control/db.js';
import { UsageLedger } from '../../src/control/usage.js';
import { DAILY_TOKEN_LIMIT, limitMessage, quotaStatus, quotaWindow } from '../../src/control/quota.js';
import { runInLocale } from '../../src/control/i18n/index.js';

const stores: Db[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
/** Every half hour from one date to another (UTC), across a DST change. */
const range = (from: string, to: string) => Array.from({ length: (Date.parse(to) - Date.parse(from)) / 1_800_000 }, (_, i) => Date.parse(from) + i * 1_800_000);

it('runs from one 02:00 Pacific to the next, standard and daylight time alike', () => {
  // 10:00 UTC on a November day after DST ended is 02:00 PST.
  expect(quotaWindow(Date.parse('2026-11-05T23:00:00Z'))).toEqual({ start: Date.parse('2026-11-05T10:00:00Z'), resetsAt: Date.parse('2026-11-06T10:00:00Z') });
  // 01:59 Pacific still belongs to the day before.
  expect(quotaWindow(Date.parse('2026-11-06T09:59:00Z')).start).toBe(Date.parse('2026-11-05T10:00:00Z'));
  expect(quotaWindow(Date.parse('2026-11-06T10:00:00Z')).start).toBe(Date.parse('2026-11-06T10:00:00Z'));
  // In summer 02:00 PDT is 09:00 UTC.
  expect(quotaWindow(Date.parse('2026-07-01T12:00:00Z'))).toEqual({ start: Date.parse('2026-07-01T09:00:00Z'), resetsAt: Date.parse('2026-07-02T09:00:00Z') });
  // DST ends at 02:00 PDT on 2026-11-01 (the clock goes back to 01:00), so that day's 02:00 is 02:00 PST
  // and the day before it is 25 hours long.
  expect(quotaWindow(Date.parse('2026-11-01T09:30:00Z'))).toEqual({ start: Date.parse('2026-10-31T09:00:00Z'), resetsAt: Date.parse('2026-11-01T10:00:00Z') });
  expect(quotaWindow(Date.parse('2026-11-01T12:00:00Z'))).toEqual({ start: Date.parse('2026-11-01T10:00:00Z'), resetsAt: Date.parse('2026-11-02T10:00:00Z') });
  // DST starts at 02:00 PST on 2026-03-08 (the clock jumps to 03:00): that day begins at 03:00 PDT, 10:00 UTC.
  expect(quotaWindow(Date.parse('2026-03-08T09:30:00Z'))).toEqual({ start: Date.parse('2026-03-07T10:00:00Z'), resetsAt: Date.parse('2026-03-08T10:00:00Z') });
  // Every window holds the moment it is asked about.
  for (const at of [...range('2026-03-06', '2026-03-10'), ...range('2026-10-30', '2026-11-03')]) {
    const w = quotaWindow(at);
    expect(w.start).toBeLessThanOrEqual(at); expect(w.resetsAt).toBeGreaterThan(at);
  }
});

it('counts only what was used today and since the limit came in', () => {
  const db = openDb(':memory:'); stores.push(db);
  const ledger = new UsageLedger(db);
  const now = Date.parse('2026-11-05T23:00:00Z');
  const add = (key: string, at: number, input: number, output: number) => ledger.once(key, { input_tokens: input, output_tokens: output }, false, at);
  db.prepare("UPDATE token_usage_meta SET value=? WHERE key='quota_started'").run(Date.parse('2026-11-05T20:00:00Z'));
  add('yesterday', Date.parse('2026-11-05T05:00:00Z'), 90_000_000, 0);
  add('before the limit', Date.parse('2026-11-05T19:00:00Z'), 90_000_000, 0);
  add('after', Date.parse('2026-11-05T21:00:00Z'), 60_000_000, 1_000_000);
  expect(quotaStatus(db, now)).toEqual({ limit: DAILY_TOKEN_LIMIT, used: 61_000_000, resetsAt: Date.parse('2026-11-06T10:00:00Z'), exceeded: false });
  add('more', Date.parse('2026-11-05T22:00:00Z'), 39_000_000, 0);
  expect(quotaStatus(db, now).exceeded).toBe(true);
  // The next day starts from nothing.
  expect(quotaStatus(db, Date.parse('2026-11-06T10:00:00Z')).used).toBe(0);
});

it('says when service comes back, in Pacific time and from now', () => {
  const resetsAt = Date.parse('2026-11-06T10:00:00Z'), now = Date.parse('2026-11-06T05:30:00Z');
  expect(runInLocale('zh-CN', () => limitMessage(resetsAt, now))).toBe('今日免费用量已用完，服务暂停，将于太平洋时间 11月6日 02:00（约 5 小时后）恢复。');
  expect(runInLocale('en', () => limitMessage(resetsAt, now))).toBe("You've used today's free usage, so service is paused. It resets at Nov 6, 02:00 Pacific time (in about 5 hours).");
});
