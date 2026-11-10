import { test, expect, type Page } from '@playwright/test';
import { mockConsole } from './mock-api';
import { FEATURES, type AnalyticsReport } from '../../src/common/analytics';
import type { UsageReport } from '../../src/common/usage';

const datesFor = (days: number) => Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 9, 13) - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
const minute = 60_000;
/** The pre-redesign report: what an older control plane still answers. */
const basic = (days: number): AnalyticsReport => {
  const dates = datesFor(days);
  return {
    timezone: 'America/Los_Angeles', days, dates, generatedAt: Date.UTC(2026, 9, 13, 21), collectionStartedAt: Date.UTC(2026, 8, 1),
    totals: { accounts: 12, signups: days === 7 ? 3 : 8, activeToday: 4, active7: 7, active30: 9, tasks: 40, completed: 30, failed: 4, sources: { manual: 30, schedule: 8, gadget: 2 } },
    activeTodayAccounts: [
      { username: 'yzmy', role: 'member', lastSeenAt: Date.UTC(2026, 9, 13, 20, 5), events: 12, tasks: 3, platforms: ['android', 'web'] },
      { username: 'owner', role: 'owner', lastSeenAt: Date.UTC(2026, 9, 13, 16, 30), events: 4, tasks: 0, platforms: ['mac'] },
      { username: 'cr', role: 'member', lastSeenAt: Date.UTC(2026, 9, 13, 15, 0), events: 0, tasks: 1, platforms: [] },
      { username: null, role: null, lastSeenAt: Date.UTC(2026, 9, 13, 14, 0), events: 1, tasks: 0, platforms: ['ios'] },
    ],
    daily: dates.map((date, i) => ({ date, active: 2 + i % 4, signups: i % 3 === 0 ? 1 : 0, logins: i % 3, tasks: 1 + i % 5, completed: Math.max(0, i % 5 - 1) + 1, failed: i % 5 === 4 ? 1 : 0, sessions: 3 + i % 4, wau: 6 + i % 2 })),
    events: [{ name: 'task_submit', count: 40, users: 5 }, { name: 'page_view', count: 120, users: 6 }, { name: 'brand_new_event', count: 1, users: 1 }],
    platforms: [{ platform: 'android', users: 2, events: 50 }, { platform: 'web', users: 5, events: 100 }, { platform: 'ios', users: 3, events: 40 }],
    funnel: { registerViews: 20, loginViews: 60, signups: 5 },
  };
};
const full = (days: number): AnalyticsReport => ({
  ...basic(days),
  current: { active: 9, signups: days === 7 ? 3 : 8, tasks: 40, completed: 30, failed: 4, interrupted: 2, sessions: 64, medianTaskMs: 3.5 * minute },
  previous: { active: 6, signups: 8, tasks: 32, completed: 22, failed: 5, interrupted: 1, sessions: 40, medianTaskMs: 5 * minute },
  activation: [
    { step: 'register_view', count: 20, eligible: null }, { step: 'signup', count: 8, eligible: null }, { step: 'first_task', count: 6, eligible: null },
    { step: 'first_completed', count: 5, eligible: null }, { step: 'day1', count: 3, eligible: 7 }, { step: 'day7', count: 2, eligible: 5 },
  ],
  cohorts: [
    { start: '2026-09-21', size: 3, d1: { eligible: 3, retained: 2 }, d7: { eligible: 3, retained: 1 } },
    { start: '2026-09-28', size: 2, d1: { eligible: 2, retained: 1 }, d7: { eligible: 2, retained: 1 } },
    { start: '2026-10-12', size: 3, d1: { eligible: 2, retained: 0 }, d7: { eligible: 0, retained: 0 } },
  ],
  features: FEATURES.map((feature, i) => ({ feature, count: feature === 'task_typed' ? 30 : feature === 'clawpage_visit' ? 25 : i < 12 ? 12 - i : 0, users: feature === 'task_typed' ? 8 : i < 12 ? Math.max(1, 6 - (i >> 1)) : 0, prevUsers: feature === 'task_typed' ? 6 : i < 12 ? 2 : 0 })),
  quality: { outcomes: { completed: 30, failed: 3, interrupted: 2, unknown: 1, other: 4 }, medianMs: 3.5 * minute, p90Ms: 42 * minute, stops: 3, retries: 2, reports: 1, likes: 7, dislikes: 2, restoreFailures: 3,
    restoreAccounts: [{ username: 'cr', count: 2 }, { username: 'yzmy', count: 1 }], restoreReasons: { mcp_unready: 2, deadline: 1 } },
  boot: [{ platform: 'ios', opens: 12, cached: 9, times: { ttfb: { p50: 30, p90: 900 }, dom: { p50: 400, p90: 1600 }, version: { p50: 600, p90: 1900 }, session: { p50: 650, p90: 2000 }, feed: { p50: 1100, p90: 3200 }, cover: { p50: 2800, p90: 5600 } } }],
  accounts: [
    { id: 'owner_1', username: 'owner', role: 'owner', createdAt: Date.UTC(2026, 0, 1), lastSeenAt: Date.UTC(2026, 9, 13, 16, 30), activeDays: 28, sessions: 30, tasks: 20, completed: 18, failed: 1, platforms: ['mac', 'web'], model: 'gpt-6.1-sol' },
    { id: 'm', username: 'yzmy', role: 'member', createdAt: Date.UTC(2026, 8, 22), lastSeenAt: Date.UTC(2026, 9, 13, 20, 5), activeDays: 12, sessions: 22, tasks: 15, completed: 10, failed: 2, platforms: ['android', 'web'], model: 'claude-sonnet-5.5' },
    { id: 'c', username: 'cr', role: 'member', createdAt: Date.UTC(2026, 9, 12), lastSeenAt: null, activeDays: 0, sessions: 0, tasks: 0, completed: 0, failed: 0, platforms: [], model: null },
  ],
  versions: [{ platform: 'ios', version: '0.1.0', users: 3 }, { platform: 'web', version: '0.1.0', users: 4 }],
  welcomeCards: [{ card: 'feature:clawpages', count: 5, users: 4 }, { card: 'starter:1', count: 2, users: 2 }],
});
// owner 100 input + 10 output per day, yzmy 2,000,000 + 10 per day.
const usage = (days: number): UsageReport => {
  const dates = datesFor(days);
  return { days, dates, timezone: 'America/Los_Angeles', generatedAt: Date.UTC(2026, 9, 13, 21), accounts: ([['owner_1', 'owner', 100], ['m', 'yzmy', 2_000_000]] as const).map(([id, username, n]) => ({
    id, username, role: username === 'owner' ? 'owner' : 'member', available: true, collectionStartedAt: Date.UTC(2026, 8, 1), firstRecordAt: Date.UTC(2026, 8, 1),
    // The member is costed at Sol (2,000,000 − 50 at $2, 50 cached at $0.10, 10 out at $10 per million: $4.0001 a day); the owner's model has no price.
    days: dates.map(date => ({ date, input: n, output: 10, cached: 50, cacheWrite: 0, total: n + 10, usd: username === 'owner' ? null : 4.0001 })),
    totals: { input: n * days, output: 10 * days, cached: 50 * days, cacheWrite: 0, total: (n + 10) * days, usd: username === 'owner' ? null : 4.0001 * days },
    model: username === 'owner' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
    quota: username === 'owner' ? null : { limit: 100_000_000, used: 37_000_000, resetsAt: Date.UTC(2026, 9, 14, 9), exceeded: false },
  })) };
};

