import { test, expect } from '@playwright/test';
import { mockConsole } from './mock-api';

const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;
const msg = (i: number, extra: Record<string, unknown> = {}) => ({ id: `task_${i}`, text: `问题 ${i}`, status: 'completed', done: true, reply: `回答 ${i}`, error: null, createdAt: at(200 - i), completedAt: at(199 - i), ...extra });

test('owner reads the gadget account conversation from its sidebar entry, at desktop and phone widths', async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'owner', role: 'owner' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  // Newest first from the server; three pages' worth of history.
  const all = [msg(1), msg(2), ...Array.from({ length: 58 }, (_, i) => msg(i + 3)), msg(61, { text: 'Roy 的生日是哪天？', reply: 'Roy 的生日是二〇二六年三月三十一日。' }), msg(62, { status: 'failed', reply: null, error: '服务暂时不可用' }), msg(63, { status: 'running', done: false, reply: null, completedAt: null })].reverse();
  await page.route('**/api/gadget/history*', r => {
    const url = new URL(r.request().url()), limit = Number(url.searchParams.get('limit')), before = Number(url.searchParams.get('before') ?? Infinity);
    const rows = all.filter(m => m.createdAt < before);
    return r.fulfill({ json: { account: 'betaw', messages: rows.slice(0, limit), more: rows.length > limit } });
  });
  await page.goto('/'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
  const mobile = info.project.name.startsWith('mobile');
  if (mobile) await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: 'Betaw', exact: true }).click();
  await expect(page).toHaveURL(/\/u\/owner\/gadget$/);
  // On a phone, choosing the entry closes the drawer all the way.
  if (mobile) await expect(page.locator('#main-navigation')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Betaw', exact: true })).toBeVisible();
  const log = page.getByRole('log', { name: 'Betaw 的对话' });
  await expect(log.getByText('Roy 的生日是二〇二六年三月三十一日。')).toBeVisible();
  await expect(log.getByText('回答失败：服务暂时不可用')).toBeVisible();
  await expect(log.getByText('正在回答…')).toBeVisible();
  // Opens at the newest exchange; older ones load above without jumping.
  expect(await log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await expect(log.getByText('问题 1', { exact: true })).toHaveCount(0);
  await log.getByRole('button', { name: '加载更早的对话' }).click();
  await expect(log.getByText('问题 1', { exact: true })).toHaveCount(1);
  await expect(log.getByRole('button', { name: '加载更早的对话' })).toHaveCount(0);
  for (const width of mobile ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    await log.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`gadget-${width}.png`) });
  }
  // The address opens the same page directly.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Betaw', exact: true })).toBeVisible();
});

test('no entry when the gadget has no account of its own, and none for a member', async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  let role = 'owner';
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: role === 'owner' ? 'owner' : 'yzmy', role } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  const asked: string[] = [];
  await page.route('**/api/gadget/history*', r => { asked.push(r.request().url()); return r.fulfill({ json: { account: null, messages: [], more: false } }); });
  for (role of ['owner', 'member']) {
    await page.goto('/'); await expect(page.getByRole('heading', { name: '主会话', exact: true })).toBeVisible();
    if (info.project.name.startsWith('mobile')) await page.getByRole('button', { name: '打开导航' }).click();
    await expect(page.getByRole('button', { name: '用量看板', exact: true })).toHaveCount(role === 'owner' ? 1 : 0);
    await expect(page.locator('.sidebar button', { hasText: /^Betaw$/ })).toHaveCount(0);
  }
  expect(asked).toHaveLength(1);   // only the owner asked
});
