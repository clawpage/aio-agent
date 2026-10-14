import { test, expect } from '@playwright/test';
import { mockConsole } from './mock-api';
import type { AnalyticsReport } from '../../src/common/analytics';

const report = (days: number): AnalyticsReport => {
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 9, 13) - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
  return {
    timezone: 'America/Los_Angeles', days, dates, generatedAt: Date.now(), collectionStartedAt: Date.UTC(2026, 9, 13),
    totals: { accounts: 12, signups: days === 7 ? 3 : 8, activeToday: 4, active7: 7, active30: 9, tasks: 40, completed: 30, failed: 4, sources: { manual: 30, schedule: 8, gadget: 2 } },
    daily: dates.map((date, i) => ({ date, active: i % 4, signups: i % 2, logins: i % 3, tasks: i % 5, completed: i % 4, failed: 0 })),
    events: [{ name: 'page_view', count: 120, users: 6 }, { name: 'task_submit', count: 40, users: 5 }, { name: 'brand_new_event', count: 1, users: 1 }],
    platforms: [{ platform: 'web', users: 5, events: 100 }, { platform: 'android', users: 2, events: 50 }],
    funnel: { registerViews: 20, loginViews: 60, signups: 5 },
  };
};

test('the owner reads product analytics at desktop and phone widths, and the console reports its platform and pages', async ({ page }, info) => {
  const mobile = info.project.name.startsWith('mobile');
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'owner', role: 'owner' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  const reported: Array<{ name: string; props?: Record<string, unknown>; platform: string | null }> = [];
  await page.route('**/api/analytics', r => { reported.push({ ...r.request().postDataJSON(), platform: r.request().headers()['x-client-platform'] ?? null }); return r.fulfill({ status: 204, body: '' }); });
  await page.route('**/api/analytics/report*', r => r.fulfill({ json: report(Number(new URL(r.request().url()).searchParams.get('days'))) }));
  await page.goto('/'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '运营统计', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运营统计', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/u/owner/analytics');
  const metrics = page.locator('.analytics-metrics');
  await expect(metrics).toContainText('12'); await expect(metrics).toContainText('本期新注册 8');
  await expect(metrics).toContainText('完成率 75%'); await expect(metrics).toContainText('25%');
  await expect(page.getByRole('img', { name: '每天的活跃账号、新注册与任务数' })).toBeVisible();
  expect(await page.locator('.usage-chart polyline').count()).toBe(3);
  await expect(page.getByRole('cell', { name: '120' })).toBeVisible();
  await expect(page.getByText('brand_new_event').first()).toBeVisible();
  await expect(page.getByText('Android App')).toBeVisible();
  await page.getByLabel('时间范围').selectOption('7');
  await expect(metrics).toContainText('本期新注册 3');
  await page.getByText('每日明细', { exact: true }).click(); await expect(page.locator('details tbody tr')).toHaveCount(7);
  await expect.poll(() => reported.some(e => e.name === 'page_view' && e.props?.view === 'analytics')).toBe(true);
  expect(reported.find(e => e.name === 'app_open')).toMatchObject({ platform: 'web', props: { lang: 'zh-CN' } });
  for (const width of mobile ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`analytics-${width}.png`), fullPage: true });
  }
});

test('a member has no analytics entry and the address falls back to the main session', async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'yzmy', role: 'member' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  await page.route('**/api/analytics', r => r.fulfill({ status: 204, body: '' }));
  const requests: string[] = []; page.on('request', r => requests.push(r.url()));
  await page.goto('/u/yzmy/analytics'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/u/yzmy');
  if (info.project.name.startsWith('mobile')) await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('button', { name: '运营统计', exact: true })).toHaveCount(0);
  expect(requests.some(u => u.includes('/api/analytics/report'))).toBe(false);
});
