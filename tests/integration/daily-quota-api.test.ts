import { afterAll, beforeAll, expect, it } from 'vitest';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';

let h: TestHarness, headers: Record<string, string>;
beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h); headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' };
});
afterAll(async () => { await h?.shutdown(); });

it('reports only the share of today\'s tokens used, and refuses a message once they are used up', async () => {
  // An account without a limit (the owner) is told so.
  expect(await (await h.request('/api/account/quota', { headers })).json()).toEqual({ limited: false });
  const resetsAt = Date.now() + 2 * 3600_000;
  let used = 37_400_000;
  h.ctx.tasks.setQuota(() => ({ limit: 100_000_000, used, resetsAt, exceeded: used >= 100_000_000 }));
  const share = await h.request('/api/account/quota', { headers });
  expect(share.headers.get('cache-control')).toBe('no-store');
  expect(await share.json()).toEqual({ limited: true, percent: 37, resetsAt });
  used = 120_000_000;
  expect(await (await h.request('/api/account/quota', { headers })).json()).toMatchObject({ percent: 100 });
  const refused = await h.request('/api/tasks', { method: 'POST', headers: { ...headers, 'x-aio-locale': 'ja' }, body: JSON.stringify({ text: 'まだ使える？', clientMessageId: 'over-1' }) });
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: 'daily_limit', resetsAt, message: expect.stringMatching(/^本日の無料利用枠を使い切ったため、サービスを一時停止しています。.+（約 2 時間後）に再開します。$/) });
  h.ctx.tasks.setQuota(null);
});
