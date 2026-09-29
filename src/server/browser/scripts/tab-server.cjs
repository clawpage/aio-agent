#!/usr/bin/env node
'use strict';
/**
 * Tab-scoped browser tools for parallel tasks (MCP over streamable HTTP, JSON
 * responses). Every caller names its task in the X-AIO-Task header and only ever
 * sees and drives the tabs it opened, so several tasks share one Chromium (and
 * its logins) without fighting over a global "current page". Tabs are locked,
 * the browser is not.
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
const MAX_TEXT = 60000;
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const { chromium } = require(process.env.AIO_TABS_PLAYWRIGHT || '/opt/aio-browser/playwright-core');

const INSTRUCTIONS = [
  '浏览器请只用 aio_tabs 的工具。每个任务有自己独立的标签页，与其他并行任务互不影响；登录状态在同一个浏览器里共享。',
  '不要使用 `aio browser` 命令行或 /v1/browser 接口：它们操作的是整个浏览器当前可见的页面，会打断其他正在并行的任务。',
  '选择器使用 Playwright 语法：CSS（#id、.class）、text=登录、role=button[name="搜索"]；不确定时先用 browser_snapshot 查看页面结构。',
].join('\n');

// ------------------------------------------------------------------ browser

let connecting = null;
/** key -> { pages: Page[], current: number, lastUsed: number } */
const tabs = new Map();

async function browserContext() {
  if (!connecting) {
    connecting = chromium.connectOverCDP(CDP).then((browser) => {
      // A released or restarted Chromium invalidates every page handle.
      browser.on('disconnected', () => { connecting = null; tabs.clear(); });
      return browser;
    }).catch((err) => { connecting = null; throw err; });
  }
  const browser = await connecting;
  return browser.contexts()[0] || browser.newContext();
}

function ownedTabs(key) {
  let t = tabs.get(key);
  if (!t) { t = { pages: [], current: -1, lastUsed: Date.now() }; tabs.set(key, t); }
  t.pages = t.pages.filter((p) => !p.isClosed());
  if (t.current >= t.pages.length) t.current = t.pages.length - 1;
  t.lastUsed = Date.now();
  return t;
}

function adopt(key, page) {
  const t = ownedTabs(key);
  t.pages.push(page);
  t.current = t.pages.length - 1;
  // A link that opens a new window belongs to the same task and becomes its current tab.
  page.on('popup', (popup) => adopt(key, popup));
  return page;
}

async function newTab(key) {
  return adopt(key, await (await browserContext()).newPage());
}

async function currentTab(key, create) {
  const t = ownedTabs(key);
  if (t.current >= 0) return t.pages[t.current];
  if (!create) throw new Error('这个任务还没有打开标签页，请先用 browser_navigate 或 browser_tab_new。');
  return newTab(key);
}

async function releaseKey(key) {
  const t = tabs.get(key);
  tabs.delete(key);
  if (!t) return 0;
  let closed = 0;
  for (const p of t.pages) {
    if (p.isClosed()) continue;
    await p.close().catch(() => undefined);
    closed += 1;
  }
  return closed;
}

