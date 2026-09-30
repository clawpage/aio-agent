#!/usr/bin/env node
'use strict';
/**
 * Tab-scoped browser tools for parallel tasks (MCP over streamable HTTP, JSON
 * responses). Every caller names its task in the X-AIO-Task header (and its
 * title in X-AIO-Task-Title). Each tab is recorded against the task that created
 * it: only that task may drive it, every other task may read it. Tabs are
 * locked, the browser is not, so tasks share one Chromium and its logins.
 *
 * A finished task keeps its tabs (a follow-up turn continues on them). They are
 * destroyed on demand: when the task closes them, when too many finished tabs
 * pile up, or when the control plane prunes them before releasing the browser.
 *
 * A person can take control of a task's tab (the control plane brings it to the
 * front of the real browser). While a person holds a tab no agent may read or
 * act on it. The agent can ask for that hand-over itself (browser_request_human)
 * and waits in place until the person hands the tab back.
 *
 * Runs inside the sandbox as the sandbox user, listening on loopback only. It
 * coordinates tasks of one account; it is not a security boundary between them.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = process.env.AIO_TABS_VERSION || 'dev';
const PORT = Number(process.env.AIO_TABS_PORT || 8190);
const CDP = process.env.AIO_TABS_CDP || 'http://127.0.0.1:9222';
const OUTPUT_DIR = process.env.AIO_TABS_OUTPUT || '/home/gem/workspace/.scratch/artifacts/browser';
const STATE_FILE = process.env.AIO_TABS_STATE || '/tmp/aio-tabs-state.json';
const MAX_FINISHED_TABS = Number(process.env.AIO_TABS_MAX_FINISHED || 8);
const HUMAN_WAIT_MS = Number(process.env.AIO_TABS_HUMAN_WAIT_MS || 30 * 60 * 1000);
/** No browser tool may hang a task: past this it fails with a reason (waiting for a person excepted). */
const TOOL_DEADLINE_MS = Number(process.env.AIO_TABS_TOOL_DEADLINE_MS || 90 * 1000);
/** A page that cannot evaluate `1` this fast, twice, is hung (a crashed or starved renderer). */
const PROBE_MS = Number(process.env.AIO_TABS_PROBE_MS || 5000);
const MAX_TEXT = 60000;
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const { chromium } = require(process.env.AIO_TABS_PLAYWRIGHT || '/opt/aio-browser/playwright-core');

const INSTRUCTIONS = [
  '浏览器请只用 aio_tabs 的工具。每个标签页记录着创建它的任务：只有创建它的任务能操作（打开网址、点击、填写、执行脚本、关闭），其他任务只能只读查看（正文、HTML、页面结构、截图）。',
  '只读查看其他任务的页面时，先用 browser_tab_list 找到标签页编号（如 t3），再把它作为 tab 参数传给读取类工具。',
  '需要用户本人在浏览器里操作时，调用 browser_request_human 说明原因并等待：登录、验证码、二次验证、输入密码或支付信息、付款、下单、发送消息、修改账号设置等不可撤销的最后一步，或需要用户判断的页面。不要在对话里索要密码或验证码。',
  '用户交还后先读取页面确认当前状态再继续；结果不确定的操作不要自动重做，先让用户核对。用户正在操作的标签页你不能读取或操作。',
  '不要使用 `aio browser` 命令行或 /v1/browser 接口：它们操作的是整个浏览器当前可见的页面，会打断其他正在并行的任务。',
  '选择器使用 Playwright 语法：CSS（#id、.class）、text=登录、role=button[name="搜索"]；不确定时先用 browser_snapshot 查看页面结构。',
].join('\n');

// ----------------------------------------------------------------- registry

/** tabId -> { id, page, key, title, targetId, createdAt, lastUsed, finishedAt, holder, humanSince, request } */
const registry = new Map();
/**
 * Links a person opens from a reply live under this key: always theirs to
 * operate, never listed, read or operated by any agent.
 */
const PERSON = 'person';
const MAX_PERSON_TABS = 3;
/** key -> tabId the task is currently working in */
const cursors = new Map();
let seq = 0;

function snapshotRecords() {
  return [...registry.values()].map(({ id, page, key, title, targetId, createdAt, lastUsed, finishedAt, holder, humanSince, request }) => ({ id, key, title, targetId, url: safeUrl(page), createdAt, lastUsed, finishedAt, holder, humanSince, request }));
}

