import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/control/db.js';
import { Analytics, cleanProps, platformOf } from '../../src/control/analytics.js';
import { testConfig } from '../helpers/harness.js';
import { userNamespace } from '../../src/control/auth/workspaceHost.js';

const stores: Db[] = [], dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const open = (file: string) => { const db = openDb(file); stores.push(db); return db; };
const account = (db: Db, id: string, role: string, at: number) => db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,?,'h','s','{}',?)").run(id, id, role, at);
let n = 0;
const task = (db: Db, owner: string, at: number, status: string, extra: { schedule?: string; gadget?: boolean; merged?: string } = {}) => {
  const id = `task-${++n}`;
  db.prepare("INSERT INTO conversations (id,owner_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(`conv-${n}`, owner, 't', at, at);
  db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,status,created_at,schedule_id,merged_into) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, `${extra.gadget ? 'gadget:' : 'web:'}${n}`, `conv-${n}`, 't', 'secret prompt text', status, at, extra.schedule ?? null, extra.merged ?? null);
  return id;
};

it('keeps only small scalar properties and known platforms', () => {
  expect(cleanProps({ view: 'tasks', n: 2, ok: true, text: 'x'.repeat(65), nested: { a: 1 }, 'Bad-Key': 1, inf: Infinity })).toEqual({ view: 'tasks', n: 2, ok: true });
  expect(cleanProps(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])))).toEqual(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i])));
  expect(cleanProps(['a'])).toEqual({});
  expect([platformOf('ios'), platformOf('pwa'), platformOf('windows'), platformOf(undefined)]).toEqual(['ios', 'pwa', null, null]);
});

it('reports accounts, activity, tasks from every account store, events and platforms without leaking content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-analytics-')); dirs.push(dir);
  const cfg = testConfig(dir, 1); cfg.browser.timezone = 'UTC';
  const now = Date.parse('2026-10-13T12:00:00Z'), day = 86400000;
  const root = open(path.join(dir, 'root.sqlite'));
  account(root, 'owner_1', 'owner', now - 100 * day);
  account(root, 'user_a', 'member', now - 2 * day);
  account(root, 'user_b', 'member', now - 1 * day);
  const memberDir = path.join(dir, 'users', userNamespace('user_a')); fs.mkdirSync(memberDir, { recursive: true });
  const member = open(path.join(memberDir, 'agent.sqlite'));
  const parent = task(member, 'user_a', now - day, 'completed');
  task(member, 'user_a', now - day, 'merged', { merged: parent });
  task(member, 'user_a', now, 'failed');
  task(member, 'user_a', now, 'completed', { schedule: 'sched-1' });
  task(root, 'owner_1', now - 3 * day, 'completed', { gadget: true });
  task(root, 'owner_1', now - 40 * day, 'completed');
  const analytics = new Analytics(root, undefined, now - 10 * day);
  analytics.track('app_open', { userId: 'user_b', platform: 'ios' }, now);
  analytics.track('login', { userId: 'user_b', platform: 'ios', props: { method: 'password' } }, now);
  analytics.track('auth_view', { platform: 'web', props: { mode: 'register' } }, now - day);
  analytics.track('auth_view', { platform: 'web', props: { mode: 'register' } }, now - day);
  analytics.track('auth_view', { platform: 'web', props: { mode: 'login' } }, now);
  analytics.track('page_view', { userId: 'owner_1', platform: 'mac', props: { view: 'usage' } }, now - 20 * day);

  const report = analytics.report(cfg, 7, now);
  expect(report.dates).toHaveLength(7); expect(report.dates.at(-1)).toBe('2026-10-13');
  expect(report.totals).toMatchObject({ accounts: 3, signups: 2, tasks: 4, completed: 3, failed: 1, sources: { manual: 2, schedule: 1, gadget: 1 } });
  // A scheduled run is not activity: today has user_a's typed task and user_b's open.
  expect(report.totals.activeToday).toBe(2);
  expect(report.totals.active7).toBe(3);
  // The 30-day window reaches past the 7-day range: the owner's page view 20 days ago.
  expect(report.totals.active30).toBe(3);
  expect(report.daily.at(-1)).toMatchObject({ date: '2026-10-13', active: 2, signups: 0, logins: 1, tasks: 2, completed: 1, failed: 1 });
  expect(report.daily.at(-2)).toMatchObject({ signups: 1, tasks: 1, completed: 1 });
  expect(report.funnel).toEqual({ registerViews: 2, loginViews: 1, signups: 2 });
  expect(report.events.find(e => e.name === 'auth_view')).toEqual({ name: 'auth_view', count: 3, users: 0 });
  expect(report.platforms.find(p => p.platform === 'ios')).toEqual({ platform: 'ios', users: 1, events: 2 });
  expect(report.collectionStartedAt).toBe(now - 10 * day);
  expect(JSON.stringify(report)).not.toMatch(/secret prompt|password|web:/);
});

it('deletes events past the retention window when it starts', () => {
  const root = open(':memory:');
  const now = Date.now();
  new Analytics(root).track('login', {}, now - 401 * 86400000);
  new Analytics(root).track('login', {}, now);
  new Analytics(root, undefined, now);
  expect(root.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()).toEqual({ n: 1 });
});
