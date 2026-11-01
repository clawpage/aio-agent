/** Render the real UI with synthetic tasks for the iOS App Store (6.9" iPhone, 1320×2868); never sign into a real account.
 * npm run build:ui, then npx tsx scripts/app-store.mts /absolute/output/directory
 */
import { webkit, expect, type Page } from '@playwright/test';
import { mockConsole, makeConversation } from '../tests/e2e/mock-api.js';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Provide an absolute output directory');
const port = 4297;
const root = path.resolve(import.meta.dirname, '..');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['tests/e2e/static-server.mjs', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((resolve, reject) => { server.stdout!.once('data', () => resolve()); server.once('error', reject); server.once('exit', code => reject(new Error(`Static server exited: ${code}`))); });
const browser = await webkit.launch();
// A five-day table: [Day, Main, Side] headers, then one row per day.
const menu = (title: string, head: string[], rows: string[][], note: string) => `### ${title}\n\n| ${head.join(' | ')} |\n| --- | --- | --- |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n${note}`;
const locales = [
  { ui: 'zh-CN', store: 'zh-Hans', main: '主会话', process: '查看过程', nav: '打开导航', stop: '停止该任务', trip: '整理周末出游清单', ask: '整理一份周末短途出游的准备清单。',
    search: '幼儿 晚餐 30 分钟 食谱', dinner: '本周晚餐菜单', dinnerAsk: '按两大一小的口味，排一份本周工作日晚餐。', dinnerResult: menu('本周晚餐菜单', ['日期', '主菜', '配菜'], [['周一', '番茄牛腩', '清炒西兰花'], ['周二', '香煎三文鱼', '蒜蓉菠菜'], ['周三', '宫保鸡丁', '凉拌黄瓜'], ['周四', '虾仁蒸蛋', '清炒时蔬'], ['周五', '番茄意面', '蔬菜沙拉']], '每道菜 30 分钟内可以做好。') },
  { ui: 'en', store: 'en-US', main: 'Main chat', process: 'View steps', nav: 'Open navigation', stop: 'Stop task', trip: 'Plan a weekend trip', ask: 'Make a checklist for a short weekend trip.',
    search: 'toddler dinners under 30 min', dinner: 'Weeknight dinners', dinnerAsk: 'Plan weeknight dinners for two adults and a toddler.', dinnerResult: menu('Weeknight dinners', ['Day', 'Main', 'Side'], [['Mon', 'Beef stew', 'Broccoli'], ['Tue', 'Seared salmon', 'Garlic spinach'], ['Wed', 'Chicken stir-fry', 'Cucumber salad'], ['Thu', 'Shrimp fried rice', 'Sautéed greens'], ['Fri', 'Tomato pasta', 'Green salad']], 'Every dish is ready in under 30 minutes.') },
  { ui: 'es', store: 'es-MX', main: 'Chat principal', process: 'Ver proceso', nav: 'Abrir navegación', stop: 'Detener tarea', trip: 'Preparar un viaje', ask: 'Prepara una lista para un viaje de fin de semana.',
    search: 'cenas infantiles en 30 min', dinner: 'Cenas de la semana', dinnerAsk: 'Planea las cenas de la semana para mi familia.', dinnerResult: menu('Cenas de la semana', ['Día', 'Plato', 'Guarnición'], [['Lun', 'Estofado de res', 'Brócoli'], ['Mar', 'Salmón asado', 'Espinacas'], ['Mié', 'Pollo salteado', 'Pepino'], ['Jue', 'Arroz con camarón', 'Verduras'], ['Vie', 'Pasta con tomate', 'Ensalada']], 'Cada plato está listo en menos de 30 minutos.') },
  { ui: 'zh-TW', store: 'zh-Hant', main: '主對話', process: '檢視過程', nav: '開啟導覽', stop: '停止該任務', trip: '整理週末出遊清單', ask: '整理一份週末短途出遊的準備清單。',
    search: '幼兒 晚餐 30 分鐘 食譜', dinner: '本週晚餐菜單', dinnerAsk: '依兩大一小的口味，排一份本週平日晚餐。', dinnerResult: menu('本週晚餐菜單', ['日期', '主菜', '配菜'], [['週一', '番茄牛腩', '清炒花椰菜'], ['週二', '香煎鮭魚', '蒜炒菠菜'], ['週三', '宮保雞丁', '涼拌小黃瓜'], ['週四', '蝦仁蒸蛋', '清炒時蔬'], ['週五', '番茄義大利麵', '生菜沙拉']], '每道菜 30 分鐘內就能完成。') },
];
// The iPhone's status bar and home indicator: env(safe-area-inset-*) is zero headless, so set the tokens it feeds.
const insets = ':root { --safe-top:62px; --safe-bottom:34px; --safe-left:0px; --safe-right:0px; }';
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
try {
  for (const data of locales) {
    const folder = path.join(output, data.store);
    await mkdir(folder, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(language => localStorage.setItem('aio.locale', language), data.ui);
    // A mocked event stream ends and the header would say "reconnecting"; keep it open instead.
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        readyState = 1; onmessage = null; onerror = null; onopen = null;
        constructor(readonly url: string) { super(); setTimeout(() => this.dispatchEvent(new Event('replay.complete'))); }
        close() { this.readyState = 2; }
      } as unknown as typeof EventSource;
    });
    const page = await context.newPage();
    const now = Date.now();
    const tasks = [
      { id: 'demo-dinner', revision: 1, title: data.dinner, text: data.dinnerAsk, conversationId: 'demo-dinner-conv', status: 'completed', result: data.dinnerResult, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: now - 400000, completedAt: now - 300000 },
      { id: 'demo-trip', revision: 1, title: data.trip, text: data.ask, conversationId: 'demo-trip-conv', status: 'planning', result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: now - 100000, completedAt: null },
    ];
    await mockConsole(page, { conversations: tasks.map(t => makeConversation(t.conversationId, t.title)) });
    await page.route('**/api/auth/session', route => route.fulfill({ json: { authenticated: true, username: 'demo', role: 'member' } }));
    await page.route('**/api/main*', route => route.fulfill({ json: { mode: 'tasks', tasks, nextBefore: null } }));
    // The completed task's process: the request, a web search, then the formatted answer.
    await page.route(url => url.pathname === '/api/conversations/demo-dinner-conv/events', route => {
      const at = now - 400000;
      return route.fulfill({ json: { more: false, events: [
        { id: 1, type: 'turn.queued', turnId: 't1', createdAt: at, payload: { turnId: 't1', text: data.dinnerAsk } },
        { id: 2, type: 'turn.started', turnId: 't1', createdAt: at + 1000, payload: {} },
        { id: 3, type: 'item/completed', turnId: 't1', createdAt: at + 30000, payload: { item: { id: 's1', type: 'webSearch', title: data.search } } },
        { id: 4, type: 'item/completed', turnId: 't1', createdAt: at + 80000, payload: { item: { id: 'f1', type: 'fileChange', changes: [{ path: 'menus/weeknight-dinners.md', kind: 'add' }] } } },
        { id: 5, type: 'item/completed', turnId: 't1', createdAt: at + 90000, payload: { item: { id: 'm1', type: 'agentMessage', text: data.dinnerResult } } },
        { id: 6, type: 'turn.finished', turnId: 't1', createdAt: at + 100000, payload: { status: 'completed' } },
      ] } });
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: insets });
    await expect(page.getByRole('heading', { name: data.main, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: data.dinner, exact: true })).toBeVisible();
    if (!await fits(page)) throw new Error(`Main chat overflows: ${data.ui}`);
    // The feed opens at its end; start at the first request so no bubble is cut under the header.
    await page.locator('.chat-scroll').first().evaluate(node => { node.scrollTop = 0; });
    // Both ends of the feed must show: the first request below the header, the running task above the composer.
    const top = (await page.getByRole('heading', { name: data.main, exact: true }).boundingBox())!;
    const first = (await page.getByText(data.dinnerAsk, { exact: true }).first().boundingBox())!;
    const stop = (await page.getByRole('button', { name: data.stop, exact: true }).boundingBox())!;
    const composer = (await page.getByRole('textbox').first().boundingBox())!;
    if (first.y < top.y + top.height + 16 || stop.y + stop.height > composer.y - 24) throw new Error(`Main chat does not fit one screen: ${data.ui}`);
    await page.screenshot({ path: path.join(folder, `01-main-${data.store}.png`) });

    await page.getByRole('button', { name: data.process, exact: true }).first().click();
    const detail = page.locator('.task-detail');
    await expect(detail.getByText(data.dinnerAsk)).toBeVisible();
    await expect(detail.locator('.markdown').getByRole('heading', { name: data.dinner, exact: true })).toBeVisible();
    // Open the steps, so the shot shows the work behind the answer.
    await detail.locator('.working-head').click();
    await expect(detail.getByText(data.search)).toBeVisible();
    if (!await fits(page)) throw new Error(`Task detail overflows: ${data.ui}`);
    await page.screenshot({ path: path.join(folder, `02-task-${data.store}.png`) });

    await page.goBack();
    await expect(page.getByRole('heading', { name: data.main, exact: true })).toBeVisible();
    await page.getByRole('button', { name: data.nav, exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    if (!await fits(page)) throw new Error(`Navigation overflows: ${data.ui}`);
    await page.screenshot({ path: path.join(folder, `03-navigation-${data.store}.png`) });
    await context.close();
    console.log(`${data.store}: real UI screenshots rendered`);
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ syntheticTasks: true, source: 'built real UI', engine: 'webkit', size: '1320x2868', languages: locales.map(data => ({ ui: data.ui, store: data.store })) }, null, 2) + '\n');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