function safeUrl(page) {
  try { return page.url(); } catch { return ''; }
}

/** The ownership record survives a restart of this server (not of Chromium, whose target ids change). */
function save() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seq, tabs: snapshotRecords() }), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    process.stderr.write(`tab state not saved: ${err && err.message}\n`);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seq: 0, tabs: [] };
  }
}

async function targetIdOf(page) {
  const session = await page.context().newCDPSession(page);
  try {
    return (await session.send('Target.getTargetInfo')).targetInfo.targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

function forget(tab) {
  if (registry.get(tab.id) !== tab) return;
  registry.delete(tab.id);
  settleWaiters(tab.id, 'closed');
  if (cursors.get(tab.key) === tab.id) cursors.delete(tab.key);
  save();
}

function register(page, key, title, extra = {}) {
  const id = extra.id || `t${++seq}`;
  const now = Date.now();
  const tab = {
    id, page, key, title, targetId: extra.targetId || null, createdAt: extra.createdAt || now, lastUsed: extra.lastUsed || now, finishedAt: extra.finishedAt ?? null,
    holder: extra.holder === 'human' || key === PERSON ? 'human' : 'ai', humanSince: extra.humanSince ?? (key === PERSON ? now : null), request: extra.request ?? null,
  };
  registry.set(id, tab);
  if (!extra.id) cursors.set(key, id);
  // A link that opens a new window belongs to the same task and becomes its current tab.
  page.on('popup', (popup) => { void adoptNew(popup, key, title); });
  page.on('close', () => forget(tab));
  if (!tab.targetId) targetIdOf(page).then((t) => { tab.targetId = t; save(); }).catch(() => undefined);
  save();
  return tab;
}

async function adoptNew(page, key, title, targetId) {
  const tab = register(page, key, title, targetId ? { targetId } : {});
  await enforceFinishedCap(key);
  await refocusHuman();
  return tab;
}

/** A new tab opened by any task must never pull the page a person is typing in to the back. */
async function refocusHuman() {
  const held = [...registry.values()].filter((t) => t.holder === 'human' && !t.page.isClosed()).sort((a, b) => b.humanSince - a.humanSince)[0];
  if (held) await held.page.bringToFront().catch(() => undefined);
}

// ------------------------------------------------------- human hand-over

/** tabId -> Set<resolve>: agents waiting for a person to hand a tab back. */
const waiters = new Map();

function settleWaiters(tabId, outcome) {
  for (const resolve of waiters.get(tabId) || []) resolve(outcome);
  waiters.delete(tabId);
}

function waitForHuman(tab, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.get(tab.id)?.delete(finish);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), HUMAN_WAIT_MS);
    if (!waiters.has(tab.id)) waiters.set(tab.id, new Set());
    waiters.get(tab.id).add(finish);
    signal?.addEventListener('abort', () => finish('aborted'), { once: true });
  });
}

/** A person takes a task's tab: it comes to the front and agents are shut out until it is handed back. */
async function takeControl(tab) {
  tab.holder = 'human';
  tab.humanSince = Date.now();
  save();
  await tab.page.bringToFront().catch(() => undefined);
}

function releaseControl(tab) {
  tab.holder = 'ai';
  tab.humanSince = null;
  tab.request = null;
  save();
  settleWaiters(tab.id, 'released');
}

// ------------------------------------------------------------------ browser

let connecting = null;

/** Whether a page target answers a trivial evaluation over its own raw CDP socket. */
function answers(target) {
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => { try { ws.close(); } catch { /* gone */ } resolve(false); }, PROBE_MS);
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } }));
      ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch { /* done */ } resolve(true); };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
    } catch { clearTimeout(timer); resolve(false); }
  });
}

/**
 * Close pages whose renderer is hung. One hung page stalls every CDP client that
 * attaches to all pages (a connect never finishes), so a dead page would take
 * every task's browser tools down with it. A hung page is unusable anyway; what
 * was closed is logged by URL for the person.
 */