// -------------------------------------------------------------------- tools

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（内容过长，已截断）` : text);
const textResult = (text) => ({ content: [{ type: 'text', text: clip(String(text)) }] });
const str = { type: 'string' };
const num = { type: 'number' };

async function describe(page) {
  return `当前标签页：${await page.title().catch(() => '')}\n${page.url()}`;
}

const TOOLS = {
  browser_navigate: {
    description: '在本任务自己的标签页打开网址（没有标签页时自动新建）。',
    input: { url: str }, required: ['url'],
    run: async (key, a) => {
      const page = await currentTab(key, true);
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return textResult(await describe(page));
    },
  },
  browser_go_back: {
    description: '本任务当前标签页后退一页。', input: {},
    run: async (key) => { const page = await currentTab(key, false); await page.goBack({ timeout: 30000 }); return textResult(await describe(page)); },
  },
  browser_get_text: {
    description: '读取当前标签页的可见正文文字。', input: {},
    run: async (key) => { const page = await currentTab(key, false); return textResult(`${await describe(page)}\n\n${await page.innerText('body', { timeout: 30000 })}`); },
  },
  browser_get_html: {
    description: '读取当前标签页（或某个选择器元素）的 HTML。', input: { selector: str },
    run: async (key, a) => {
      const page = await currentTab(key, false);
      return textResult(a.selector ? await page.locator(a.selector).first().evaluate((el) => el.outerHTML) : await page.content());
    },
  },
  browser_snapshot: {
    description: '当前标签页的无障碍结构（角色与名称），用于确定点击或填写的选择器。', input: {},
    run: async (key) => { const page = await currentTab(key, false); return textResult(`${await describe(page)}\n\n${await page.locator('body').ariaSnapshot({ timeout: 30000 })}`); },
  },
  browser_screenshot: {
    description: '截取当前标签页，返回图片并保存为文件。full_page=true 截整页。', input: { full_page: { type: 'boolean' } },
    run: async (key, a) => {
      const page = await currentTab(key, false);
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const file = path.join(OUTPUT_DIR, `tab-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`);
      const data = await page.screenshot({ path: file, type: 'jpeg', quality: 70, fullPage: Boolean(a.full_page), timeout: 30000 });
      return { content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `截图已保存：${file}` }] };
    },
  },
  browser_click: {
    description: '点击元素（Playwright 选择器）。', input: { selector: str }, required: ['selector'],
    run: async (key, a) => { const page = await currentTab(key, false); await page.locator(a.selector).first().click({ timeout: 15000 }); await page.waitForLoadState('domcontentloaded').catch(() => undefined); return textResult(`已点击 ${a.selector}\n${await describe(page)}`); },
  },
  browser_fill: {
    description: '清空并填写输入框（Playwright 选择器）。', input: { selector: str, text: str }, required: ['selector', 'text'],
    run: async (key, a) => { const page = await currentTab(key, false); await page.locator(a.selector).first().fill(a.text, { timeout: 15000 }); return textResult(`已填写 ${a.selector}`); },
  },
  browser_type: {
    description: '在当前焦点处逐字输入文字。', input: { text: str }, required: ['text'],
    run: async (key, a) => { const page = await currentTab(key, false); await page.keyboard.type(a.text); return textResult('已输入'); },
  },
  browser_press_key: {
    description: '按键，例如 Enter、Tab、ArrowDown、Control+A。', input: { key: str }, required: ['key'],
    run: async (key, a) => { const page = await currentTab(key, false); await page.keyboard.press(a.key); return textResult(`已按下 ${a.key}`); },
  },
  browser_select: {
    description: '在下拉框中选择值（Playwright 选择器）。', input: { selector: str, value: str }, required: ['selector', 'value'],
    run: async (key, a) => { const page = await currentTab(key, false); await page.locator(a.selector).first().selectOption(a.value, { timeout: 15000 }); return textResult(`已选择 ${a.value}`); },
  },
  browser_hover: {
    description: '鼠标悬停到元素上（Playwright 选择器）。', input: { selector: str }, required: ['selector'],
    run: async (key, a) => { const page = await currentTab(key, false); await page.locator(a.selector).first().hover({ timeout: 15000 }); return textResult(`已悬停 ${a.selector}`); },
  },
  browser_scroll: {
    description: '上下滚动当前页面，dy 为像素（负数向上），默认向下一屏。', input: { dy: num },
    run: async (key, a) => { const page = await currentTab(key, false); await page.evaluate((dy) => window.scrollBy(0, dy || window.innerHeight), a.dy || 0); return textResult('已滚动'); },
  },
  browser_evaluate: {
    description: '在当前标签页执行一段 JavaScript 表达式并返回结果（可 JSON 化的值）。', input: { script: str }, required: ['script'],
    run: async (key, a) => { const page = await currentTab(key, false); const value = await page.evaluate(a.script); return textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)); },
  },
  browser_wait: {
    description: '等待：selector 出现，或 text 出现，或固定毫秒 ms（最长 60 秒）。', input: { selector: str, text: str, ms: num },
    run: async (key, a) => {
      const page = await currentTab(key, false);
      if (a.selector) await page.locator(a.selector).first().waitFor({ timeout: 60000 });
      else if (a.text) await page.getByText(a.text).first().waitFor({ timeout: 60000 });
      else await page.waitForTimeout(Math.min(60000, Math.max(0, a.ms || 1000)));
      return textResult('等待完成');
    },
  },
  browser_tab_list: {
    description: '列出本任务自己的标签页（看不到其他任务的标签页）。', input: {},
    run: async (key) => {
      const t = ownedTabs(key);
      if (!t.pages.length) return textResult('这个任务还没有打开标签页。');
      const lines = await Promise.all(t.pages.map(async (p, i) => `${i === t.current ? '*' : ' '} [${i}] ${await p.title().catch(() => '')} ${p.url()}`));
      return textResult(lines.join('\n'));
    },
  },
  browser_tab_new: {
    description: '为本任务新开一个标签页并切换过去，可选打开网址。', input: { url: str },
    run: async (key, a) => { const page = await newTab(key); if (a.url) await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 }); return textResult(await describe(page)); },
  },
  browser_tab_select: {
    description: '切换到本任务的第 index 个标签页（见 browser_tab_list）。', input: { index: num }, required: ['index'],
    run: async (key, a) => {
      const t = ownedTabs(key);
      if (!(a.index >= 0 && a.index < t.pages.length)) throw new Error('没有这个标签页');
      t.current = a.index;
      return textResult(await describe(t.pages[a.index]));
    },
  },
  browser_tab_close: {
    description: '关闭本任务的第 index 个标签页（默认当前标签页）。', input: { index: num },
    run: async (key, a) => {
      const t = ownedTabs(key);
      const index = a.index === undefined ? t.current : a.index;
      if (!(index >= 0 && index < t.pages.length)) throw new Error('没有这个标签页');
      await t.pages[index].close();
      ownedTabs(key);
      return textResult('已关闭');
    },
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

async function callTool(key, name, args) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    return await serialized(key, () => tool.run(key, args || {}));
  } catch (err) {
    return { content: [{ type: 'text', text: `浏览器操作失败：${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

// --------------------------------------------------------------------- http

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
      const key = String(req.headers['x-aio-task'] || '');
      if (!KEY.test(key)) return fail(-32602, 'missing task identity');
      return reply(await callTool(key, params && params.name, params && params.arguments));
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
      return send(res, 200, { ok: true, version: VERSION, pid: process.pid, tasks: tabs.size });
    }
    if (req.method === 'POST' && url.pathname === '/release') {
      const body = await readJson(req);
      if (!KEY.test(String(body.key || ''))) return send(res, 400, { error: 'bad key' });
      return send(res, 200, { closed: await releaseKey(body.key) });
    }
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

module.exports = { TOOLS, toolList, handleRpc, releaseKey, ownedTabs, server };
