/** Render the real UI with synthetic tasks; never sign into a real account.
 * npm run build, then npx tsx scripts/play-store.mts /absolute/output/directory
 */
import { chromium, expect } from '@playwright/test';
import { mockConsole } from '../tests/e2e/mock-api.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Provide an absolute output directory');
const port = 4296;
const root = path.resolve(import.meta.dirname, '..');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['tests/e2e/static-server.mjs', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((resolve, reject) => { server.stdout!.once('data', () => resolve()); server.once('error', reject); server.once('exit', code => reject(new Error(`Static server exited: ${code}`))); });
const browser = await chromium.launch();
const locales = [
  { ui: 'en', store: 'en-US', google: 'Sign in / sign up with Google', main: 'Main chat', plan: 'Weekly study plan', request: 'Plan my study week, with 30 minutes a day.', result: '### Weekly study plan\n\n- Mon & Wed: read and take notes\n- Tue & Thu: practice and review\n- Fri: reflect and plan ahead', trip: 'Plan a weekend trip', ask: 'Make a checklist for a short weekend trip.' },
  { ui: 'es', store: 'es-419', google: 'Acceder o registrarse con Google', main: 'Chat principal', plan: 'Plan de estudio semanal', request: 'Organiza mi estudio: 30 minutos al día.', result: '### Plan de estudio semanal\n\n- Lun y mié: lectura y notas\n- Mar y jue: práctica y repaso\n- Vie: revisión de la semana', trip: 'Preparar un viaje', ask: 'Prepara una lista para un viaje de fin de semana.' },
  { ui: 'zh-TW', store: 'zh-TW', google: '使用 Google 登入 / 註冊', main: '主對話', plan: '本週學習計畫', request: '安排本週學習，每天保留 30 分鐘。', result: '### 本週學習計畫\n\n- 週一、週三：閱讀與筆記\n- 週二、週四：練習與複習\n- 週五：回顧本週，準備下週', trip: '整理週末出遊清單', ask: '整理一份週末短途出遊的準備清單。' },
];
try {
  for (const data of locales) {
    const folder = path.join(output, data.store);
    await mkdir(folder, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.addInitScript(language => localStorage.setItem('aio.locale', language), data.ui);
    const login = await context.newPage();
    await mockConsole(login, { conversations: [] });
    await login.route('**/api/auth/session', route => route.fulfill({ json: { authenticated: false } }));
    await login.route('**/api/auth/google/pending', route => route.fulfill({ json: { enabled: true, pending: null } }));
    await login.goto(`http://127.0.0.1:${port}/login`);
    await expect(login.getByRole('button', { name: data.google, exact: true })).toBeVisible();
    if (!await login.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error(`Login overflows: ${data.ui}`);
    await login.screenshot({ path: path.join(folder, `aio-agent-${data.store}-login-v2.png`) });
    const main = await context.newPage();
    await mockConsole(main, { conversations: [] });
    await main.route('**/api/auth/session', route => route.fulfill({ json: { authenticated: true, username: 'demo', role: 'member' } }));
    const now = Date.now();
    const tasks = [
      { id: 'demo-study', revision: 1, title: data.plan, text: data.request, conversationId: 'demo-study-conv', status: 'completed', result: data.result, error: null, attachments: [], createdAt: now - 600000, completedAt: now - 500000 },
      { id: 'demo-trip', revision: 1, title: data.trip, text: data.ask, conversationId: 'demo-trip-conv', status: 'planning', result: null, error: null, attachments: [], createdAt: now - 100000, completedAt: null },
    ];
    await main.route('**/api/main*', route => route.fulfill({ json: { mode: 'tasks', tasks, nextBefore: null } }));
    await main.goto(`http://127.0.0.1:${port}/`);
    await expect(main.getByRole('heading', { name: data.main, exact: true })).toBeVisible();
    await expect(main.getByRole('heading', { name: data.plan, exact: true })).toBeVisible();
    if (!await main.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error(`Main chat overflows: ${data.ui}`);
    await main.screenshot({ path: path.join(folder, `aio-agent-${data.store}-main.png`) });
    await context.close();
    const graphic = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
    const svg = await readFile(path.join(root, 'docs/assets/play-store', data.store, 'feature.svg'), 'utf8');
    await graphic.setContent(`<html><head><style>body{margin:0}</style></head><body>${svg}</body></html>`);
    await graphic.screenshot({ path: path.join(folder, `aio-agent-${data.store}-feature.png`) });
    await graphic.close();
    console.log(`${data.store}: real UI screenshots and feature graphic rendered`);
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ syntheticTasks: true, source: 'built real UI', languages: locales.map(data => ({ ui: data.ui, store: data.store })) }, null, 2) + '\n');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