async function closeHungPages() {
  const list = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const closed = [];
  for (const target of list.filter((t) => t.type === 'page')) {
    if ((await answers(target)) || (await answers(target))) continue;
    await fetch(`${CDP}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    closed.push(target.url);
  }
  if (closed.length) process.stdout.write(`closed hung pages: ${closed.join(' ')}\n`);
  return closed;
}

async function browserContext() {
  if (!connecting) {
    connecting = chromium.connectOverCDP(CDP, { timeout: 20000 }).catch(async (err) => {
      // A hung page blocks the connect: clear the dead pages once and try again.
      if (!(await closeHungPages().catch(() => [])).length) throw err;
      return chromium.connectOverCDP(CDP, { timeout: 20000 });
    }).then(async (browser) => {
      // A released or restarted Chromium invalidates every page handle.
      browser.on('disconnected', () => { connecting = null; registry.clear(); cursors.clear(); });
      await reattach(browser.contexts()[0]);
      return browser;
    }).catch((err) => { connecting = null; throw err; });
  }
  const browser = await connecting;
  return browser.contexts()[0] || browser.newContext();
}

/** Re-claim recorded tabs after this server restarted, matching Chromium's own target ids. */
async function reattach(context) {
  if (!context) return;
  const state = loadState();
  seq = Math.max(seq, Number(state.seq) || 0);
  const byTarget = new Map((state.tabs || []).filter((t) => t.targetId).map((t) => [t.targetId, t]));
  if (!byTarget.size) return;
  for (const page of context.pages()) {
    const targetId = await targetIdOf(page).catch(() => null);
    const record = targetId && byTarget.get(targetId);
    if (record && !registry.has(record.id)) register(page, record.key, record.title, { ...record, targetId });
  }
  save();
}

/**
 * Every task tab opens in its own browser window. A background tab of a shared
 * window stops being composited once it is idle, so capturing it hangs about
 * half the time; a page alone in its (possibly covered) window keeps rendering,
 * which keeps screenshots and the person's live view reliable for parallel tasks.
 */
async function newTab(key, title) {
  const context = await browserContext();
  const browser = context.browser();
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    // Other tasks may open windows at the same moment: take the page this call created.
    const known = new Set([...registry.values()].map((t) => t.page));
    const deadline = Date.now() + 15000;
    let page = null;
    while (!page) {
      for (const candidate of context.pages()) {
        if (!known.has(candidate) && (await targetIdOf(candidate).catch(() => null)) === targetId) page = candidate;
      }
      if (page) break;
      if (Date.now() > deadline) throw new Error('新开的窗口没有找到');
      await context.waitForEvent('page', { timeout: 1000 }).catch(() => undefined);
    }
    return adoptNew(page, key, title, targetId);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** A capture that cannot hang forever: a stuck compositor fails the call instead. */
async function capture(page, { fullPage = false, quality = 70 } = {}) {
  const work = fullPage
    ? page.screenshot({ type: 'jpeg', quality, fullPage: true, timeout: 15000 })
    : (async () => {
        const session = await page.context().newCDPSession(page);
        try {
          return Buffer.from((await session.send('Page.captureScreenshot', { format: 'jpeg', quality })).data, 'base64');
        } finally {
          await session.detach().catch(() => undefined);
        }
      })();
  return Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error('截图超时，页面可能正在加载，请稍后再试')), 15000))]);
}

function ownTabs(key) {
  return [...registry.values()].filter((t) => t.key === key && !t.page.isClosed());
}

/** Destroy on demand: keep at most MAX_FINISHED_TABS finished tabs, oldest-used first to go. */
async function enforceFinishedCap(exceptKey) {
  const finished = [...registry.values()].filter((t) => t.finishedAt && t.key !== exceptKey).sort((a, b) => a.lastUsed - b.lastUsed);
  while (finished.length > MAX_FINISHED_TABS) {
    const tab = finished.shift();
    await tab.page.close().catch(() => undefined);
  }
}

/** A task that acts again owns live tabs again, even if an earlier turn of it finished. */
function touchTask(key, title) {
  for (const tab of ownTabs(key)) {
    tab.finishedAt = null;
    if (title) tab.title = title;
  }
}

async function currentOwn(key, title, create) {
  const id = cursors.get(key);
  const tab = id && registry.get(id);
  if (tab && !tab.page.isClosed()) return tab;
  const own = ownTabs(key);
  if (own.length) {
    const latest = own.sort((a, b) => b.lastUsed - a.lastUsed)[0];
    cursors.set(key, latest.id);
    return latest;
  }
  if (!create) throw new Error('这个任务还没有打开标签页，请先用 browser_navigate 或 browser_tab_new。');
  return newTab(key, title);
}

/**
 * The tab a call works on. Reading may name any recorded tab; acting only ever
 * touches a tab the calling task created.
 */
async function resolveTab(ctx, tabId, mode, create = false, allowHuman = false) {
  await browserContext();
  let tab;
  if (tabId) {
    tab = registry.get(String(tabId));
    if (!tab || tab.page.isClosed()) throw new Error(`没有标签页 ${tabId}，请先用 browser_tab_list 查看。`);
    if (mode === 'write' && tab.key !== ctx.key) {
      throw new Error(`标签页 ${tab.id} 由任务「${tab.title}」创建，其他任务只能只读访问（读取正文、HTML、结构或截图）。`);
    }
  } else {
    tab = await currentOwn(ctx.key, ctx.title, create);
  }
  if (tab.holder === 'human' && !allowHuman) {
    throw new Error(`用户正在操作标签页 ${tab.id}，交还前不能读取或操作它。需要等用户完成时，调用 browser_request_human 说明你在等什么。`);
  }
  tab.lastUsed = Date.now();
  return tab;
}

function markFinished(key) {
  let count = 0;
  for (const tab of ownTabs(key)) {
    tab.finishedAt = Date.now();
    tab.request = null;
    settleWaiters(tab.id, 'finished');
    count += 1;
  }
  cursors.delete(key);
  save();
  return count;
}

/** Keys a person may press from the phone input bar. */
const PERSON_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * The tab a person acts on: the one they took over (a named one, or the latest).
 * `task` names the task a tab must belong to (`key` is a keyboard key here).
 * Guessing "the page in front" is not safe: the workspace browser view selects
 * its own tab, so a guess could type into an unrelated page.
 */
function heldTab(body) {
  if (body.tab) {
    const tab = registry.get(String(body.tab));
    if (!tab || tab.page.isClosed() || (body.task && tab.key !== body.task)) return { error: { status: 404, body: { error: 'no_tab', message: '这个标签页已经关闭或不属于该任务' } } };
    if (tab.holder !== 'human') return { error: { status: 409, body: { error: 'not_held', message: `这个页面正由任务「${tab.title}」操作，请先点“接管”` } } };
    return { tab };
  }
  const tab = [...registry.values()].filter((t) => t.holder === 'human' && !t.page.isClosed()).sort((a, b) => b.humanSince - a.humanSince)[0];
  if (!tab) return { error: { status: 409, body: { error: 'no_held_tab', message: '先在任务卡片上点“接管”要操作的页面，再在这里输入' } } };
  return { tab };
}

/** Type for a person into the tab they took over (a phone cannot raise its keyboard inside a remote view). */
async function personInput(body) {
  const { tab, error } = heldTab(body);
  if (error) return error;
  const page = tab.page;
  if (typeof body.text === 'string' && body.text) {
    if (body.text.length > 2000) return { status: 400, body: { error: 'too_long', message: '一次最多输入 2000 个字' } };
    await page.keyboard.insertText(body.text);
  }
  if (body.key !== undefined) {
    if (!PERSON_KEYS.has(body.key)) return { status: 400, body: { error: 'bad_key' } };
    await page.keyboard.press(body.key);
  }
  return { status: 200, body: { tab: tab.id, current: cursors.get(tab.key) || tab.id, title: await page.title().catch(() => ''), url: safeUrl(page) } };
}

/** Open a link for a person in a tab of their own (its own window), keeping only their latest few. */
async function personOpen(body) {
  const url = String(body.url || '');
  if (!/^https?:\/\//i.test(url)) return { status: 400, body: { error: 'bad_url' } };
  const tab = await newTab(PERSON, '你打开的网页');
  await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);
  // Nobody else sees this tab: its record carries the page's own title for the person.
  tab.title = (await tab.page.title().catch(() => '')) || tab.title;
  const old = ownTabs(PERSON).filter((t) => t.id !== tab.id).sort((a, b) => b.lastUsed - a.lastUsed).slice(MAX_PERSON_TABS - 1);
  for (const t of old) await t.page.close().catch(() => undefined);
  return { status: 200, body: { tab: snapshotRecords().find((r) => r.id === tab.id) } };
}

/** A person closes a tab they opened; task tabs are never closed from here. */
async function personClose(body) {
  const tab = registry.get(String(body.tab || ''));
  if (!tab || tab.page.isClosed() || tab.key !== PERSON) return { status: 404, body: { error: 'no_tab' } };
  await tab.page.close().catch(() => undefined);
  return { status: 200, body: { closed: tab.id } };
}

/**
 * Point at the tab the person took over: a tap on its picture (x, y as 0..1 of
 * the viewport), a scroll, or going back. Only a held tab accepts it.
 */
async function personPointer(body) {
  const { tab, error } = heldTab(body);
  if (error) return error;
  const page = tab.page;
  if (body.action === 'click') {
    const x = Number(body.x), y = Number(body.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { status: 400, body: { error: 'bad_point' } };
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    await page.mouse.click(Math.round(x * size.w), Math.round(y * size.h));
  } else if (body.action === 'scroll') {
    const dy = Math.max(-5000, Math.min(5000, Number(body.dy) || 0));
    await page.mouse.wheel(0, dy);
  } else if (body.action === 'back') {
    await page.goBack({ timeout: 15000 }).catch(() => undefined);
  } else if (body.action === 'focus') {
    // The person watches the whole desktop (noVNC): put this tab's window on top.
    await page.bringToFront().catch(() => undefined);
  } else {
    return { status: 400, body: { error: 'bad_action' } };
  }
  await page.waitForTimeout(150);
  tab.lastUsed = Date.now();
  // Tapping a field tells the phone to offer its keyboard.
  const editable = await page.evaluate(() => {
    const el = document.activeElement;
    return Boolean(el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type))));
  }).catch(() => false);
  return { status: 200, body: { tab: tab.id, current: cursors.get(tab.key) || tab.id, title: await page.title().catch(() => ''), url: safeUrl(page), editable } };
}

async function pruneFinished() {
  let closed = 0;
  for (const tab of [...registry.values()]) {
    if (!tab.finishedAt) continue;
    await tab.page.close().catch(() => undefined);
    closed += 1;
  }
  return closed;
}

// -------------------------------------------------------------------- tools

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（内容过长，已截断）` : text);
const textResult = (text) => ({ content: [{ type: 'text', text: clip(String(text)) }] });
const str = { type: 'string' };
const num = { type: 'number' };
const tabArg = { type: 'string', description: '标签页编号（如 t3，见 browser_tab_list）；省略时为本任务当前标签页' };
const ownTabArg = { type: 'string', description: '本任务创建的标签页编号；省略时为本任务当前标签页' };

async function describe(tab) {
  return `标签页 ${tab.id}：${await tab.page.title().catch(() => '')}\n${safeUrl(tab.page)}`;
}

const TOOLS = {
  browser_navigate: {
    mode: 'write', description: '在本任务自己的标签页打开网址（没有标签页时自动新建）。', input: { url: str, tab: ownTabArg }, required: ['url'],
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'write', true);
      await tab.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return textResult(await describe(tab));
    },
  },
  browser_go_back: {
    mode: 'write', description: '本任务的标签页后退一页。', input: { tab: ownTabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.goBack({ timeout: 30000 }); return textResult(await describe(tab)); },
  },
  browser_get_text: {
    mode: 'read', description: '读取标签页的可见正文文字（可只读查看其他任务的标签页）。', input: { tab: tabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'read'); return textResult(`${await describe(tab)}\n\n${await tab.page.innerText('body', { timeout: 30000 })}`); },
  },
  browser_get_html: {
    mode: 'read', description: '读取标签页（或某个选择器元素）的 HTML（可只读查看其他任务的标签页）。', input: { selector: str, tab: tabArg },
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      return textResult(a.selector ? await tab.page.locator(a.selector).first().evaluate((el) => el.outerHTML) : await tab.page.content());
    },
  },
  browser_snapshot: {
    mode: 'read', description: '标签页的无障碍结构（角色与名称），用于确定选择器（可只读查看其他任务的标签页）。', input: { tab: tabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'read'); return textResult(`${await describe(tab)}\n\n${await tab.page.locator('body').ariaSnapshot({ timeout: 30000 })}`); },
  },
  browser_screenshot: {
    mode: 'read', description: '截取标签页，返回图片并保存为文件；full_page=true 截整页（可只读查看其他任务的标签页）。', input: { full_page: { type: 'boolean' }, tab: tabArg },
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const file = path.join(OUTPUT_DIR, `tab-${tab.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`);
      const data = await capture(tab.page, { fullPage: Boolean(a.full_page) });
      fs.writeFileSync(file, data);
      return { content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `${await describe(tab)}\n截图已保存：${file}` }] };
    },
  },
  browser_click: {
    mode: 'write', description: '点击元素（Playwright 选择器），只能操作本任务创建的标签页。', input: { selector: str, tab: ownTabArg }, required: ['selector'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().click({ timeout: 15000 }); await tab.page.waitForLoadState('domcontentloaded').catch(() => undefined); return textResult(`已点击 ${a.selector}\n${await describe(tab)}`); },
  },
  browser_fill: {
    mode: 'write', description: '清空并填写输入框（Playwright 选择器），只能操作本任务创建的标签页。', input: { selector: str, text: str, tab: ownTabArg }, required: ['selector', 'text'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().fill(a.text, { timeout: 15000 }); return textResult(`已填写 ${a.selector}`); },
  },
  browser_type: {
    mode: 'write', description: '在本任务标签页的当前焦点处逐字输入文字。', input: { text: str, tab: ownTabArg }, required: ['text'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.keyboard.type(a.text); return textResult('已输入'); },
  },
  browser_press_key: {
    mode: 'write', description: '在本任务的标签页按键，例如 Enter、Tab、ArrowDown、Control+A。', input: { key: str, tab: ownTabArg }, required: ['key'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.keyboard.press(a.key); return textResult(`已按下 ${a.key}`); },
  },
  browser_select: {
    mode: 'write', description: '在下拉框中选择值（Playwright 选择器），只能操作本任务创建的标签页。', input: { selector: str, value: str, tab: ownTabArg }, required: ['selector', 'value'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().selectOption(a.value, { timeout: 15000 }); return textResult(`已选择 ${a.value}`); },
  },
  browser_hover: {
    mode: 'write', description: '鼠标悬停到元素上（Playwright 选择器），只能操作本任务创建的标签页。', input: { selector: str, tab: ownTabArg }, required: ['selector'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().hover({ timeout: 15000 }); return textResult(`已悬停 ${a.selector}`); },
  },
  browser_scroll: {
    mode: 'write', description: '上下滚动本任务的标签页，dy 为像素（负数向上），默认向下一屏。', input: { dy: num, tab: ownTabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.evaluate((dy) => window.scrollBy(0, dy || window.innerHeight), a.dy || 0); return textResult('已滚动'); },
  },
  browser_evaluate: {
    mode: 'write', description: '在本任务的标签页执行一段 JavaScript 表达式并返回结果（可能改变页面，所以只限本任务创建的标签页）。', input: { script: str, tab: ownTabArg }, required: ['script'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); const value = await tab.page.evaluate(a.script); return textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)); },
  },
  browser_wait: {
    mode: 'read', description: '等待：selector 出现，或 text 出现，或固定毫秒 ms（最长 60 秒）。', input: { selector: str, text: str, ms: num, tab: tabArg },
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      if (a.selector) await tab.page.locator(a.selector).first().waitFor({ timeout: 60000 });
      else if (a.text) await tab.page.getByText(a.text).first().waitFor({ timeout: 60000 });
      else await tab.page.waitForTimeout(Math.min(60000, Math.max(0, a.ms || 1000)));
      return textResult('等待完成');
    },
  },
  browser_request_human: {
    mode: 'write',
    description: '请用户本人在浏览器里操作并等待交还（最长 30 分钟）：登录、验证码、二次验证、输入密码或支付信息、付款、下单、发送消息、修改账号设置等，或需要用户判断的页面。reason 用一句话告诉用户要做什么。',
    input: { reason: str, tab: ownTabArg }, required: ['reason'],
    run: async (ctx, a, signal) => {
      const tab = await resolveTab(ctx, a.tab, 'write', false, true);
      tab.request = { reason: String(a.reason || '').slice(0, 300) || '需要你在浏览器里操作', at: Date.now() };
      save();
      const outcome = await waitForHuman(tab, signal);
      if (outcome === 'released') {
        return textResult(`用户已交还控制权。${await describe(tab)}\n用户可能已经完成操作或改变了页面，继续前先读取页面确认状态。`);
      }
      if (tab.request) { tab.request = null; save(); }
      if (outcome === 'timeout') {
        return { content: [{ type: 'text', text: `等了 ${Math.round(HUMAN_WAIT_MS / 60000)} 分钟，用户还没有交还标签页 ${tab.id}。请结束这一轮，告诉用户需要在浏览器里做什么；用户处理后可以引用这个任务继续。` }], isError: true };
      }
      return { content: [{ type: 'text', text: `停止等待：${outcome === 'closed' ? '标签页已关闭' : '任务已结束或被停止'}。` }], isError: true };
    },
  },
  browser_tab_list: {
    mode: 'read', description: '列出标签页及其创建任务：本任务的可操作，其他任务的只读。', input: {},
    run: async (ctx) => {
      await browserContext();
      const current = cursors.get(ctx.key);
      const rows = await Promise.all([...registry.values()].filter((t) => !t.page.isClosed() && t.key !== PERSON).map(async (t) => {
        const own = t.key === ctx.key;
        // What a person is doing in a tab is theirs: not even its title or address.
        if (t.holder === 'human') return { own, line: `${t.id === current ? '*' : ' '} [${t.id}] （用户正在操作，内容不可见） — ${own ? '本任务' : `任务「${t.title}」`}，暂不可用` };
        const who = own ? '本任务，可操作' : `任务「${t.title}」${t.finishedAt ? '（已结束）' : ''}，只读`;
        return { own, line: `${t.id === current ? '*' : ' '} [${t.id}] ${await t.page.title().catch(() => '')} ${safeUrl(t.page)} — ${who}` };
      }));
      if (!rows.length) return textResult('还没有任务创建的标签页。');
      return textResult(rows.sort((a, b) => Number(b.own) - Number(a.own)).map((r) => r.line).join('\n'));
    },
  },
  browser_tab_new: {
    mode: 'write', description: '为本任务新开一个标签页并切换过去，可选打开网址。', input: { url: str },
    run: async (ctx, a) => { const tab = await newTab(ctx.key, ctx.title); if (a.url) await tab.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 }); return textResult(await describe(tab)); },
  },
  browser_tab_select: {
    mode: 'write', description: '切换到本任务创建的某个标签页。', input: { tab: ownTabArg }, required: ['tab'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); cursors.set(ctx.key, tab.id); return textResult(await describe(tab)); },
  },
  browser_tab_close: {
    mode: 'write', description: '关闭本任务创建的某个标签页（默认当前标签页）。', input: { tab: ownTabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.close(); return textResult(`已关闭 ${tab.id}`); },
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.input, ...(t.required ? { required: t.required } : {}) },
  }));
}

