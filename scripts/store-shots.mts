/** Store screenshots for the App Store (6.9" iPhone, 1320×2868) and Google Play (1080×1920 phone, 1024×500 feature graphic).
 * Each one is a poster around pieces of the real UI rendered with synthetic tasks; never sign into a real account.
 * npm run build:ui, then npx tsx scripts/store-shots.mts /absolute/output/directory  (macOS: the posters use its PingFang and SF fonts)
 */
import { webkit, expect, type Browser, type Page } from '@playwright/test';
import { mockConsole, makeConversation } from '../tests/e2e/mock-api.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Provide an absolute output directory');
const port = 4297;
const root = path.resolve(import.meta.dirname, '..');
await mkdir(output, { recursive: true });

// A five-day table: [Day, Main, Side] headers, then one row per day.
const menu = (title: string, head: string[], rows: string[][], note: string) => `### ${title}\n\n| ${head.join(' | ')} |\n| --- | --- | --- |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n${note}`;
// ui: the console's language; appStore / play: each store's code for it. The poster copy is written per language, not translated word for word.
const locales = [
  { ui: 'zh-CN', appStore: 'zh-Hans', play: 'zh-CN', main: '主会话', process: '查看过程', nav: '打开导航', closeNav: '关闭导航', quote: '引用任务：', trip: '整理周末出游清单', ask: '整理一份周末短途出游的准备清单。',
    search: '幼儿 晚餐 30 分钟 食谱', dinner: '本周晚餐菜单', dinnerAsk: '按两大一小的口味，排一份本周工作日晚餐。', dinnerResult: menu('本周晚餐菜单', ['日期', '主菜', '配菜'], [['周一', '番茄牛腩', '清炒西兰花'], ['周二', '香煎三文鱼', '蒜蓉菠菜'], ['周三', '宫保鸡丁', '凉拌黄瓜'], ['周四', '虾仁蒸蛋', '清炒时蔬'], ['周五', '番茄意面', '蔬菜沙拉']], '每道菜 30 分钟内可以做好。'),
    followUp: '周六可能下雨，加一个室内备选。',
    copy: { brand: '一站 · Clawpage Agent', hero: ['说一句。', '做到位。', '从你的要求，到能用的结果。'], work: ['不止回答。', '真的在做。', '查了什么、改了什么，展开就能看。'], flow: ['查资料', '写入文件'],
      follow: ['想到就补一句。', '接着做下去。', '引用任务继续补充，不用从头再说。'], place: ['一个入口。', '整件事的去处。', '任务、文件、定时安排与知识库。'], tag: '让零散的事，有条理。',
      screen: ['一个主会话，', '管好每件事。', '交代、跟进、看结果，都在这里。'] } },
  { ui: 'en', appStore: 'en-US', play: 'en-US', main: 'Main chat', process: 'View steps', nav: 'Open navigation', closeNav: 'Close navigation', quote: 'Quote task: ', trip: 'Plan a weekend trip', ask: 'Make a checklist for a short weekend trip.',
    search: 'toddler dinners under 30 min', dinner: 'Weeknight dinners', dinnerAsk: 'Plan weeknight dinners for two adults and a toddler.', dinnerResult: menu('Weeknight dinners', ['Day', 'Main', 'Side'], [['Mon', 'Beef stew', 'Broccoli'], ['Tue', 'Seared salmon', 'Garlic spinach'], ['Wed', 'Chicken stir-fry', 'Cucumber salad'], ['Thu', 'Shrimp fried rice', 'Sautéed greens'], ['Fri', 'Tomato pasta', 'Green salad']], 'Every dish is ready in under 30 minutes.'),
    followUp: 'It might rain on Saturday. Add an indoor backup.',
    copy: { brand: 'Clawpage Agent', hero: ['Just say it.', 'Consider it done.', 'From one sentence to a result you can use.'], work: ['More than answers.', 'Real work.', 'Every search and file change, one tap away.'], flow: ['Research', 'Save the file'],
      follow: ['Thought of more?', 'Just add it.', 'Quote the task and keep going. No starting over.'], place: ['One place', 'for the whole job.', 'Tasks, files, schedules and your knowledge base.'], tag: 'Loose ends, sorted.',
      screen: ['One chat.', 'Every task handled.', 'Ask, follow up and get results in one place.'] } },
  { ui: 'es', appStore: 'es-MX', play: 'es-419', main: 'Chat principal', process: 'Ver proceso', nav: 'Abrir navegación', closeNav: 'Cerrar navegación', quote: 'Citar tarea: ', trip: 'Preparar un viaje', ask: 'Prepara una lista para un viaje de fin de semana.',
    search: 'cenas infantiles en 30 min', dinner: 'Cenas de la semana', dinnerAsk: 'Planea las cenas de la semana para mi familia.', dinnerResult: menu('Cenas de la semana', ['Día', 'Plato', 'Guarnición'], [['Lun', 'Estofado de res', 'Brócoli'], ['Mar', 'Salmón asado', 'Espinacas'], ['Mié', 'Pollo salteado', 'Pepino'], ['Jue', 'Arroz con camarón', 'Verduras'], ['Vie', 'Pasta con tomate', 'Ensalada']], 'Cada plato está listo en menos de 30 minutos.'),
    followUp: 'Puede llover el sábado. Agrega un plan bajo techo.',
    copy: { brand: 'Clawpage Agent', hero: ['Solo dilo.', 'Queda hecho.', 'De una frase a un resultado listo para usar.'], work: ['No solo responde.', 'Hace el trabajo.', 'Cada búsqueda y cada archivo, a un toque.'], flow: ['Investiga', 'Guarda el archivo'],
      follow: ['¿Se te ocurrió algo?', 'Agrégalo.', 'Cita la tarea y sigue. Sin empezar de cero.'], place: ['Un solo lugar', 'para todo el trabajo.', 'Tareas, archivos, horarios y tu conocimiento.'], tag: 'Todo en orden.',
      screen: ['Un solo chat.', 'Todo resuelto.', 'Pide, da seguimiento y recibe resultados.'] } },
  { ui: 'zh-TW', appStore: 'zh-Hant', play: 'zh-TW', main: '主對話', process: '檢視過程', nav: '開啟導覽', closeNav: '關閉導覽', quote: '引用任務：', trip: '整理週末出遊清單', ask: '整理一份週末短途出遊的準備清單。',
    search: '幼兒 晚餐 30 分鐘 食譜', dinner: '本週晚餐菜單', dinnerAsk: '依兩大一小的口味，排一份本週平日晚餐。', dinnerResult: menu('本週晚餐菜單', ['日期', '主菜', '配菜'], [['週一', '番茄牛腩', '清炒花椰菜'], ['週二', '香煎鮭魚', '蒜炒菠菜'], ['週三', '宮保雞丁', '涼拌小黃瓜'], ['週四', '蝦仁蒸蛋', '清炒時蔬'], ['週五', '番茄義大利麵', '生菜沙拉']], '每道菜 30 分鐘內就能完成。'),
    followUp: '週六可能下雨，加一個室內備案。',
    copy: { brand: '一站 · Clawpage Agent', hero: ['說一句。', '做到位。', '從你的需求，到能用的結果。'], work: ['不只回答。', '真的在做。', '查了什麼、改了什麼，展開就看得到。'], flow: ['查資料', '寫入檔案'],
      follow: ['想到就補一句。', '接著做下去。', '引用任務繼續補充，不必從頭再說。'], place: ['一個入口。', '整件事的去處。', '任務、檔案、排程與知識庫。'], tag: '讓零散的事，有條理。',
      screen: ['一個主對話，', '管好每件事。', '交代、追蹤、看結果，都在這裡。'] } },
];
type Locale = typeof locales[number];
type Shot = { src: string; w: number; h: number; radius?: number };
type Shots = Record<'bubble' | 'reply' | 'thread' | 'running' | 'nav' | 'composer' | 'process' | 'result' | 'screen', Shot>;

