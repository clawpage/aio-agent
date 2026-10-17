import { test, expect } from '@playwright/test';
import { mockConsole } from './mock-api';
import type { AnalyticsReport } from '../../src/common/analytics';
import type { UsageReport } from '../../src/common/usage';

const datesFor = (days: number) => Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 9, 13) - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
const report = (days: number): AnalyticsReport => {
  const dates = datesFor(days);
  return {
    timezone: 'America/Los_Angeles', days, dates, generatedAt: Date.now(), collectionStartedAt: Date.UTC(2026, 9, 13),
    totals: { accounts: 12, signups: days === 7 ? 3 : 8, activeToday: 4, active7: 7, active30: 9, tasks: 40, completed: 30, failed: 4, sources: { manual: 30, schedule: 8, gadget: 2 } },
    activeTodayAccounts: [
      { username: 'yzmy', role: 'member', lastSeenAt: Date.UTC(2026, 9, 13, 20, 5), events: 12, tasks: 3, platforms: ['android', 'web'] },
      { username: 'owner', role: 'owner', lastSeenAt: Date.UTC(2026, 9, 13, 16, 30), events: 4, tasks: 0, platforms: ['mac'] },
      { username: 'cr', role: 'member', lastSeenAt: Date.UTC(2026, 9, 13, 15, 0), events: 0, tasks: 1, platforms: [] },
      { username: null, role: null, lastSeenAt: Date.UTC(2026, 9, 13, 14, 0), events: 1, tasks: 0, platforms: ['ios'] },
    ],
    daily: dates.map((date, i) => ({ date, active: i % 4, signups: i % 2, logins: i % 3, tasks: i % 5, completed: Math.max(0, i % 5 - 1), failed: i % 5 === 4 ? 1 : 0 })),
    events: [{ name: 'task_submit', count: 40, users: 5 }, { name: 'page_view', count: 120, users: 6 }, { name: 'brand_new_event', count: 1, users: 1 }],
    platforms: [{ platform: 'android', users: 2, events: 50 }, { platform: 'web', users: 5, events: 100 }],
    funnel: { registerViews: 20, loginViews: 60, signups: 5 },
  };
};
// owner 100 input + 10 output per day, yzmy 2,000,000 + 10 per day.
const usage = (days: number): UsageReport => {
  const dates = datesFor(days);
  return { days, dates, timezone: 'America/Los_Angeles', generatedAt: Date.now(), accounts: ([['owner_1', 'owner', 100], ['m', 'yzmy', 2_000_000]] as const).map(([id, username, n]) => ({
    id, username, role: username === 'owner' ? 'owner' : 'member', available: true, collectionStartedAt: Date.now(), firstRecordAt: Date.now(),
    days: dates.map(date => ({ date, input: n, output: 10, cached: 50, cacheWrite: 0, total: n + 10 })),
    totals: { input: n * days, output: 10 * days, cached: 50 * days, cacheWrite: 0, total: (n + 10) * days },
  })) };
};