async function open(page: Page, report: (days: number) => AnalyticsReport, mobile: boolean) {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'owner', role: 'owner' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  const reported: Array<{ name: string; props?: Record<string, unknown>; platform: string | null }> = [];
  await page.route('**/api/analytics', r => { reported.push({ ...r.request().postDataJSON(), platform: r.request().headers()['x-client-platform'] ?? null }); return r.fulfill({ status: 204, body: '' }); });
  const asked: number[] = [];
  await page.route('**/api/analytics/report*', r => { const days = Number(new URL(r.request().url()).searchParams.get('days')); asked.push(days); return r.fulfill({ json: report(days) }); });
  let failUsage = false;
  await page.route('**/api/usage*', r => failUsage ? r.fulfill({ status: 503, json: { error: 'unavailable', message: '暂时无法读取' } }) : r.fulfill({ json: usage(Number(new URL(r.request().url()).searchParams.get('days'))) }));
  await page.goto('/'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '运营看板', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运营看板', exact: true })).toBeVisible();
  return { reported, asked, setFailUsage: (v: boolean) => { failUsage = v; } };
}

const settle = (page: Page) => page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('the owner reads the redesigned dashboard: overview with changes, trends, funnel, retention, features, platforms, quality and accounts', async ({ page }, info) => {
  const mobile = info.project.name.startsWith('mobile');
  const { reported, asked, setFailUsage } = await open(page, full, mobile);
  expect(new URL(page.url()).pathname).toBe('/u/owner/analytics');

  // Overview: each figure with its change against the period before.
  const kpis = page.locator('.dash-kpis');
  const tile = (label: string) => kpis.locator('.dash-kpi', { has: page.getByText(label, { exact: true }) });
  await expect(tile('活跃账号')).toContainText('9'); await expect(tile('活跃账号').locator('.dash-delta.good')).toHaveText('▲ 50%');
  await expect(tile('活跃账号')).toContainText('今日 4 · 7 天 7 · 30 天 9');
  await expect(tile('完成率')).toContainText('75%'); await expect(tile('完成率').locator('.dash-delta.good')).toHaveText('▲ 6.3 个百分点');
  // Shorter is better: a faster median is good news.
  await expect(tile('完成耗时中位数')).toContainText('3.5分钟'); await expect(tile('完成耗时中位数').locator('.dash-delta.good')).toHaveText('▼ 30%');
  await expect(tile('新注册').locator('.dash-delta')).toHaveText('持平');
  await expect(tile('会话')).toContainText('人均 7.1 次 · 人均活跃 20 天');
  // 30 days × (100 + 10 + 2,000,000 + 10) tokens, short with the exact figure on hover.
  await expect(tile('token')).toContainText('6000.4万'); await expect(kpis.locator('[title="60,003,600"]')).toBeVisible();
  // The cost at list prices adds up the priced accounts; the table shows each one's, and a member's share of today's tokens.
  await expect(tile('token')).toContainText('估算费用 US$120');
  // One table for accounts and their tokens: no separate token table next to it.
  await expect(page.locator('.dash-tokens')).toHaveCount(0);
  const yzmy = page.locator('.dash-accounts tbody tr').filter({ hasText: /^yzmy/ });
  await expect(yzmy).toContainText('US$120'); await expect(yzmy).toContainText('37%');
  const owner = page.locator('.dash-accounts tbody tr').filter({ hasText: /^owner/ });
  // Columns after the account: last seen … completion, tokens, cost, quota, platforms, model.
  await expect(owner).toContainText('未定价'); await expect(owner.locator('td').nth(7)).toHaveText('—');
  // Nothing says which build of the console people run, nor the dashboard's own timezone and refresh rhythm.
  await expect(page.locator('.usage-body')).not.toContainText('0.1.0'); await expect(page.locator('.dash-updated')).toHaveText('更新于 14:00');
  await expect(kpis.locator('.dash-kpi')).toHaveCount(8);

  // The four daily charts are drawn on canvas by the shared ECharts renderer.
  const charts = page.locator('.dash-chart');
  await expect(charts).toHaveCount(4);
  await expect(page.locator('.dash-canvas[data-state="ready"]')).toHaveCount(4);
  for (const name of ['活跃账号 · 每日图表', '任务结果 · 每日图表', '新注册 · 每日图表', '每日 token · 每日图表']) await expect(page.getByRole('img', { name })).toBeVisible();
  for (const i of [0, 1, 2, 3]) expect(await charts.nth(i).locator('canvas').first().evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(100);
  await expect(charts.nth(1).locator('.dash-legend')).toContainText('完成'); await expect(charts.nth(1).locator('.dash-legend')).toContainText('失败');
  await expect(charts.nth(0).locator('.dash-legend')).toContainText('近 7 天活跃');

  // Activation: each step against the one before, the return steps against the accounts old enough.
  const funnel = page.locator('.dash-funnel li');
  await expect(funnel).toHaveCount(6);
  await expect(funnel.nth(1)).toContainText('上一步的 40%');
  await expect(funnel.nth(2)).toContainText('上一步的 75% · 占注册 75%');
  await expect(funnel.nth(4)).toContainText('满期 7 人中 43%');
  // Retention: newest week first; a week too young says so.
  const cohorts = page.locator('.dash-retention tbody tr');
  await expect(cohorts).toHaveCount(3);
  await expect(cohorts.first()).toContainText('10-12 当周'); await expect(cohorts.first()).toContainText('未满期');
  await expect(cohorts.nth(2)).toContainText('67%');

  // Features by accounts using them, unused ones on one line; welcome cards by their own titles.
  const features = page.locator('section[aria-labelledby="dash-features"] .dash-bars li');
  await expect(features.first()).toContainText('手动提交任务'); await expect(features.first()).toContainText('8'); await expect(features.first()).toContainText('占活跃 89% · 30 次 · ▲ 33%');
  await expect(page.locator('.dash-unused')).toContainText('本期未使用'); await expect(page.locator('.dash-unused')).toContainText('开启通知');
  await expect(page.locator('.dash-chips').first()).toContainText('Clawpages 小程序'); await expect(page.locator('.dash-chips').first()).toContainText('帮我盯价格');
  // Quality: the outcome split and the signals.
  await expect(page.locator('section[aria-labelledby="dash-quality"]')).toContainText('完成 30（75%）');
  await expect(page.locator('.dash-stats')).toContainText('42分钟');
  // Opening speed per platform: how often from the saved page, and each step's median / P90.
  const boot = page.locator('.dash-boot tbody tr').first();
  await expect(boot).toContainText('iOS App'); await expect(boot).toContainText('75%'); await expect(boot).toContainText('2.8 / 5.6');
  // Browser restores that failed: whose, and at what step.
  await expect(page.locator('.dash-restore-detail')).toContainText('cr 2、yzmy 1');
  await expect(page.locator('.dash-restore-detail')).toContainText('浏览器 MCP 未就绪 2、超时 1');

  // Accounts: latest first, sortable and searchable, with tokens from the usage report.
  const rows = page.locator('.dash-accounts tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('yzmy');
  await page.getByRole('button', { name: '按任务排序' }).click();
  await expect(rows.first()).toContainText('owner'); await expect(rows.first()).toContainText('90%');
  await page.getByRole('button', { name: '按任务排序' }).click();
  await expect(rows.first()).toContainText('cr'); await expect(rows.first()).toContainText('无近期活动');
  await page.getByRole('searchbox', { name: '搜索账号' }).fill('yz');
  await expect(rows).toHaveCount(1); await expect(page.getByText('1 / 3 个账号')).toBeVisible();
  await expect(rows.first()).toContainText('6000');
  await page.getByRole('searchbox', { name: '搜索账号' }).fill('');

  // The active-today figure still opens who it counts.
  await page.getByRole('button', { name: /今日活跃/ }).click();
  const dialog = page.getByRole('dialog', { name: '今日活跃账号 · 4' });
  await expect(dialog.locator('li')).toHaveCount(4); await settle(page);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);

  // A failing source keeps the rest and says what is stale.
  setFailUsage(true); await page.getByRole('button', { name: '刷新看板' }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法读取'); await expect(tile('活跃账号')).toContainText('9');
  setFailUsage(false); await page.getByRole('button', { name: '刷新看板' }).click(); await expect(page.getByRole('alert')).toHaveCount(0);

  // One range above everything.
  await page.getByRole('radio', { name: '近 7 天' }).click();
  await expect(page.getByRole('radio', { name: '近 7 天' })).toHaveAttribute('aria-checked', 'true');
  await expect(tile('新注册')).toContainText('3'); await expect(tile('新注册').locator('.dash-delta.bad')).toHaveText('▼ 63%');
  expect(asked).toContain(7);
  await expect(page.locator('.dash-canvas[data-state="ready"]')).toHaveCount(4);
  await page.getByRole('radio', { name: '近 30 天' }).click(); await expect(tile('新注册').locator('.dash-delta')).toHaveText('持平');

  await expect.poll(() => reported.some(e => e.name === 'page_view' && e.props?.view === 'analytics')).toBe(true);
  expect(reported.find(e => e.name === 'app_open')).toMatchObject({ platform: 'web', props: { lang: 'zh-CN', ui: expect.stringMatching(/^\d+\.\d+\.\d+/) } });

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    for (const width of mobile ? [390, 360] : [1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 900 });
      await expect(page.locator('.dash-canvas[data-state="ready"]')).toHaveCount(4);
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      const body = page.locator('.usage-body');
      const height = await body.evaluate(el => el.scrollHeight);
      for (let i = 0, top = 0; top < height && i < 8; i++, top += mobile ? 760 : 820) {
        await body.evaluate((el, y) => { el.scrollTop = y; }, top);
        await page.waitForTimeout(150);
        await page.screenshot({ path: info.outputPath(`dashboard-${theme}-${width}-${i}.png`) });
      }
      await body.evaluate(el => { el.scrollTop = 0; });
    }
  }
});

test('an older control plane gets the basic figures and a note, without the new sections', async ({ page }, info) => {
  await open(page, basic, info.project.name.startsWith('mobile'));
  await expect(page.getByText(/控制面版本较旧/)).toBeVisible();
  await expect(page.locator('.dash-kpis')).toContainText('40');
  await expect(page.locator('.dash-funnel')).toHaveCount(0);
  await expect(page.locator('.dash-accounts')).toHaveCount(0);
  await expect(page.locator('.dash-canvas[data-state="ready"]')).toHaveCount(4);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test('the former usage address opens the dashboard', async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'owner', role: 'owner' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  await page.route('**/api/analytics', r => r.fulfill({ status: 204, body: '' }));
  await page.route('**/api/analytics/report*', r => r.fulfill({ json: full(30) }));
  await page.route('**/api/usage*', r => r.fulfill({ json: usage(30) }));
  await page.goto('/u/owner/usage');
  await expect(page.getByRole('heading', { name: '运营看板', exact: true })).toBeVisible();
});

test('a member has no dashboard entry, never requests its APIs and the address falls back to the main session', async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'yzmy', role: 'member' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  await page.route('**/api/analytics', r => r.fulfill({ status: 204, body: '' }));
  const requests: string[] = []; page.on('request', r => requests.push(r.url()));
  await page.goto('/u/yzmy/analytics'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/u/yzmy');
  if (info.project.name.startsWith('mobile')) await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('button', { name: '运营看板', exact: true })).toHaveCount(0);
  expect(requests.some(u => u.includes('/api/analytics/report') || u.includes('/api/usage'))).toBe(false);
});