// Brand colors come from the console theme; the lime highlight exists only on the posters.
const theme = await readFile(path.join(root, 'src/ui/src/theme.css'), 'utf8');
const tokens = (selector: string) => Object.fromEntries([...theme.slice(theme.indexOf(selector)).split('}')[0].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const dark = tokens(':root {'), light = tokens(':root[data-theme="light"] {');
const color = { indigo: dark['--brand-tile'], violet: dark['--ai'], ink: dark['--bg'], inkRaised: dark['--bg-raised'], paper: dark['--paper'], lilac: light['--ai-soft'], text: light['--text'], dim: light['--text-dim'], lime: '#d4f86b' };

const sizes = {
  appStore: { width: 1320, height: 2868 },
  play: { width: 1080, height: 1920 },
  feature: { width: 1024, height: 500 },
};
const slides = ['hero', 'work', 'follow', 'place', 'screen'] as const;

// Store screenshots must not carry an alpha channel; WebKit writes RGBA, so drop it (8-bit, non-interlaced PNG).
function flatten(png: Buffer): Buffer {
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const header = chunks.find(chunk => chunk.type === 'IHDR')!.data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  if (header[9] === 2) return png;
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) throw new Error('Unexpected PNG format');
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
  const stride = width * 4, rgba = Buffer.alloc(stride * height), rgb = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0, b = y ? rgba[(y - 1) * stride + x] : 0, c = x >= 4 && y ? rgba[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      rgba[y * stride + x] = (line[x] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) rgba.copy(rgb, y * (width * 3 + 1) + 1 + x * 3, y * stride + x * 4, y * stride + x * 4 + 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), data.length + 8);
    return out;
  };
  const ihdr = Buffer.from(header); ihdr[9] = 2;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rgb, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The iPhone's status bar and home indicator: env(safe-area-inset-*) is zero headless, so set the tokens it feeds.
const insets = ':root { --safe-top:62px; --safe-bottom:34px; --safe-left:0px; --safe-right:0px; }';
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const scale = 4;

/** Render the console with the demo tasks and cut out the pieces the posters show. */
async function capture(browser: Browser, data: Locale): Promise<Shots> {
  const context = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: scale, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
  try {
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
    // The completed task's process: the request, a web search, a saved file, then the formatted answer.
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
    // A piece of the screen, padded by `pad` CSS pixels of the surrounding page.
    const cut = async (selectors: string[], pad: number): Promise<Shot> => {
      const boxes = await Promise.all(selectors.map(async selector => {
        const box = await page.locator(selector).first().boundingBox();
        if (!box) throw new Error(`${selector} is not on screen: ${data.ui}`);
        return box;
      }));
      const x = Math.min(...boxes.map(b => b.x)) - pad, y = Math.min(...boxes.map(b => b.y)) - pad;
      const clip = { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) + pad - x, height: Math.max(...boxes.map(b => b.y + b.height)) + pad - y };
      const radius = pad ? undefined : await page.locator(selectors[0]).first().evaluate(node => parseFloat(getComputedStyle(node).borderTopLeftRadius));
      return { src: `data:image/png;base64,${(await page.screenshot({ clip })).toString('base64')}`, w: clip.width, h: clip.height, radius };
    };

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: insets });
    await expect(page.getByRole('heading', { name: data.main, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: data.dinner, exact: true })).toBeVisible();
    if (!await fits(page)) throw new Error(`Main chat overflows: ${data.ui}`);
    // The feed opens at its end; start at the first request so no bubble is cut under the header.
    await page.locator('.chat-scroll').first().evaluate(node => { node.scrollTop = 0; });
    const screen = { src: `data:image/png;base64,${(await page.screenshot()).toString('base64')}`, w: 440, h: 956 };
    const bubble = await cut(['.task-entry .msg.user .bubble'], 0);
    const reply = await cut(['.msg.assistant.task-report'], 14);
    // The answer and the next request under it, so the hero reads as a conversation.
    const thread = await cut(['.msg.assistant.task-report', '.task-entry[data-task-id="demo-trip"] .msg.user'], 8);
    const running = await cut(['.task-entry[data-task-id="demo-trip"]'], 14);

    await page.getByRole('button', { name: data.nav, exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    // The brand and every destination, down to the last one before the footer.
    const nav = await cut(['.sidebar .brand', '.sidebar > button.block:last-of-type'], 12);
    await page.getByRole('button', { name: data.closeNav, exact: true }).click();

    // Quote the running task and type a follow-up, as someone adding to it would.
    await page.getByRole('button', { name: data.quote + data.trip, exact: true }).click();
    await page.getByRole('textbox').first().fill(data.followUp);
    await page.getByRole('textbox').first().blur();
    const composer = await cut(['.composer'], 12);

    await page.getByRole('button', { name: data.process, exact: true }).first().click();
    const detail = page.locator('.task-detail');
    await expect(detail.locator('.markdown').getByRole('heading', { name: data.dinner, exact: true })).toBeVisible();
    // Open the steps, so the shot shows the work behind the answer.
    await detail.locator('.working-head').click();
    await expect(detail.getByText(data.search)).toBeVisible();
    if (!await fits(page)) throw new Error(`Task detail overflows: ${data.ui}`);
    const process = await cut(['.task-detail .msg.user', '.task-detail .working'], 14);
    const result = await cut(['.task-detail .msg.assistant .bubble'], 0);
    return { bubble, reply, thread, running, nav, composer, process, result, screen };
  } finally {
    await context.close();
  }
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// A tilted card: a cut-out of the console placed at (x, y) in the stage, `zoom` times its on-screen size.
const card = (shot: Shot, x: number, y: number, zoom: number, turn: number, extra = '') =>
  `<img class="card ${extra}" src="${shot.src}" style="left:${x}px;top:${y}px;width:${shot.w * zoom}px;height:${shot.h * zoom}px;border-radius:${(shot.radius ?? 22) * zoom}px;transform:rotate(${turn}deg)">`;
// A hand-drawn arrow along an SVG path in stage coordinates, with its head at the end.
const arrow = (d: string, ink: string) => `<svg class="arrow" viewBox="0 0 440 680" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" marker-end="url(#head)"/><defs><marker id="head" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9" stroke="${ink}" stroke-width="2"/></marker></defs></svg>`;

const fonts = `-apple-system, "SF Pro Display", "PingFang SC", "PingFang TC", "Hiragino Sans GB", sans-serif`;
const style = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: ${color.ink}; overflow: hidden; }
  .poster { position: relative; width: 440px; overflow: hidden; display: flex; flex-direction: column; font-family: ${fonts}; -webkit-font-smoothing: antialiased; }
  .head { position: relative; z-index: 2; padding: 0 30px; }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: .02em; opacity: .9; }
  h1 { margin-top: 16px; font-size: 50px; line-height: 1.14; font-weight: 800; letter-spacing: -.01em; }
  h1 span, .sub { display: block; white-space: nowrap; overflow: hidden; }
  .sub { margin-top: 12px; font-size: 16px; font-weight: 500; opacity: .82; }
  .stage-slot { position: relative; flex: 1; z-index: 1; }
  .stage { position: absolute; left: 50%; top: 0; width: 440px; height: 680px; transform-origin: top center; }
  .card { position: absolute; display: block; box-shadow: 0 30px 60px rgb(10 6 40 / .32), 0 6px 16px rgb(10 6 40 / .18); }
  .arrow { position: absolute; inset: 0; width: 440px; height: 680px; overflow: visible; }
  .flow { position: absolute; left: 0; right: 0; display: flex; justify-content: center; align-items: center; gap: 22px; font-size: 24px; font-weight: 800; color: ${color.lime}; white-space: nowrap; }
  .flow i { font-style: normal; color: rgb(255 255 255 / .45); font-weight: 400; }
  .tag { position: absolute; padding: 18px 26px; border-radius: 18px; background: ${color.ink}; color: ${color.lime}; font-size: 24px; font-weight: 800; white-space: nowrap; box-shadow: 0 20px 40px rgb(10 6 40 / .3); }
  .phone { position: absolute; padding: 9px; border-radius: 52px; background: ${color.ink}; box-shadow: 0 40px 80px rgb(5 3 30 / .5), 0 0 0 1.5px rgb(255 255 255 / .14) inset; }
  .phone img { display: block; border-radius: 43px; }
