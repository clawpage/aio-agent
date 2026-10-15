import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';

let h: TestHarness, owner: Record<string, string>, member: Record<string, string>;
const json = { 'content-type': 'application/json' };
const events = (name: string) => h.ctx.db.prepare('SELECT user_id,platform,props FROM analytics_events WHERE name=? ORDER BY id').all(name) as Array<{ user_id: string | null; platform: string | null; props: string | null }>;
const cookieOf = (res: { headers: { getSetCookie(): string[] } }) => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const csrfOf = (cookie: string) => decodeURIComponent(/pa_csrf=([^;]+)/.exec(cookie)?.[1] ?? '');

beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h); owner = { cookie: auth.cookie, 'x-csrf-token': auth.csrf, ...json };
  const res = await h.request('/api/auth/register', { method: 'POST', headers: { ...json, 'x-client-platform': 'android' }, body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) });
  expect(res.status).toBe(200);
  const cookie = cookieOf(res); member = { cookie, 'x-csrf-token': csrfOf(cookie), ...json };
});
afterAll(async () => { await h?.shutdown(); });

it('records sign-ups and sign-ins on the control plane with the platform the console names', async () => {
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE email='member@example.com'").get() as { id: string }).id;
  expect(events('signup')).toEqual([{ user_id: id, platform: 'android', props: JSON.stringify({ method: 'password', invite: false }) }]);
  const ok = await h.request('/api/auth/login', { method: 'POST', headers: { ...json, 'x-client-platform': 'pwa' }, body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) });
  expect(ok.status).toBe(200);
  await h.request('/api/auth/login', { method: 'POST', headers: { ...json, 'x-client-platform': 'not-a-platform' }, body: JSON.stringify({ email: 'member@example.com', password: 'wrong-password-123' }) });
  h.ctx.db.prepare('DELETE FROM login_failures').run();
  expect(events('login').at(-1)).toEqual({ user_id: id, platform: 'pwa', props: JSON.stringify({ method: 'password', with: 'email' }) });
  expect(events('login_failed').at(-1)).toEqual({ user_id: null, platform: null, props: JSON.stringify({ method: 'password' }) });
});

it('accepts the console events, only the sign-in page view without a session, and rate limits anonymous reports', async () => {
  const report = (headers: Record<string, string>, body: unknown) => h.request('/api/analytics', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
  expect((await report(member, { name: 'page_view', props: { view: 'tasks', note: { nested: true } } })).status).toBe(204);
  expect(events('page_view').at(-1)?.props).toBe(JSON.stringify({ view: 'tasks' }));
  expect((await report(member, { name: 'signup' })).status).toBe(400);
  expect((await report({}, { name: 'app_open' })).status).toBe(400);
  expect((await report({ origin: 'https://evil.example' }, { name: 'auth_view', props: { mode: 'login' } })).status).toBe(403);
  expect((await report({ 'x-client-platform': 'web' }, { name: 'auth_view', props: { mode: 'register' } })).status).toBe(204);
  expect(events('auth_view').at(-1)).toEqual({ user_id: null, platform: 'web', props: JSON.stringify({ mode: 'register' }) });
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await report({}, { name: 'auth_view', props: { mode: 'login' } })).status;
  expect(last).toBe(429);
});

it('records feature use in a member runtime into the central database', async () => {
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE email='member@example.com'").get() as { id: string }).id;
  // Members run on their own runtime; the request still lands in the root's analytics.
  h.ctx.runtimeForUser = vi.fn(async () => h.ctx);
  expect((await h.request('/api/account/locale', { method: 'PUT', headers: member, body: JSON.stringify({ locale: 'en' }) })).status).toBe(200);
  expect(events('locale_change').at(-1)).toEqual({ user_id: id, platform: null, props: JSON.stringify({ locale: 'en' }) });
  // A console reporting the language it opened in is not a switch.
  const switches = events('locale_change').length;
  expect((await h.request('/api/account/locale', { method: 'PUT', headers: member, body: JSON.stringify({ locale: 'es', sync: true }) })).status).toBe(200);
  expect(events('locale_change')).toHaveLength(switches);
  const before = (h.ctx.runtimeForUser as ReturnType<typeof vi.fn>).mock.calls.length;
  // Reporting an event never starts or wakes the account's runtime.
  expect((await h.request('/api/analytics', { method: 'POST', headers: member, body: JSON.stringify({ name: 'app_open' }) })).status).toBe(204);
  expect((h.ctx.runtimeForUser as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
});

it('shows the report to the owner only', async () => {
  expect((await h.request('/api/analytics/report')).status).toBe(401);
  expect((await h.request('/api/analytics/report', { headers: member })).status).toBe(403);
  expect((await h.request('/api/analytics/report?days=5', { headers: owner })).status).toBe(400);
  const res = await h.request('/api/analytics/report?days=7', { headers: owner });
  expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
  const report = await res.json() as any;
  expect(report.totals).toMatchObject({ accounts: 2, signups: 2 });
  expect(report.totals.activeToday).toBeGreaterThanOrEqual(1);
  expect(report.funnel.registerViews).toBe(1);
  expect(JSON.stringify(report)).not.toMatch(/member@example\.com|password/);
});
