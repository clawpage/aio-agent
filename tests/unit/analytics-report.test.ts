import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/control/db.js';
import { Analytics, fileKind, toolName } from '../../src/control/analytics.js';
import { testConfig } from '../helpers/harness.js';
import { userNamespace } from '../../src/control/auth/workspaceHost.js';

const stores: Db[] = [], dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const open = (file: string) => { const db = openDb(file); stores.push(db); return db; };
const account = (db: Db, id: string, role: string, at: number) => db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,?,'h','s','{}',?)").run(id, id, role, at);
let n = 0;
const task = (db: Db, owner: string, at: number, status: string, extra: { schedule?: string; gadget?: boolean; ms?: number; model?: string } = {}) => {
  n++;
  db.prepare("INSERT INTO conversations (id,owner_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(`conv-${n}`, owner, 't', at, at);
  db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,status,created_at,completed_at,schedule_id,model) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(`task-${n}`, `${extra.gadget ? 'gadget:' : 'web:'}${n}`, `conv-${n}`, 't', 'secret prompt text', status, at, extra.ms === undefined ? null : at + extra.ms, extra.schedule ?? null, extra.model ?? null);
};
const memberDb = (dir: string, id: string) => {
  const memberDir = path.join(dir, 'users', userNamespace(id)); fs.mkdirSync(memberDir, { recursive: true });
  return open(path.join(memberDir, 'agent.sqlite'));
};

// 2026-10-13 is a Tuesday. d(n) is n days before noon of that day.
const now = Date.parse('2026-10-13T12:00:00Z'), day = 86400000, d = (k: number) => now - k * day;

function scenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-analytics-report-')); dirs.push(dir);
  const cfg = testConfig(dir, 1); cfg.browser.timezone = 'UTC';
  const root = open(path.join(dir, 'root.sqlite'));
  account(root, 'owner_1', 'owner', d(100));
  account(root, 'user_d', 'member', d(20)); // Wed 09-23: never comes back
  account(root, 'user_a', 'member', d(12)); // Thu 10-01: first task the same day, back the next
  account(root, 'user_b', 'member', d(1)); // Mon 10-12: only a schedule, back today
  account(root, 'user_c', 'member', d(0)); // today: only its agent and a visitor did anything
  const a = memberDb(dir, 'user_a'), b = memberDb(dir, 'user_b');
  task(a, 'user_a', d(12), 'completed', { ms: 300_000, model: 'claude-sonnet-5.5' });
  task(a, 'user_a', d(0), 'interrupted', { model: 'gpt-6.1-sol' });
  task(b, 'user_b', d(0), 'running', { schedule: 'sched-b' });
  task(root, 'owner_1', d(10), 'completed', { ms: 30_000 });
  task(root, 'owner_1', d(3), 'completed', { ms: 60_000 });
  task(root, 'owner_1', d(2), 'completed', { ms: 120_000, schedule: 'sched-o' });
  task(root, 'owner_1', d(1), 'failed', { gadget: true });

  const analytics = new Analytics(root, undefined, d(60));
  const ev = (name: string, at: number, e: Parameters<Analytics['track']>[1] = {}) => analytics.track(name, e, at);
  ev('auth_view', d(13), { props: { mode: 'register' } });
  ev('auth_view', d(2), { props: { mode: 'register' } });
  ev('app_open', d(11), { userId: 'user_a', platform: 'web', props: { ui: '1.3.0' } });
  ev('app_open', d(0), { userId: 'user_b', platform: 'ios', props: { ui: '1.4.0', lang: 'zh-CN' } });
  // Openings of the console: one from the saved page, one from the network; a step not reached is -1.
  ev('boot_timing', d(0), { userId: 'user_b', platform: 'ios', props: { page: 'cache', ttfb: 20, dom: 300, version: 500, session: 520, feed: 900, cover: 2800 } });
  ev('boot_timing', d(0), { userId: 'user_b', platform: 'ios', props: { page: 'network', ttfb: 900, dom: 1500, version: 1700, session: 1750, feed: -1, cover: 9000 } });
  ev('task_submit', d(0), { userId: 'user_a', props: { attachments: 3, images: 1 } });
  ev('voice_input', d(0), { userId: 'user_a', props: { ok: false } });
  ev('voice_input', d(0), { userId: 'user_b', props: { ok: true, seconds: 4 } });
  ev('welcome_card', d(0), { userId: 'user_b', props: { kind: 'feature', card: 'clawpages' } });
  ev('welcome_card', d(0), { userId: 'user_b', props: { kind: 'feature', card: 'clawpages' } });
  ev('welcome_card', d(0), { userId: 'user_b', props: { kind: 'starter', card: 0 } });
  ev('task_stop', d(0), { userId: 'user_a' });
  ev('task_retry', d(0), { userId: 'user_a' });
  ev('retry_tap', d(0), { userId: 'user_b', props: { what: 'browser' } });
  ev('support_request', d(0), { userId: 'user_a', props: { kind: 'content' } });
  ev('support_request', d(0), { props: { kind: 'deletion' } });
  // The agent at work and a stranger visiting are not the account using the product.
  ev('knowledge_use', d(0), { userId: 'user_c', props: { via: 'agent', tool: 'history_search' } });
  ev('image_generate', d(0), { userId: 'user_c', props: { via: 'agent', ok: true, animated: true } });
  ev('clawpage_publish', d(0), { userId: 'user_c', props: { via: 'agent', created: true } });
  ev('clawpage_publish', d(0), { userId: 'user_c', props: { via: 'agent', created: false } });
  ev('clawpage_visit', d(0), { userId: 'user_c' });
  ev('browser_restore_failed', d(0), { userId: 'user_c', props: { reason: 'mcp_unready' } });
  // Votes on replies as they stand: two this week, one before the range.
  const vote = (id: string, owner: string, rating: string, at: number) => root.prepare("INSERT INTO message_feedback (id,owner_id,task_id,rating,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, owner, id, rating, at, at);
  vote('f1', 'user_a', 'up', d(0)); vote('f2', 'user_b', 'down', d(1)); vote('f3', 'user_a', 'up', d(20));
  return { cfg, analytics };
}