`;

/** One poster as an HTML page: `height` is in poster pixels at 440 wide. */
function poster(slide: typeof slides[number], data: Locale, shots: Shots, height: number) {
  const c = data.copy;
  const head = (lines: string[], ink: string, accent: string, brand = ink) =>
    `<div class="head"><div class="brand fit" style="color:${brand}">${esc(c.brand)}</div><h1><span class="fit" style="color:${ink}">${esc(lines[0])}</span><span class="fit" style="color:${accent}">${esc(lines[1])}</span></h1><div class="sub fit" style="color:${ink}">${esc(lines[2])}</div></div>`;
  const page = (background: string, behind: string, header: string, stage: string) =>
    `<div class="poster" style="height:${height}px;background:${background}">${behind}<div style="height:${Math.round(height * 0.075)}px"></div>${header}<div class="stage-slot"><div class="stage">${stage}</div></div></div>`;
  switch (slide) {
    case 'hero': return page(`radial-gradient(120% 60% at 90% 35%, ${color.violet} 0%, transparent 60%), linear-gradient(165deg, ${color.indigo} 0%, color-mix(in srgb, ${color.indigo} 78%, ${color.ink}) 100%)`, '',
      head(c.hero, color.paper, color.lime),
      card(shots.bubble, Math.min(56, 420 - shots.bubble.w * 1.06), 24, 1.06, -4) + arrow('M 300 132 C 332 150, 348 168, 336 196', color.lime) + card(shots.thread, 18, 208, 0.94, 3));
    case 'work': return page(color.ink, `<div style="position:absolute;width:560px;height:560px;border-radius:50%;right:-210px;bottom:-120px;background:${color.inkRaised}"></div>`,
      head(c.work, color.paper, color.lime, color.lime),
      card(shots.process, 6, 20, 0.98, -3) + `<div class="flow" style="top:298px"><span>${esc(c.flow[0])}</span><i>→</i><span>${esc(c.flow[1])}</span></div>` + card(shots.result, 62, 368, 1.06, 2.5));
    case 'follow': return page(color.lime, '',
      head(c.follow, color.ink, color.indigo),
      card(shots.running, 6, 30, 0.98, -3) + arrow('M 46 360 C 20 320, 30 280, 70 250', color.ink) + card(shots.composer, 12, 350, 0.96, 2.5));
    case 'place': return page(color.lilac, `<div style="position:absolute;inset:0;background:${color.lime};clip-path:polygon(0 72%, 100% 34%, 100% 100%, 0 100%)"></div>`,
      head(c.place, color.ink, color.ink, color.indigo),
      card(shots.nav, 80, 24, 1.12, 6) + `<div class="tag fit-tag" style="left:26px;top:520px;transform:rotate(-5deg)">${esc(c.tag)}</div>`);
    case 'screen': return page(`radial-gradient(90% 50% at 50% 70%, ${color.indigo} 0%, transparent 70%), ${color.ink}`, '',
      head(c.screen, color.paper, color.lime, color.lime),
      `<div class="phone" style="left:${220 - 440 * 0.62 / 2 - 9}px;top:22px;transform:rotate(-3deg)"><img src="${shots.screen.src}" style="width:${440 * 0.62}px;height:${956 * 0.62}px"></div>`);
  }
}

/** The Play feature graphic: the hero headline beside the answer it produced. */
function feature(data: Locale, shots: Shots) {
  const c = data.copy;
  return `<div class="poster" style="width:512px;height:250px;flex-direction:row;background:radial-gradient(90% 120% at 85% 40%, ${color.violet} 0%, transparent 65%), linear-gradient(160deg, ${color.indigo}, color-mix(in srgb, ${color.indigo} 78%, ${color.ink}))">
    <div class="head" style="width:250px;padding:34px 0 0 28px"><div class="brand fit" style="color:${color.paper};font-size:10px">${esc(c.brand)}</div>
      <h1 style="margin-top:12px;font-size:38px"><span class="fit" style="color:${color.paper}">${esc(c.hero[0])}</span><span class="fit" style="color:${color.lime}">${esc(c.hero[1])}</span></h1>
      <div class="sub fit" style="color:${color.paper};font-size:11px;margin-top:10px">${esc(c.hero[2])}</div></div>
    <div style="position:relative;flex:1">${card(shots.bubble, 30, 26, 0.6, -4)}${card(shots.reply, 6, 80, 0.56, 3)}</div></div>`;
}

/** Render one poster page to a flattened PNG, after checking that no line was cut. */
async function render(browser: Browser, body: string, size: { width: number; height: number }, zoom: number, label: string) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${style} html { zoom: ${zoom}; }</style></head><body>${body}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every(image => image.complete));
    // Shrink a headline line until it fits its width, then scale the stage to the room left under the headline.
    const problems = await page.evaluate(`(() => {
      const problems = [];
      for (const line of document.querySelectorAll('.fit')) {
        let size = parseFloat(getComputedStyle(line).fontSize);
        while (line.scrollWidth > line.clientWidth && size > 12) line.style.fontSize = (size -= 1) + 'px';
        if (line.scrollWidth > line.clientWidth) problems.push('cut: ' + line.textContent);
      }
      for (const stage of document.querySelectorAll('.stage')) {
        // Fit the lowest tilted card, plus a margin, into the room; rects share one coordinate space.
        stage.style.transform = 'translateX(-50%)';
        const top = stage.getBoundingClientRect().top, room = stage.parentElement.getBoundingClientRect().height;
        const bottom = Math.max(...[...stage.querySelectorAll(':scope > :not(.arrow)')].map(child => child.getBoundingClientRect().bottom)) - top;
        const ratio = Math.min(1, room / (bottom + room * 0.05));
        stage.style.transform = 'translateX(-50%) scale(' + ratio + ')';
        if (ratio < 0.65) problems.push('stage too small: ' + ratio.toFixed(2));
      }
      const poster = document.querySelector('.poster').getBoundingClientRect();
      for (const tag of document.querySelectorAll('.tag')) {
        const box = tag.getBoundingClientRect();
        if (box.left < poster.left || box.right > poster.right) problems.push('tag outside: ' + tag.textContent);
      }
      return problems;
    })()`) as string[];
    if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
    return flatten(await page.screenshot());
  } finally {
    await page.close();
  }
}

const server = spawn(process.execPath, ['tests/e2e/static-server.mjs', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((resolve, reject) => { server.stdout!.once('data', () => resolve()); server.once('error', reject); server.once('exit', code => reject(new Error(`Static server exited: ${code}`))); });
const browser = await webkit.launch();
const files: { store: string; locale: string; file: string }[] = [];
try {
  for (const data of locales) {
    const shots = await capture(browser, data);
    for (const [store, code] of [['appStore', data.appStore], ['play', data.play]] as const) {
      const folder = path.join(output, store === 'appStore' ? 'app-store' : 'play-store', code);
      await mkdir(folder, { recursive: true });
      const size = sizes[store], zoom = size.width / 440;
      for (const [index, slide] of slides.entries()) {
        const file = path.join(folder, `${String(index + 1).padStart(2, '0')}-${slide}-${code}.png`);
        await writeFile(file, await render(browser, poster(slide, data, shots, size.height / zoom), size, zoom, `${store} ${code} ${slide}`));
        files.push({ store, locale: code, file });
      }
      if (store === 'play') {
        const file = path.join(folder, `feature-${code}.png`);
        await writeFile(file, await render(browser, feature(data, shots), sizes.feature, 2, `feature ${code}`));
        files.push({ store: 'feature', locale: code, file });
      }
    }
    console.log(`${data.ui}: posters rendered`);
  }

  // One sheet with every image, a row per store and language, for review before uploading.
  const rows = [...new Set(files.map(f => `${f.store === 'feature' ? 'play' : f.store}|${f.locale}`))].map(key => {
    const [store, locale] = key.split('|');
    const items = files.filter(f => (f.store === 'feature' ? 'play' : f.store) === store && f.locale === locale);
    return `<div class="row"><b>${store === 'appStore' ? 'App Store' : 'Google Play'} · ${locale}</b><div>${items.map(f => `<img src="${path.relative(output, f.file)}" class="${f.store}">`).join('')}</div></div>`;
  });
  const sheet = path.join(output, '.overview.html');
  await writeFile(sheet, `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#e9e8ee;font:600 18px ${fonts};width:1952px}.row{margin-bottom:22px}.row div{display:flex;gap:14px;align-items:flex-start;margin-top:8px}img{height:430px;border-radius:10px}img.feature{height:auto;width:420px}</style>${rows.join('')}`);
  const overview = await browser.newPage({ viewport: { width: 2000, height: 600 }, deviceScaleFactor: 1 });
  await overview.goto(`file://${sheet}`);
  await overview.waitForFunction(() => [...document.images].every(image => image.complete));
  await writeFile(path.join(output, 'overview.png'), flatten(await overview.screenshot({ fullPage: true })));
  await overview.close();

  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ syntheticTasks: true, source: 'built real UI inside posters', engine: 'webkit', sizes, slides, languages: locales.map(data => ({ ui: data.ui, appStore: data.appStore, play: data.play })) }, null, 2) + '\n');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