/** One task's calls run one at a time; different tasks run in parallel. */
const queues = new Map();
function serialized(key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(fn);
  // The queue keeps a settled-never-rejecting tail; the caller alone handles `next`'s failure.
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

/** Run a tool within the deadline; past it, say so, and close this task's current tab if its page is hung. */
function bounded(ctx, run) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(async () => {
    let note = '请稍后重试，或换一种做法。';
    const tab = registry.get(cursors.get(ctx.key) || '');
    const target = tab && tab.targetId && (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => [])).find((t) => t.id === tab.targetId);
    if (target && !(await answers(target)) && !(await answers(target))) {
      await fetch(`${CDP}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      // A hung page reports its close late: forget it now so nobody picks it again.
      forget(tab);
      note = `标签页 ${tab.id} 已无响应，已关闭；需要时用 browser_navigate 重新打开。`;
    }
    reject(new Error(`操作超过 ${Math.round(TOOL_DEADLINE_MS / 1000)} 秒没有完成。${note}`));
  }, TOOL_DEADLINE_MS); });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

async function callTool(ctx, name, args, signal) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    return await serialized(ctx.key, async () => {
      touchTask(ctx.key, ctx.title);
      // Waiting for a person has its own clock; everything else is bounded, and a
      // late run is left behind so this task's next call is not stuck behind it.
      const run = tool.run(ctx, args || {}, signal);
      const result = name === 'browser_request_human' ? await run : await bounded(ctx, run);
      save();
      return result;
    });
  } catch (err) {
    return { content: [{ type: 'text', text: `浏览器操作失败：${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

// --------------------------------------------------------------------- http

function taskOf(req) {
  const key = String(req.headers['x-aio-task'] || '');
  let title = key;
  try { title = decodeURIComponent(String(req.headers['x-aio-task-title'] || '')) || key; } catch { /* keep the key */ }
  return { key, title: title.slice(0, 120) };
}

async function handleRpc(req, message, signal) {
  const { method, id, params } = message;
  if (id === undefined || id === null) return null; // notification
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aio_tabs', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call': {
      const ctx = taskOf(req);
      if (!KEY.test(ctx.key)) return fail(-32602, 'missing task identity');
      return reply(await callTool(ctx, params && params.name, params && params.arguments, signal));
    }
    default:
      return fail(-32601, `unknown method ${method}`);
  }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { ok: true, version: VERSION, pid: process.pid, tabs: registry.size });
    }
    // Control-plane endpoints: the ownership record, a finished turn, and on-demand destruction.
    if (req.method === 'GET' && url.pathname === '/tabs') {
      const key = url.searchParams.get('key');
      return send(res, 200, { tabs: snapshotRecords().filter((t) => !key || t.key === key) });
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      const body = await readJson(req);
      const tab = registry.get(String(body.tab || ''));
      if (!tab || tab.page.isClosed()) return send(res, 404, { error: 'no such tab' });
      if (body.key && body.key !== tab.key) return send(res, 403, { error: 'tab belongs to another task' });
      if (body.action === 'take') await takeControl(tab);
      else if (body.action === 'release') releaseControl(tab);
      else return send(res, 400, { error: 'bad action' });
      return send(res, 200, { tab: snapshotRecords().find((t) => t.id === tab.id) });
    }
    if (req.method === 'GET' && url.pathname === '/screenshot') {
      const tab = registry.get(String(url.searchParams.get('tab') || ''));
      if (!tab || tab.page.isClosed()) return send(res, 404, { error: 'no such tab' });
      const key = url.searchParams.get('key');
      if (key && key !== tab.key) return send(res, 403, { error: 'tab belongs to another task' });
      const data = await capture(tab.page, { quality: 55 });
      return send(res, 200, { mimeType: 'image/jpeg', data: data.toString('base64'), url: safeUrl(tab.page), title: await tab.page.title().catch(() => '') });
    }
    if (req.method === 'POST' && url.pathname === '/finish') {
      const body = await readJson(req);
      if (!KEY.test(String(body.key || ''))) return send(res, 400, { error: 'bad key' });
      return send(res, 200, { finished: markFinished(body.key) });
    }
    if (req.method === 'POST' && url.pathname === '/prune') return send(res, 200, { closed: await pruneFinished() });
    if (req.method === 'POST' && url.pathname === '/input') {
      const out = await personInput(await readJson(req));
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      const out = await personOpen(await readJson(req));
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && url.pathname === '/close') {
      const out = await personClose(await readJson(req));
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && url.pathname === '/pointer') {
      const out = await personPointer(await readJson(req));
      return send(res, out.status, out.body);
    }
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') return send(res, 200, {});
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    const headers = {};
    if (!Array.isArray(body) && body.method === 'initialize') headers['mcp-session-id'] = crypto.randomUUID();
    // A caller that gives up (a stopped turn) ends any wait it started.
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(req, m, abort.signal)))).filter(Boolean);
      return out.length ? send(res, 200, out, headers) : send(res, 202, undefined, headers);
    }
    const out = await handleRpc(req, body, abort.signal);
    return out ? send(res, 200, out, headers) : send(res, 202, undefined, headers);
  } catch (err) {
    return send(res, 400, { error: err && err.message ? err.message : 'bad request' });
  }
});

if (require.main === module) {
  // One task's stray failure must never take every task's browser tools down with it.
  process.on('unhandledRejection', (err) => process.stderr.write(`unhandled rejection: ${err && err.stack ? err.stack : err}\n`));
  server.listen(PORT, '127.0.0.1', () => process.stdout.write(`aio_tabs ${VERSION} listening on ${PORT}\n`));
}

module.exports = { TOOLS, toolList, handleRpc, server };