it('follows the accounts that signed up in the range from the first task to coming back, by weekly cohort', () => {
  const { cfg, analytics } = scenario();
  const report = analytics.report(cfg, 30, now);
  expect(report.activation).toEqual([
    { step: 'register_view', count: 2, eligible: null },
    { step: 'signup', count: 4, eligible: null },
    // user_b's only task ran on a schedule: not a first task.
    { step: 'first_task', count: 1, eligible: null },
    { step: 'first_completed', count: 1, eligible: null },
    // user_c signed up today, so it cannot have come back yet; user_b came back today.
    { step: 'day1', count: 2, eligible: 3 },
    { step: 'day7', count: 1, eligible: 2 },
  ]);
  expect(report.cohorts).toEqual([
    { start: '2026-09-21', size: 1, d1: { eligible: 1, retained: 0 }, d7: { eligible: 1, retained: 0 } },
    { start: '2026-09-28', size: 1, d1: { eligible: 1, retained: 1 }, d7: { eligible: 1, retained: 1 } },
    { start: '2026-10-12', size: 2, d1: { eligible: 1, retained: 1 }, d7: { eligible: 0, retained: 0 } },
  ]);
});

it('compares the range with the period before it and counts outcomes, durations, quality signals and features', () => {
  const { cfg, analytics } = scenario();
  const report = analytics.report(cfg, 7, now);
  // Active: the owner (typed and gadget tasks), user_a (a task today), user_b (opened the app). Not user_c.
  expect(report.current).toEqual({ active: 3, signups: 2, tasks: 5, completed: 2, failed: 1, interrupted: 1, sessions: 1, medianTaskMs: 120_000 });
  expect(report.previous).toEqual({ active: 2, signups: 1, tasks: 2, completed: 2, failed: 0, interrupted: 0, sessions: 1, medianTaskMs: 300_000 });
  expect(report.quality).toEqual({ outcomes: { completed: 2, failed: 1, interrupted: 1, unknown: 0, other: 1 }, medianMs: 120_000, p90Ms: 120_000, stops: 1, retries: 2, reports: 1, likes: 1, dislikes: 1, restoreFailures: 1,
    // Whose browser would not come back, and at what step.
    restoreAccounts: [{ username: 'user_c', count: 1 }], restoreReasons: { mcp_unready: 1 } });
  const f = Object.fromEntries(report.features!.map(x => [x.feature, x]));
  expect(f.task_typed).toEqual({ feature: 'task_typed', count: 2, users: 2, prevUsers: 2 });
  expect(f.task_scheduled).toMatchObject({ count: 2, users: 2, prevUsers: 0 });
  expect(f.task_gadget).toMatchObject({ count: 1, users: 1 });
  expect([f.attachment, f.photo].map(x => x.users)).toEqual([1, 1]);
  // A failed voice input is not use of the feature.
  expect(f.voice_input).toMatchObject({ count: 1, users: 1 });
  expect([f.image_generate.count, f.image_gif.count, f.clawpage_publish.count, f.clawpage_create.count, f.clawpage_visit.count, f.knowledge_use.count]).toEqual([1, 1, 2, 1, 1, 1]);
  expect(f.welcome_card).toMatchObject({ count: 3, users: 1 });
  expect(report.welcomeCards).toEqual([{ card: 'feature:clawpages', count: 2, users: 1 }, { card: 'starter:0', count: 1, users: 1 }]);
  expect(report.versions).toEqual([{ platform: 'ios', version: '1.4.0', users: 1 }]);
  expect(report.boot).toEqual([{ platform: 'ios', opens: 2, cached: 1, times: {
    ttfb: { p50: expect.any(Number), p90: 900 }, dom: { p50: expect.any(Number), p90: 1500 }, version: { p50: expect.any(Number), p90: 1700 },
    session: { p50: expect.any(Number), p90: 1750 }, feed: { p50: 900, p90: 900 }, cover: { p50: expect.any(Number), p90: 9000 } } }]);
  expect(report.daily.at(-1)).toMatchObject({ date: '2026-10-13', active: 2, sessions: 1, wau: 3 });

  const rows = Object.fromEntries(report.accounts!.map(r => [r.id, r]));
  expect(rows.user_a).toMatchObject({ activeDays: 1, sessions: 0, tasks: 1, completed: 0, failed: 0, model: 'gpt-6.1-sol', lastSeenAt: d(0) });
  expect(rows.user_b).toMatchObject({ activeDays: 1, sessions: 1, tasks: 1, platforms: ['ios'], model: null });
  expect(rows.owner_1).toMatchObject({ activeDays: 2, tasks: 3, completed: 2, failed: 1 });
  expect(rows.user_c).toMatchObject({ lastSeenAt: null, activeDays: 0 });
  // user_d's last activity was its sign-up: no events, no tasks, outside the 30-day window.
  expect(rows.user_d.lastSeenAt).toBeNull();
  expect(report.accounts!.map(r => r.id).slice(0, 2)).toEqual(['user_a', 'user_b']);
  expect(JSON.stringify(report)).not.toMatch(/secret prompt|web:\d/);
});

it('records a repetitive event once per window, and names tools and files without their content', () => {
  const root = open(':memory:');
  const analytics = new Analytics(root, undefined, now);
  for (const at of [now, now + 60_000, now + 9 * 60_000]) analytics.trackOnce('kb:u:kb_search', 10 * 60_000, 'kb_use', { userId: 'u' }, at);
  analytics.trackOnce('kb:u:kb_search', 10 * 60_000, 'kb_use', { userId: 'u' }, now + 10 * 60_000);
  analytics.trackOnce('kb:u:kb_read', 10 * 60_000, 'kb_use', { userId: 'u' }, now + 60_000);
  expect(root.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE name='kb_use'").get()).toEqual({ n: 3 });
  expect([toolName('kb_search'), toolName('rm -rf /'), toolName(42)]).toEqual(['kb_search', 'other', 'other']);
  expect(['/w/a/报告.PDF', '/w/photo.heic', '/w/x.mp4', '/w/no-ext'].map(fileKind)).toEqual(['document', 'image', 'video', 'other']);
});
