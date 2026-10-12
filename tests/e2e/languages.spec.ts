import { expect, test } from '@playwright/test';
import { mockConsole } from './mock-api';

const languages = [
  { id: 'zh-CN', google: '使用 Google 登录 / 注册', invite: '只差一个邀请码', main: '主会话', cancel: '换一个登录方式' },
  { id: 'en', google: 'Sign in / sign up with Google', invite: 'One invite away', main: 'Main chat', cancel: 'Use another sign-in method' },
  { id: 'es', google: 'Acceder o registrarse con Google', invite: 'Solo falta una invitación', main: 'Chat principal', cancel: 'Usar otro método de acceso' },
  { id: 'zh-TW', google: '使用 Google 登入 / 註冊', invite: '只差一個邀請碼', main: '主對話', cancel: '換一個登入方式' },
];

for (const language of languages) test(`${language.id}: sign-in language persists through invite and member navigation`, async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  let authenticated = true;
  let pending = false;
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname); });
  await page.route('**/api/auth/session', route => route.fulfill({ json: { authenticated, username: authenticated ? 'demo' : null, role: 'member' } }));
  await page.route('**/api/auth/google/pending', route => route.fulfill({ json: { enabled: true, pending: pending ? { email: 'demo@example.com' } : null } }));
  await page.route('**/api/auth/google/cancel', route => { pending = false; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/main*', route => route.fulfill({ json: { mode: 'tasks', tasks: [], nextBefore: null } }));
  await page.goto('/u/demo/settings');
  const localSettings = page.locator('.settings-card select');
  await expect(localSettings.locator('option')).toHaveText(['中文', 'English', 'Español', '繁體中文']);
  await localSettings.selectOption(language.id);
  authenticated = false;
  await page.goto('/login');
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('lang', language.id);
  await expect(page.getByRole('button', { name: language.google, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', language.id);
  pending = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: language.invite, exact: true })).toBeVisible();
  await expect(page.getByText('demo@example.com')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('button', { name: language.cancel, exact: true }).click();
  await expect(page.getByRole('button', { name: language.google, exact: true })).toBeVisible();
  authenticated = true;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: language.main, exact: true })).toBeVisible();
  if (info.project.name.startsWith('mobile')) await page.locator('.mobile-menu-button').click();
  await expect(page.locator('.sidebar select')).toHaveCount(0);
  const settingsName = { 'zh-CN': '配置', en: 'Settings', es: 'Ajustes', 'zh-TW': '設定' }[language.id];
  await page.locator('.sidebar').getByRole('button', { name: settingsName, exact: true }).click();
  const picker = page.locator('.settings-card select');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveText(['中文', 'English', 'Español', '繁體中文']);
  await picker.selectOption(language.id === 'en' ? 'es' : 'en');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: language.id === 'en' ? 'Chat principal' : 'Main chat', exact: true })).toBeVisible();
  expect(writes).toContain('/api/auth/google/cancel');
  expect(writes.filter(path => path === '/api/settings' || path.includes('/google/register') || path.includes('/auth/logout'))).toEqual([]);
});
