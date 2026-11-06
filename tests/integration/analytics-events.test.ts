import { afterAll, beforeAll, expect, it } from 'vitest';
import path from 'node:path';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';
import { ShareStore } from '../../src/control/share.js';
import { ScheduleGateway } from '../../src/control/scheduleTool.js';
import { MemberModelGateway } from '../../src/control/memberModelGateway.js';

let h: TestHarness, owner: Record<string, string>;
const json = { 'content-type': 'application/json' };
const events = (name: string) => h.ctx.db.prepare('SELECT user_id,platform,props FROM analytics_events WHERE name=? ORDER BY id').all(name) as Array<{ user_id: string | null; platform: string | null; props: string | null }>;

beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h); owner = { cookie: auth.cookie, 'x-csrf-token': auth.csrf, ...json };
});
afterAll(async () => { await h?.shutdown(); });

it('accepts the console-only events with their small enumerated properties', async () => {
  const report = (body: unknown) => h.request('/api/analytics', { method: 'POST', headers: { ...owner, 'x-client-platform': 'ios' }, body: JSON.stringify(body) });
  expect((await report({ name: 'welcome_card', props: { kind: 'feature', card: 'clawpages' } })).status).toBe(204);
  expect((await report({ name: 'file_save', props: { what: 'chart' } })).status).toBe(204);
  expect((await report({ name: 'retry_tap', props: { what: 'browser' } })).status).toBe(204);
  expect((await report({ name: 'app_open', props: { lang: 'zh-CN', ui: '1.4.0' } })).status).toBe(204);
  expect(events('welcome_card')).toEqual([{ user_id: 'owner_1', platform: 'ios', props: JSON.stringify({ kind: 'feature', card: 'clawpages' }) }]);
  expect(events('app_open').at(-1)?.props).toBe(JSON.stringify({ lang: 'zh-CN', ui: '1.4.0' }));
  expect(events('retry_tap')).toHaveLength(1); expect(events('file_save')).toHaveLength(1);
});

it('records a download by the kind of file only, never its name or path', async () => {
  await h.request(`/api/files/download?path=${encodeURIComponent('/home/gem/workspace/家庭账本-2026.xlsx')}`, { headers: owner });
  expect(events('file_download')).toEqual([{ user_id: 'owner_1', platform: null, props: JSON.stringify({ kind: 'document' }) }]);
});

it('records a clawpage publish against its owner as the agent at work, and a visit once per visitor and half hour', async () => {
  const lookup = (sql: string, v: string) => (h.ctx.db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  const store = new ShareStore({ cfg: h.ctx.cfg, port: 0, usernameOf: id => lookup('SELECT username AS v FROM owners WHERE id=?', id), userIdOf: name => lookup('SELECT id AS v FROM owners WHERE username=?', name) });
  store.analytics = h.ctx.analytics; h.ctx.share = store;
  const files = [{ path: 'index.html', data: Buffer.from('<!doctype html><title>t</title>').toString('base64') }, { path: 'a.css', data: Buffer.from('body{}').toString('base64') }];
  store.publish('owner_1', 'ledger', { title: '家庭账本', files });
  store.publish('owner_1', 'ledger', { title: '家庭账本', files });
  expect(events('clawpage_publish').map(e => e.props)).toEqual([
    JSON.stringify({ created: true, collaborator: false, via: 'agent' }),
    JSON.stringify({ created: false, collaborator: false, via: 'agent' }),
  ]);
  for (const page of ['/u/owner/share/ledger/', '/u/owner/share/ledger/index.html', '/u/owner/share/ledger/a.css']) expect((await h.request(page, { host: 'workspace' })).status).toBe(200);
  expect(events('clawpage_visit')).toEqual([{ user_id: 'owner_1', platform: null, props: null }]);
});

it('records a schedule the executor creates, with its kind and nothing it says', async () => {
  const schedule = new ScheduleGateway({ port: 0, log: h.ctx.log, tasksFor: async () => h.ctx.tasks, analytics: h.ctx.analytics });
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, schedule);
  await gateway.start();
  try {
    const runtime = { ...cfg, runtimeUserId: 'owner_1', dataDir: path.join(h.dataDir, 'owner-runtime') };
    schedule.provision(runtime);
    const url = runtime.schedule!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const call = (args: unknown) => fetch(url, { method: 'POST', headers: json, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'schedule_create', arguments: args } }) });
    await call({ title: '每周一提醒交房租', instruction: '提醒用户交房租', schedule: { kind: 'weekly', at: '08:00', weekdays: [1] }, needsBrowser: false });
    await call({ title: 'x', instruction: 'y', schedule: { kind: 'daily' } });
    expect(events('schedule_create')).toEqual([{ user_id: 'owner_1', platform: null, props: JSON.stringify({ via: 'agent', kind: 'weekly', condition: false }) }]);
  } finally { gateway.close(); }
});

it("records a browser restore that failed, against the runtime's account and not as its activity", async () => {
  await h.ctx.browser.sleepNow();
  h.browserRuntime.wakeError = 'restore failed';
  try { await expect(h.ctx.browser.wake()).rejects.toThrow(); } finally { h.browserRuntime.wakeError = null; }
  // With the step it stopped at, as a fixed code (a runtime that throws gives none: other).
  expect(events('browser_restore_failed')).toEqual([{ user_id: 'owner_1', platform: null, props: JSON.stringify({ reason: 'other' }) }]);
});
