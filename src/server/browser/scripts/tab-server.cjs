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
const MAX_TEXT = 60000;
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const { chromium } = require(process.env.AIO_TABS_PLAYWRIGHT || '/opt/aio-browser/playwright-core');

const INSTRUCTIONS = [
  '浏览器请只用 aio_tabs 的工具。每个标签页记录着创建它的任务：只有创建它的任务能操作（打开网址、点击、填写、执行脚本、关闭），其他任务只能只读查看（正文、HTML、页面结构、截图）。',
  '只读查看其他任务的页面时，先用 browser_tab_list 找到标签页编号（如 t3），再把它作为 tab 参数传给读取类工具。',
  '不要使用 `aio browser` 命令行或 /v1/browser 接口：它们操作的是整个浏览器当前可见的页面，会打断其他正在并行的任务。',
  '选择器使用 Playwright 语法：CSS（#id、.class）、text=登录、role=button[name="搜索"]；不确定时先用 browser_snapshot 查看页面结构。',
].join('\n');

// ----------------------------------------------------------------- registry

/** tabId -> { id, page, key, title, targetId, createdAt, lastUsed, finishedAt } */
const registry = new Map();
/** key -> tabId the task is currently working in */
const cursors = new Map();
let seq = 0;

function snapshotRecords() {
  return [...registry.values()].map(({ id, page, key, title, targetId, createdAt, lastUsed, finishedAt }) => ({ id, key, title, targetId, url: safeUrl(page), createdAt, lastUsed, finishedAt }));
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

function register(page, key, title, extra = {}) {
  const id = extra.id || `t${++seq}`;
  const now = Date.now();
  const tab = { id, page, key, title, targetId: extra.targetId || null, createdAt: extra.createdAt || now, lastUsed: extra.lastUsed || now, finishedAt: extra.finishedAt ?? null };
  registry.set(id, tab);
  if (!extra.id) cursors.set(key, id);
  // A link that opens a new window belongs to the same task and becomes its current tab.
  page.on('popup', (popup) => { void adoptNew(popup, key, title); });
  page.on('close', () => {
    registry.delete(id);
    if (cursors.get(key) === id) cursors.delete(key);
    save();
  });
  if (!tab.targetId) targetIdOf(page).then((t) => { tab.targetId = t; save(); }).catch(() => undefined);
  save();
  return tab;
}

async function adoptNew(page, key, title) {
  const tab = register(page, key, title);
  await enforceFinishedCap(key);
  return tab;
}

// ------------------------------------------------------------------ browser

let connecting = null;

async function browserContext() {
  if (!connecting) {
    connecting = chromium.connectOverCDP(CDP).then(async (browser) => {
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

async function newTab(key, title) {
  return adoptNew(await (await browserContext()).newPage(), key, title);
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
async function resolveTab(ctx, tabId, mode, create = false) {
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
  tab.lastUsed = Date.now();
  return tab;
}

function markFinished(key) {
  let count = 0;
  for (const tab of ownTabs(key)) {
    tab.finishedAt = Date.now();
    count += 1;
  }
  cursors.delete(key);
  save();
  return count;
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
      const data = await tab.page.screenshot({ path: file, type: 'jpeg', quality: 70, fullPage: Boolean(a.full_page), timeout: 30000 });
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
  browser_tab_list: {
    mode: 'read', description: '列出标签页及其创建任务：本任务的可操作，其他任务的只读。', input: {},
    run: async (ctx) => {
      await browserContext();
      const current = cursors.get(ctx.key);
      const rows = await Promise.all([...registry.values()].filter((t) => !t.page.isClosed()).map(async (t) => {
        const own = t.key === ctx.key;
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

async function callTool(ctx, name, args) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    return await serialized(ctx.key, async () => {
      touchTask(ctx.key, ctx.title);
      const result = await tool.run(ctx, args || {});
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

async function handleRpc(req, message) {
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
      return reply(await callTool(ctx, params && params.name, params && params.arguments));
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
    if (req.method === 'GET' && url.pathname === '/tabs') return send(res, 200, { tabs: snapshotRecords() });
    if (req.method === 'POST' && url.pathname === '/finish') {
      const body = await readJson(req);
      if (!KEY.test(String(body.key || ''))) return send(res, 400, { error: 'bad key' });
      return send(res, 200, { finished: markFinished(body.key) });
    }
    if (req.method === 'POST' && url.pathname === '/prune') return send(res, 200, { closed: await pruneFinished() });
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') return send(res, 200, {});
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    const headers = {};
    if (!Array.isArray(body) && body.method === 'initialize') headers['mcp-session-id'] = crypto.randomUUID();
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(req, m)))).filter(Boolean);
      return out.length ? send(res, 200, out, headers) : send(res, 202, undefined, headers);
    }
    const out = await handleRpc(req, body);
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