test('the owner reads one dashboard with product and token figures at desktop and phone widths, and the console reports its platform and pages', async ({ page }, info) => {
  const mobile = info.project.name.startsWith('mobile');
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'owner', role: 'owner' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  const reported: Array<{ name: string; props?: Record<string, unknown>; platform: string | null }> = [];
  await page.route('**/api/analytics', r => { reported.push({ ...r.request().postDataJSON(), platform: r.request().headers()['x-client-platform'] ?? null }); return r.fulfill({ status: 204, body: '' }); });
  await page.route('**/api/analytics/report*', r => r.fulfill({ json: report(Number(new URL(r.request().url()).searchParams.get('days'))) }));
  let failUsage = false;
  await page.route('**/api/usage*', r => failUsage ? r.fulfill({ status: 503, json: { error: 'unavailable', message: '暂时无法读取' } }) : r.fulfill({ json: usage(Number(new URL(r.request().url()).searchParams.get('days'))) }));
  await page.goto('/'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('button', { name: '用量看板', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '运营看板', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运营看板', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/u/owner/analytics');

  const metrics = page.locator('.analytics-metrics');
  await expect(metrics).toContainText('12'); await expect(metrics).toContainText('本期新注册 8');
  await expect(metrics).toContainText('完成率 75%'); await expect(metrics).toContainText('25%');
  // 30 days × (100 + 10 + 2,000,000 + 10) tokens, shown short with the exact figure on hover.
  await expect(metrics).toContainText('6000.4万');
  await expect(metrics.locator('[title="60,003,600"]')).toBeVisible();
  // The active-today figure opens who it counts, latest first, in the report's time zone.
  await page.getByRole('button', { name: /今日活跃账号/ }).click();
  const dialog = page.getByRole('dialog', { name: '今日活跃账号 · 4' });
  await expect(dialog.locator('li')).toHaveCount(4);
  await expect(dialog.locator('li').first()).toContainText('yzmy'); await expect(dialog.locator('li').first()).toContainText('最近 13:05');
  await expect(dialog.locator('li').first()).toContainText('事件 12 · 手动任务 3 · Android App、网页');
  await expect(dialog.locator('li').nth(3)).toContainText('已删除的账号');
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
  if (!mobile) await page.screenshot({ path: info.outputPath('active-today-1440.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /今日活跃账号/ })).toBeFocused();
  for (const name of ['活跃账号 · 每日柱状图', '任务 · 每日柱状图', '新注册 · 每日柱状图', '每日用量 · 每日柱状图']) await expect(page.getByRole('img', { name })).toBeVisible();
  await expect(page.locator('.dash-chart').nth(1)).toContainText('合计 40');

  // Token table: biggest user first, with its share of the total.
  const tokenRows = page.locator('.dash-tokens > table tbody tr');
  await expect(tokenRows.first()).toContainText('yzmy'); await expect(tokenRows.first()).toContainText('100%');
  await page.getByRole('combobox', { name: '用户', exact: true }).selectOption('owner_1');
  await expect(tokenRows).toHaveCount(1); await expect(tokenRows.first()).toContainText('3300');
  await page.getByText('每日明细 · owner', { exact: true }).click(); await expect(page.locator('.dash-tokens details tbody tr')).toHaveCount(30);

  // Feature use and platforms are ordered by size.
  await expect(page.locator('.dash-pair table').first().locator('tbody tr').first()).toContainText('浏览页面');
  await expect(page.getByText('brand_new_event').first()).toBeVisible();
  await expect(page.locator('.dash-pair table').nth(1).locator('tbody tr').first()).toContainText('网页');
  await expect(page.getByText('Android App')).toBeVisible();

  await page.getByLabel('时间范围').selectOption('7');
  await expect(metrics).toContainText('本期新注册 3');
  await page.getByText('每日明细', { exact: true }).click(); await expect(page.locator('.usage-body > details tbody tr')).toHaveCount(7);
  await page.getByText('统计口径', { exact: true }).click(); await expect(page.getByText('任务来源：手动 30')).toBeVisible();

  // A failing source keeps the rest of the page and says what is stale.
  failUsage = true; await page.getByRole('button', { name: '刷新看板' }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法读取'); await expect(metrics).toContainText('12');
  failUsage = false; await page.getByRole('button', { name: '刷新看板' }).click(); await expect(page.getByRole('alert')).toHaveCount(0);

  await expect.poll(() => reported.some(e => e.name === 'page_view' && e.props?.view === 'analytics')).toBe(true);
  expect(reported.find(e => e.name === 'app_open')).toMatchObject({ platform: 'web', props: { lang: 'zh-CN' } });
  for (const width of mobile ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: /今日活跃账号/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible(); await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`active-today-${width}.png`) });
    await page.getByRole('button', { name: '关闭', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const [i, top] of [0, 800, 1600].entries()) {
      await page.locator('.usage-body').evaluate((el, y) => { el.scrollTop = y; }, top);
      await page.screenshot({ path: info.outputPath(`dashboard-${width}-${i}.png`) });
    }
  }
});

test('the former usage address opens the dashboard', async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'owner', role: 'owner' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  await page.route('**/api/analytics', r => r.fulfill({ status: 204, body: '' }));
  await page.route('**/api/analytics/report*', r => r.fulfill({ json: report(30) }));
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
