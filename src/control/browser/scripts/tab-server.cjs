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
 * A sign-in goes through the person's password vault (browser_login): the agent
 * writes the steps (what to click, which box takes the account and which the
 * password, as placeholders), the control plane sends the saved account and
 * password (POST /login), and this server runs the steps with them while the
 * tab is locked. No tool ever returns either value. The agent reports whether
 * it worked (browser_login_report); steps that worked are kept for the site.
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
const READY_URL = process.env.AIO_TABS_READY_URL;
const READY_TOKEN = process.env.AIO_TABS_READY_TOKEN;
const OUTPUT_DIR = process.env.AIO_TABS_OUTPUT || '/home/gem/workspace/.scratch/artifacts/browser';
const STATE_FILE = process.env.AIO_TABS_STATE || '/tmp/aio-tabs-state.json';
/** Where browser_save_image may write (the person's workspace). */
const WORKSPACE = process.env.AIO_TABS_WORKSPACE || '/home/gem/workspace';
const MAX_SAVED_IMAGE = 8 * 1024 * 1024;
const MAX_FINISHED_TABS = Number(process.env.AIO_TABS_MAX_FINISHED || 8);
/** Heavy flight/store pages must not exhaust the agent's shared cgroup. */
const MAX_TASK_TABS = Math.max(1, Number(process.env.AIO_TABS_MAX_TASK_TABS || 3));
const openingTabs = new Map();
/** A finished task's tabs stay this long for a follow-up, then close on their own. */
const FINISHED_TTL_MS = Number(process.env.AIO_TABS_FINISHED_TTL_MS || 10 * 60 * 1000);
const HUMAN_WAIT_MS = Number(process.env.AIO_TABS_HUMAN_WAIT_MS || 30 * 60 * 1000);
/** No browser tool may hang a task: past this it fails with a reason (waiting for a person excepted). */
const TOOL_DEADLINE_MS = Number(process.env.AIO_TABS_TOOL_DEADLINE_MS || 90 * 1000);
/** A page that cannot evaluate `1` this fast, twice, is hung (a crashed or starved renderer). */
const PROBE_MS = Number(process.env.AIO_TABS_PROBE_MS || 5000);
/** A site's service worker is stopped this long after its last page or frame closed. */
const IDLE_WORKER_MS = Number(process.env.AIO_TABS_IDLE_WORKER_MS || 60 * 1000);
const MAX_TEXT = 60000;
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
// patchright-core: Playwright's API without Runtime.enable, whose traces let sites flag every page
// of this browser as automated while the server stays connected.
const { chromium } = require(process.env.AIO_TABS_PLAYWRIGHT || '/opt/aio-browser/patchright-core');

const INSTRUCTIONS = [
  'Use only the aio_tabs tools for the browser. Each tab records the task that created it: only that task may act on it (open URLs, click, fill, run scripts, close); other tasks may only view it read-only (text, HTML, page structure, screenshots).',
  'To view another task\'s page read-only, first use browser_tab_list to find its tab ID (such as t3), then pass it as the tab parameter to a reading tool.',
  'When checking flights, prices and the like one by one, reuse this task\'s tab: save the results you need, then change the URL; do not keep a page for each date or candidate. This task may keep at most 3 pages open at once. The browser is shared by several tasks: when memory is tight, only the page each task is currently using is guaranteed, and its other idle pages are given up to other tasks (once closed, reopen them at their original URL). When memory is tight, close your own pages that you have finished reading before continuing; do not close pages the user has taken over or pages of other tasks.',
  'When a site requires signing in, call browser_login: first use browser_snapshot to see the sign-in form clearly, then write steps (starting from a fresh reload of the current page: open the sign-in entry, fill {{username}} into the account box and {{password}} into the password box, submit). The password manager substitutes the values the user saved and runs the steps; you never see the values. Steps that worked on this site before are reused automatically, so steps may be omitted. Then read the page and use browser_login_report to report whether it succeeded; on failure, rewrite steps based on the failed step it returns and retry, at most 3 times; if it still fails, call browser_request_human. If the user saved Google sign-in for this site, it tells you to click the Google button and which account to choose. Do not use browser_fill or browser_type to enter a password, and do not read the contents of password boxes.',
  'When the user must act in the browser themselves, call browser_request_human with the reason and wait: CAPTCHAs, two-factor verification, QR-code sign-in, payment details, paying, placing an order, sending a message, changing account settings and other irreversible final steps, or a page that needs the user\'s judgment. Do not ask for passwords or verification codes in the conversation.',
  'For human-verification challenges such as "press and hold to confirm you are human" (Press & Hold), sliders or checkboxes, do not keep clicking, dragging or refreshing yourself: once the verification session in a tab has been judged to be a bot, even a person pressing it later cannot pass. First use browser_tab_new to reopen the same URL in a new tab, then use browser_tab_close to close the old tab; the new tab usually passes straight away. Only if the new tab still shows the challenge, call browser_request_human to ask the user to complete it in that new tab.',
  'After the user hands control back, read the page to confirm its current state before continuing; do not automatically redo an action whose result is uncertain; have the user check it first. You cannot read or act on a tab the user is currently operating.',
  'Do not use the `aio browser` command line or the /v1/browser API: they act on whichever page is currently visible in the whole browser and would disrupt other tasks running in parallel.',
  'Selectors use Playwright syntax: CSS (#id, .class), text=Sign in, role=button[name="Search"]; when unsure, use browser_snapshot to inspect the page structure first.',
].join('\n');

// ----------------------------------------------------------------- registry

/**
 * tabId -> { id, page, key, title, targetId, createdAt, lastUsed, finishedAt, holder, humanSince, request }
 * plus, never saved: `locked` (the vault is typing into it) and `scripted` (an
 * agent ran its own script in the current document).
 */
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
  return [...registry.values()].map(({ id, page, key, title, targetId, createdAt, lastUsed, finishedAt, holder, humanSince, request, loginReport }) => ({ id, key, title, targetId, url: safeUrl(page), createdAt, lastUsed, finishedAt, holder, humanSince, request, loginReport: loginReport || null }));
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
  if (!extra.id && !extra.keepCursor) cursors.set(key, id);
  // A link that opens a new window belongs to the same task and becomes its current tab; one
  // opened from a tab a person holds (a payment window) is theirs too, and the agent stays where it was.
  page.on('popup', (popup) => { void adoptNew(popup, key, title, tab.holder === 'human' && key !== PERSON ? { holder: 'human', humanSince: Date.now(), keepCursor: true } : {}); });
  page.on('close', () => forget(tab));
  // A new document carries none of the scripts an agent evaluated in the last one.
  page.on('domcontentloaded', () => { tab.scripted = false; });
  // A crashed renderer never recovers: close its tab so no tool or person waits on it.
  page.on('crash', () => {
    process.stdout.write(`closed crashed page: ${page.url()}\n`);
    void page.close().catch(() => undefined);
    // Most crashes here are the memory limit: make room before the task tries again.
    void reclaimMemory('crash').catch(() => undefined);
  });
  if (!tab.targetId) targetIdOf(page).then((t) => { tab.targetId = t; save(); }).catch(() => undefined);
  save();
  return tab;
}

async function adoptNew(page, key, title, extra = {}) {
  const tab = register(page, key, title, extra);
  await enforceFinishedCap(key);
  const front = frontTab();
  if (front && front.key === key && front.id !== tab.id) {
    // The page the person is looking at opened it (a link they clicked), or the task they
    // watch moved on: show the new window, and keep that one on top from now on.
    if (pinned && pinned.tabId === front.id) pin(tab);
    return tab;
  }
  keepFront();
  return tab;
}

// -------------------------------------------------- what the person looks at

/**
 * The tab a person's open browser console shows. It stays on top of the desktop
 * whatever other tasks open meanwhile: openbox raises every new window when it maps
 * it, a moment after Chromium has returned, so a new window of another task would
 * otherwise cover the page the person watches or operates. Set when a console shows
 * a tab (and renewed while it stays open), and when a person takes a tab over.
 */
const PIN_MS = Number(process.env.AIO_TABS_PIN_MS || 45 * 1000);
let pinned = null;

function pin(tab) {
  pinned = { tabId: tab.id, until: Date.now() + PIN_MS };
}

/** The tab that must stay on top: the one an open console shows, else the latest a person took over. */
function frontTab() {
  if (pinned && pinned.until > Date.now()) {
    const tab = registry.get(pinned.tabId);
    if (tab && !tab.page.isClosed()) return tab;
  }
  return [...registry.values()].filter((t) => t.holder === 'human' && !t.page.isClosed()).sort((a, b) => b.humanSince - a.humanSince)[0] || null;
}

/** Bring the front tab back on top now, and again after a late-mapping window could have covered it. */
function keepFront() {
  const raise = () => { const tab = frontTab(); if (tab) void tab.page.bringToFront().catch(() => undefined); };
  raise();
  for (const ms of [250, 800, 2000]) setTimeout(raise, ms).unref();
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
  pin(tab);
  await tab.page.bringToFront().catch(() => undefined);
}

function releaseControl(tab) {
  tab.holder = 'ai';
  tab.humanSince = null;
  tab.request = null;
  // Handed back is where the agent carries on: not a tab left idle.
  tab.lastUsed = Date.now();
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

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
/** service worker targetId -> when it was first seen with no page or frame of its origin open */
const idleWorkers = new Map();

/**
 * Stop service workers that no open page or frame uses. Chromium stops an idle
 * worker by itself after about 30 s, but not while a debugger is attached, and
 * this server's connection attaches to every worker: without this sweep each
 * site visited keeps a renderer process alive until the browser is released.
 * Closing a worker target only stops the worker; its registration stays and it
 * starts again on the site's next visit. Never connects to the browser itself.
 */
async function closeIdleWorkers(now = Date.now()) {
  const browser = connecting && (await connecting.catch(() => null));
  if (!browser) return [];
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    const inUse = new Set(targetInfos.filter((t) => t.type === 'page' || t.type === 'iframe').map((t) => originOf(t.url)));
    const idle = targetInfos.filter((t) => t.type === 'service_worker' && !inUse.has(originOf(t.url)));
    for (const id of [...idleWorkers.keys()]) if (!idle.some((t) => t.targetId === id)) idleWorkers.delete(id);
    const closed = [];
    for (const worker of idle) {
      if (!idleWorkers.has(worker.targetId)) idleWorkers.set(worker.targetId, now);
      if (now - idleWorkers.get(worker.targetId) < IDLE_WORKER_MS) continue;
      const { success } = await session.send('Target.closeTarget', { targetId: worker.targetId }).catch(() => ({ success: false }));
      if (success) closed.push(worker.url);
    }
    if (closed.length) process.stdout.write(`stopped idle service workers: ${closed.join(' ')}\n`);
    return closed;
  } finally {
    await session.detach().catch(() => undefined);
  }
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
  // A task at its cap is refused before anyone's pages are closed to make room for a page it cannot open.
  const pending = openingTabs.get(key) || 0;
  if (key !== PERSON && ownTabs(key).length + pending >= MAX_TASK_TABS) {
    throw new Error(`This task may keep at most ${MAX_TASK_TABS} tabs open at once. Check with browser_tab_list and reuse an existing tab (pass tab to browser_navigate), or close your own pages you have finished reading before opening a new one; do not close pages the user has taken over.`);
  }
  openingTabs.set(key, pending + 1);
  const browser = context.browser();
  let session;
  try {
    await makeRoom(key);
    const m = memory();
    if (m && m.used + MEM_NEED > m.max) {
      throw new Error('沙箱内存紧张，暂不新建标签页。请复用已有标签页，或先关闭本任务已读取完成的页面再继续；这不是浏览器权限问题。');
    }
    session = await browser.newBrowserCDPSession();
    // While a person looks at another tab the window opens without taking focus (keepFront still guards its stacking).
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: Boolean(frontTab()) });
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
    return adoptNew(page, key, title, { targetId });
  } finally {
    openingTabs.set(key, Math.max(0, (openingTabs.get(key) || 1) - 1));
    if (!openingTabs.get(key)) openingTabs.delete(key);
    await session?.detach().catch(() => undefined);
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
  return Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timed out; the page may still be loading, try again later')), 15000))]);
}

function ownTabs(key) {
  return [...registry.values()].filter((t) => t.key === key && !t.page.isClosed());
}

/** Destroy on demand: keep at most MAX_FINISHED_TABS finished tabs, oldest-used first to go; never one a person holds or looks at. */
async function enforceFinishedCap(exceptKey) {
  const front = frontTab();
  const finished = finishedTabs().filter((t) => t.key !== exceptKey && t !== front).sort((a, b) => a.lastUsed - b.lastUsed);
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
  if (!create) throw new Error('This task has not opened a tab yet; use browser_navigate or browser_tab_new first.');
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
    if (!tab || tab.page.isClosed()) {
      const url = reclaimed.get(String(tabId));
      if (url) throw new Error(`Tab ${tabId} was closed to free memory (it was at ${url}). Reopen this URL with browser_navigate if you need it.`);
      throw new Error(`There is no tab ${tabId}; check with browser_tab_list first.`);
    }
    if (mode === 'write' && tab.key !== ctx.key) {
      throw new Error(`Tab ${tab.id} was created by task "${tab.title}"; other tasks have read-only access (reading text, HTML, structure or screenshots).`);
    }
  } else {
    tab = await currentOwn(ctx.key, ctx.title, create);
  }
  if (tab.locked) throw new Error(`The password manager is filling in sign-in details on tab ${tab.id}; try again shortly.`);
  if (tab.holder === 'human' && !allowHuman) {
    throw new Error(`The user is operating tab ${tab.id}; you cannot read or act on it until they hand it back. If you need to wait for the user to finish, call browser_request_human and say what you are waiting for.`);
  }
  tab.lastUsed = Date.now();
  // The call's own record of its tab: a call past its deadline checks this one, not the task's current tab.
  ctx.tab = tab;
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

// ------------------------------------------------------------ password vault

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch { return ''; }
}

/** A saved site covers its own host and its subdomains. */
function siteCovers(site, host) {
  return Boolean(site) && (host === site || host.endsWith(`.${site}`));
}

const VAULT_STEP_MS = Number(process.env.AIO_TABS_VAULT_STEP_MS || 8000);
const LIKELY_USERNAME = 'input[autocomplete~="username" i], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[name*="account" i], input[name*="phone" i], input[id*="user" i], input[id*="email" i], input[id*="login" i], input[id*="account" i]';

/** The first frame showing a password box, with the box; else the first showing a likely account box. */
async function loginFields(page) {
  for (const frame of page.frames()) {
    const password = await frame.locator('input[type="password"]:visible').first().elementHandle({ timeout: 300 }).catch(() => null);
    if (!password) continue;
    // The account box is the nearest text box before the password box, in its form.
    const username = (await password.evaluateHandle((el) => {
      const usable = (i) => ['text', 'email', 'tel'].includes((i.getAttribute('type') || 'text').toLowerCase()) && !i.disabled && !i.readOnly && i.offsetParent !== null;
      const inputs = [...(el.form || document).querySelectorAll('input')];
      const before = inputs.slice(0, inputs.indexOf(el)).filter(usable);
      return before[before.length - 1] || null;
    })).asElement();
    return { frame, password, username };
  }
  for (const frame of page.frames()) {
    const username = await frame.locator(LIKELY_USERNAME).locator('visible=true').first().elementHandle({ timeout: 300 }).catch(() => null);
    if (username) return { frame, password: null, username };
  }
  return null;
}

/**
 * Press Enter in the box; a form that ignores Enter gets its submit button
 * clicked. A form that sent something is not submitted a second time, even when
 * it stays on screen.
 */
async function submitLogin(page, box) {
  const before = safeUrl(page);
  let sent = false;
  const onRequest = (request) => { if (request.method() !== 'GET') sent = true; };
  page.on('request', onRequest);
  const settled = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (safeUrl(page) !== before || !(await box.isVisible().catch(() => false))) return true;
      if (sent) { await page.waitForTimeout(1500); return true; }
      await page.waitForTimeout(150);
    }
    return false;
  };
  try {
    await box.press('Enter', { timeout: VAULT_STEP_MS });
    if (await settled(2500)) return;
    const button = (await box.evaluateHandle((el) => (el.form || document).querySelector('button[type="submit"], input[type="submit"], button:not([type])'))).asElement();
    if (button) await button.click({ timeout: VAULT_STEP_MS }).catch(() => undefined);
    await settled(VAULT_STEP_MS);
  } finally {
    page.off('request', onRequest);
  }
}

/** Type the account and password into the sign-in form and submit it. Nothing here returns or logs either. */
async function fillLogin(tab, username, password) {
  const page = tab.page;
  // A script the agent evaluated could watch the typing: start from a clean document.
  if (tab.scripted) await page.reload({ waitUntil: 'domcontentloaded', timeout: 2 * VAULT_STEP_MS });
  let fields = await loginFields(page);
  if (!fields) return 'no_form';
  if (!fields.password) {
    // An account-first sign-in: the password box appears after the account is submitted.
    await fields.username.fill(username, { timeout: VAULT_STEP_MS });
    await submitLogin(page, fields.username);
    const until = Date.now() + VAULT_STEP_MS;
    do {
      fields = await loginFields(page);
      if (fields && fields.password) break;
      await page.waitForTimeout(250);
    } while (Date.now() < until);
    if (!fields || !fields.password) return 'username_only';
  } else if (fields.username && username) {
    await fields.username.fill(username, { timeout: VAULT_STEP_MS });
  }
  await fields.password.fill(password, { timeout: VAULT_STEP_MS });
  await submitLogin(page, fields.password);
  await page.waitForLoadState('domcontentloaded', { timeout: VAULT_STEP_MS }).catch(() => undefined);
  return 'submitted';
}

/** Tries at one site's sign-in, per tab, before the agent must hand it to the person. */
const MAX_LOGIN_TRIES = Number(process.env.AIO_TABS_MAX_LOGIN_TRIES || 3);
const STEP_ACTIONS = new Set(['click', 'fill', 'press', 'wait', 'select']);
const STEP_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space']);
const PLACEHOLDERS = new Set(['{{username}}', '{{password}}']);

/** The agent's sign-in steps, checked; a string says what is wrong. Placeholders stand for the vault's values. */
function loginSteps(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || !raw.length || raw.length > 15) return 'steps must be a list of 1–15 steps';
  const steps = [];
  for (const [i, step] of raw.entries()) {
    const n = i + 1;
    if (!step || typeof step !== 'object' || !STEP_ACTIONS.has(step.action)) return `Step ${n}: action must be one of click, fill, press, wait, select`;
    const out = { action: step.action };
    if (step.selector !== undefined) {
      if (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 300) return `Step ${n}: the selector is invalid`;
      out.selector = step.selector;
    }
    if (['click', 'fill', 'select'].includes(step.action) && !out.selector) return `Step ${n} (${step.action}) needs a selector`;
    if (step.action === 'fill' || step.action === 'select') {
      if (typeof step.value !== 'string' || step.value.length > 200) return `Step ${n} needs a value (use {{username}} and {{password}} for the account and password)`;
      if (/\{\{/.test(step.value) && !PLACEHOLDERS.has(step.value)) return `Step ${n}: a placeholder must be the whole value, exactly {{username}} or {{password}}`;
      if (step.action === 'select' && PLACEHOLDERS.has(step.value)) return `Step ${n}: a dropdown cannot be filled with the account or password`;
      out.value = step.value;
    }
    if (step.action === 'press') {
      if (!STEP_KEYS.has(step.key)) return `Step ${n}: key must be one of ${[...STEP_KEYS].join(', ')}`;
      out.key = step.key;
    }
    if (step.action === 'wait') {
      if (!out.selector && !(Number(step.ms) > 0)) return `Step ${n} (wait) needs a selector or ms`;
      if (step.ms !== undefined) out.ms = Math.min(10000, Math.max(0, Number(step.ms) || 0));
    }
    steps.push(out);
  }
  if (!steps.some((s) => s.value === '{{password}}')) return 'steps must include a step that fills {{password}} into the password box';
  return steps;
}

/** A failure message the agent may read: never the values that were being typed. */
function scrub(message, secrets) {
  // eslint-disable-next-line no-control-regex
  let text = String(message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 4).join('\n').slice(0, 400);
  for (const secret of secrets) if (secret) text = text.split(secret).join('***');
  return text;
}

const describeStep = (step, i) => `第 ${i + 1} 步（${step.action}${step.selector ? ` ${step.selector}` : ''}${step.key ? ` ${step.key}` : ''}）`;

/**
 * Run sign-in steps from a fresh load of `startUrl`, so an agent's script cannot
 * already be watching the page, and a kept script replays the same way. The
 * password only goes into a real password box.
 */
async function runLoginSteps(tab, steps, startUrl, username, password) {
  const page = tab.page;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 3 * VAULT_STEP_MS });
  for (const [i, step] of steps.entries()) {
    try {
      const target = step.selector ? page.locator(step.selector).first() : null;
      if (step.action === 'click') await target.click({ timeout: VAULT_STEP_MS });
      else if (step.action === 'fill') {
        const value = step.value === '{{username}}' ? username : step.value === '{{password}}' ? password : step.value;
        if (step.value === '{{password}}') {
          const type = await target.evaluate((el) => (el.getAttribute('type') || '').toLowerCase(), undefined, { timeout: VAULT_STEP_MS });
          if (type !== 'password') return { result: 'failed', step: i, error: `${describeStep(step, i)}指向的不是密码框（type=${type || 'text'}），密码只会填进密码框` };
        }
        await target.fill(value, { timeout: VAULT_STEP_MS });
      } else if (step.action === 'select') await target.selectOption(step.value, { timeout: VAULT_STEP_MS });
      else if (step.action === 'press') {
        if (target) await target.press(step.key, { timeout: VAULT_STEP_MS });
        else await page.keyboard.press(step.key);
      } else if (step.action === 'wait') {
        if (target) await target.waitFor({ timeout: VAULT_STEP_MS });
        else await page.waitForTimeout(step.ms);
      }
    } catch (err) {
      return { result: 'failed', step: i, error: `${describeStep(step, i)}失败：${scrub(err && err.message, [username, password])}` };
    }
  }
  await page.waitForLoadState('domcontentloaded', { timeout: VAULT_STEP_MS }).catch(() => undefined);
  await page.waitForTimeout(1500);
  return { result: 'submitted' };
}

/** Whatever is still sitting in a password box is removed before any agent may read the page again. */
async function clearPasswords(page) {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const el of document.querySelectorAll('input[type="password"]')) {
        if (!el.value) continue;
        set.call(el, '');
        el.setAttribute('value', '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }).catch(() => undefined);
  }
}

/**
 * The control plane signs in for the person on a tab whose agent asked
 * (browser_login) and is waiting. Only then, and only while the page is still
 * on the site the account was saved for. The tab is locked meanwhile.
 */
async function vaultLogin(body) {
  const tab = registry.get(String(body.tab || ''));
  if (!tab || tab.page.isClosed() || (body.key && tab.key !== body.key)) return { status: 404, body: { error: 'no_tab', message: '这个标签页已经关闭或不属于该任务' } };
  if (!tab.request || tab.request.kind !== 'login' || tab.holder !== 'ai') return { status: 409, body: { error: 'no_request', message: '这个页面没有在等待登录' } };
  // A retry while the first run still types (its caller gave up) would leave a run unlocking the page under the other.
  if (tab.locked) return { status: 409, body: { error: 'busy', message: '密码器正在这个页面填写登录信息，请稍候' } };
  if (body.method === 'google') {
    // Nothing secret: the browser already holds the person's Google login. The agent uses the site's Google button.
    if (!siteCovers(String(body.site || ''), hostOf(safeUrl(tab.page)))) return { status: 409, body: { error: 'site_changed', message: '页面已经不在这个网站' } };
    tab.request = null;
    save();
    settleWaiters(tab.id, { login: 'google', account: typeof body.username === 'string' ? body.username.slice(0, 200) : '' });
    return { status: 200, body: { result: 'google' } };
  }
  if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.password || body.password.length > 1000 || body.username.length > 200) return { status: 400, body: { error: 'bad_request' } };
  if (!siteCovers(String(body.site || ''), hostOf(safeUrl(tab.page)))) return { status: 409, body: { error: 'site_changed', message: '页面已经不在这个网站，没有填入' } };
  // The agent's steps for this request, else the steps kept for the site (from where they worked), else the guess.
  const own = Array.isArray(tab.request.steps) ? tab.request.steps : null;
  const kept = own ? null : loginSteps(body.steps);
  const steps = own || (Array.isArray(kept) ? kept : null);
  const startUrl = own ? tab.request.url : (typeof body.startUrl === 'string' && siteCovers(String(body.site || ''), hostOf(body.startUrl)) ? body.startUrl : safeUrl(tab.page));
  tab.locked = true;
  let outcome;
  try {
    outcome = steps ? await runLoginSteps(tab, steps, startUrl, body.username, body.password) : { result: await fillLogin(tab, body.username, body.password) };
  } catch (err) {
    // The reason may quote what was being typed: it is scrubbed before anyone sees it.
    outcome = { result: 'failed', error: scrub(err && err.message, [body.username, body.password]) };
  } finally {
    await clearPasswords(tab.page);
    tab.locked = false;
  }
  const source = own ? 'agent' : steps ? 'kept' : 'guess';
  // A try that failed counts now; one that submitted counts when the agent reports what the page shows.
  if (outcome.result === 'submitted') tab.lastLogin = { site: String(body.site), steps, startUrl, source };
  else if (outcome.result !== 'username_only') tab.loginTries = (tab.loginTries || 0) + 1;
  // Whatever happened, the agent hears it and carries on; it never hears the account or the password.
  tab.request = null;
  save();
  settleWaiters(tab.id, { login: outcome.result, step: outcome.step, error: outcome.error, source });
  return { status: 200, body: { result: outcome.result, ...(outcome.error ? { error: outcome.error } : {}) } };
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
  const tab = [...registry.values()].filter((t) => t.holder === 'human' && !t.page.isClosed() && (!body.task || t.key === body.task)).sort((a, b) => b.humanSince - a.humanSince)[0];
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
  tab.lastUsed = Date.now();
  return { status: 200, body: { tab: tab.id, current: cursors.get(tab.key) || tab.id, title: await page.title().catch(() => ''), url: safeUrl(page) } };
}

/** A page in the person's workspace (the control plane resolved the path); `..` is normalized by the parse. */
function isWorkspaceFile(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && !parsed.host && parsed.pathname.startsWith('/home/gem/workspace/');
  } catch {
    return false;
  }
}

/** Open a link or workspace page for a person in a tab of their own (its own window), keeping only their latest few. */
async function personOpen(body) {
  const url = String(body.url || '');
  if (!/^https?:\/\//i.test(url) && !isWorkspaceFile(url)) return { status: 400, body: { error: 'bad_url' } };
  const tab = await newTab(PERSON, '你打开的网页');
  // The person asked for this page: it is what they look at now.
  pin(tab);
  await tab.page.bringToFront().catch(() => undefined);
  await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);
  // Nobody else sees this tab: its record carries the page's own title for the person.
  tab.title = (await tab.page.title().catch(() => '')) || tab.title;
  const old = ownTabs(PERSON).filter((t) => t.id !== tab.id).sort((a, b) => b.lastUsed - a.lastUsed).slice(MAX_PERSON_TABS - 1);
  for (const t of old) await t.page.close().catch(() => undefined);
  return { status: 200, body: { tab: snapshotRecords().find((r) => r.id === tab.id) } };
}

/**
 * The person reopens the page a finished task left behind (its tab was closed since):
 * a new tab of that task, at that address, theirs to operate until they hand it back.
 */
async function reopenTab(body) {
  const key = String(body.key || ''), url = String(body.url || '');
  if (!key || key === PERSON || !/^https?:\/\//i.test(url)) return { status: 400, body: { error: 'bad_request' } };
  let tab;
  try {
    tab = await newTab(key, String(body.title || '').slice(0, 200) || '重新打开的页面');
  } catch (err) {
    return { status: 503, body: { error: 'unavailable', message: String(err && err.message || err) } };
  }
  // A finished task's page: kept while the person holds it, cleared like its others once handed back.
  tab.finishedAt = Date.now();
  await takeControl(tab);
  await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => undefined);
  tab.title = (await tab.page.title().catch(() => '')) || tab.title;
  save();
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
  // Watching a task's tab (without taking it) still brings its window to the top
  // of the desktop; stacking windows changes nothing for the agent driving it.
  if (body.action === 'focus') {
    const watched = registry.get(String(body.tab || ''));
    if (!watched || watched.page.isClosed() || (body.task && watched.key !== body.task)) return { status: 404, body: { error: 'no_tab', message: '这个标签页已经关闭或不属于该任务' } };
    // The console keeps showing this tab: other tasks' new windows go underneath it.
    pin(watched);
    watched.lastUsed = Date.now();
    await watched.page.bringToFront().catch(() => undefined);
    return { status: 200, body: { tab: watched.id, current: cursors.get(watched.key) || watched.id, title: await watched.page.title().catch(() => ''), url: safeUrl(watched.page) } };
  }
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

/**
 * Close pages, always leaving one open: Chromium may exit with its last window,
 * and a restart would drop the session cookies the resident browser keeps.
 */
async function closeKeepingOne(pages) {
  const context = await browserContext();
  const doomed = new Set(pages.filter((p) => !p.isClosed()));
  if (doomed.size && context.pages().every((p) => doomed.has(p) || p.isClosed())) await context.newPage().catch(() => undefined);
  for (const page of doomed) await page.close().catch(() => undefined);
  return doomed.size;
}

/** Finished tasks' tabs nobody is operating (older than `olderThan` ms, if given). */
function finishedTabs(olderThan = 0) {
  const now = Date.now();
  return [...registry.values()].filter((t) => t.finishedAt && t.holder !== 'human' && now - t.finishedAt >= olderThan);
}

async function pruneFinished() {
  return closeKeepingOne(finishedTabs().map((t) => t.page));
}

// ------------------------------------------------------------- overview

/**
 * Every page open in the browser, for the person's tab overview: registered tabs
 * (whose task, or the person's own) and pages no record owns alike. Read from
 * Chromium's target list, so listing attaches to nothing and wakes no page.
 */
async function overview() {
  const list = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const byTarget = new Map([...registry.values()].filter((t) => t.targetId && !t.page.isClosed()).map((t) => [t.targetId, t]));
  const front = frontTab();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://')).map((t) => {
    const tab = byTarget.get(t.id);
    return {
      target: t.id, title: t.title || '', url: t.url || '',
      tab: tab ? tab.id : null, owner: tab ? (tab.key === PERSON ? 'person' : 'task') : null,
      task: tab && tab.key !== PERSON ? tab.title : null, holder: tab ? tab.holder : null,
      front: !!front && front.targetId === t.id,
    };
  });
}

/** The page behind a Chromium target id, registered or not. */
async function pageOfTarget(target) {
  for (const tab of registry.values()) if (tab.targetId === target && !tab.page.isClosed()) return { page: tab.page, tab };
  const context = await browserContext();
  for (const page of context.pages()) if ((await targetIdOf(page).catch(() => null)) === target) return { page, tab: null };
  return null;
}

/** A small preview of any page: the viewport at 40% scale. */
async function thumbnail(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const work = (async () => {
      const { cssLayoutViewport: v } = await session.send('Page.getLayoutMetrics');
      return Buffer.from((await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 0.4 } })).data, 'base64');
    })();
    return await Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error('截图超时，页面可能正在加载，请稍后再试')), 15000))]);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Show a page on the desktop for the person. A registered tab is pinned like a
 * watched one; a page no record owns cannot be pinned, so nothing pinned is
 * raised over it afterwards. Only stacking changes: no holder, no agent's work.
 */
async function bringTargetFront(target) {
  const found = await pageOfTarget(target);
  if (!found) return { status: 404, body: { error: 'no_page', message: '这个标签页已经关闭' } };
  if (found.tab) pin(found.tab);
  else pinned = null;
  await found.page.bringToFront().catch(() => undefined);
  return { status: 200, body: { target } };
}

/** Pages no task or person owns (leftover blank windows, pages from before the tab record). */
async function strayPages() {
  const context = await browserContext();
  const owned = new Set([...registry.values()].map((t) => t.page));
  return context.pages().filter((p) => !owned.has(p));
}

// ------------------------------------------------------------------- memory

/*
 * The browser, the agent and the tools share one cgroup memory limit; past it the
 * kernel kills a renderer ("Target crashed") or worse. Pages that matter less give
 * way first: finished tasks' tabs, then the person's tabs left idle, and when
 * memory is nearly gone (or a page about to open would not fit, or one just died)
 * pages nobody tracks that nobody is using, and last running tasks' idle tabs
 * beyond the one each works in. The tab a running task works in, tabs a person
 * has taken over and the tab a person looks at are never closed.
 */
const CGROUP = process.env.AIO_TABS_CGROUP || '/sys/fs/cgroup';
const MEM_HIGH = Number(process.env.AIO_TABS_MEM_HIGH || 0.85);
const MEM_CRITICAL = Number(process.env.AIO_TABS_MEM_CRITICAL || 0.92);
const MEM_LOW = Number(process.env.AIO_TABS_MEM_LOW || 0.75);
/** What a page about to open should find free: a heavy store page alone takes a few hundred MB. */
const MEM_NEED = Number(process.env.AIO_TABS_MEM_NEED_MB || 400) * 1024 * 1024;
const PERSON_IDLE_MS = Number(process.env.AIO_TABS_PERSON_IDLE_MS || 10 * 60 * 1000);
/** An untracked page left on the same address this long is taken as not in use. */
const STRAY_IDLE_MS = Number(process.env.AIO_TABS_STRAY_IDLE_MS || 15 * 60 * 1000);
/** A running task's extra tab untouched this long may give way to another task's page. */
const SPARE_IDLE_MS = Number(process.env.AIO_TABS_SPARE_IDLE_MS || 60 * 1000);
const MEM_POLL_MS = Number(process.env.AIO_TABS_MEM_POLL_MS || 5000);

/** The cgroup's working set (reclaimable page cache left out) and its OOM kills; null without a limit. */
function memory() {
  try {
    const read = (file) => fs.readFileSync(path.join(CGROUP, file), 'utf8');
    const max = Number(read('memory.max').trim());
    const current = Number(read('memory.current').trim());
    if (!(max > 0) || !(current >= 0)) return null;
    const inactive = Number((/^inactive_file (\d+)$/m.exec(read('memory.stat')) || [])[1] || 0);
    const kills = Number((/^oom_kill (\d+)$/m.exec(read('memory.events')) || [])[1] || 0);
    return { used: Math.max(0, current - inactive), max, kills };
  } catch {
    return null;
  }
}

/**
 * When each untracked page last changed address. Focus cannot tell what the person
 * is using (every page of this browser reports focus and visibility), but a page
 * in use moves on; one left on the same address for a long while is not in use.
 */
const strayChanges = new WeakMap();
function noteStrays(pages) {
  const now = Date.now();
  for (const page of pages) {
    const url = safeUrl(page);
    const seen = strayChanges.get(page);
    if (!seen || seen.url !== url) strayChanges.set(page, { url, since: now });
  }
}

/**
 * Whether a page is known to hold nothing typed. A page that does not answer in
 * time counts as holding something (hung pages have their own cleanup); unsaved
 * words are never the price of memory.
 */
async function holdsNothingTyped(page) {
  const typed = await Promise.race([
    page.evaluate(() => [...document.querySelectorAll('input, textarea')].some((el) => !/^(hidden|submit|button|reset|checkbox|radio|file|image|range|color)$/i.test(el.type || '') && el.value !== el.defaultValue)
      || [...document.querySelectorAll('[contenteditable=""], [contenteditable="true"]')].some((el) => el.textContent.trim())),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]).catch(() => null);
  return typed === false;
}

/** Whether an untracked page has stayed on the same address long enough to count as not in use. */
function strayIdle(page) {
  const seen = strayChanges.get(page);
  return Boolean(seen) && Date.now() - seen.since >= STRAY_IDLE_MS;
}

/** Untracked pages not in use: on the same address for a while, the longest first. */
async function unusedStrays() {
  const pages = await strayPages();
  noteStrays(pages);
  return pages.filter(strayIdle).sort((a, b) => strayChanges.get(a).since - strayChanges.get(b).since);
}

/**
 * The tab a task works in: of the tabs its agent drives, the one used last. A call
 * naming its tab works in it as much as one on the current tab does.
 */
function workingTab(key) {
  return ownTabs(key).filter((t) => t.holder === 'ai').sort((a, b) => b.lastUsed - a.lastUsed)[0] || null;
}

/** A running task's tab beyond the one it works in, left alone a while. */
function isSpare(t) {
  return t.key !== PERSON && !t.finishedAt && t.holder === 'ai' && !t.locked && !t.request
    && !t.page.isClosed() && workingTab(t.key) !== t && Date.now() - t.lastUsed >= SPARE_IDLE_MS;
}

/**
 * Running tasks' tabs beyond the one each works in, left alone a while. Every
 * running task is sure of one tab; more only while memory allows, so one task's
 * extra pages never keep another task out of the browser. The task holding the
 * most tabs gives first, its least recently used first.
 */
function spareTabs() {
  const held = new Map();
  for (const t of registry.values()) if (!t.page.isClosed()) held.set(t.key, (held.get(t.key) || 0) + 1);
  return [...registry.values()].filter(isSpare).sort((a, b) => held.get(b.key) - held.get(a.key) || a.lastUsed - b.lastUsed).map((t) => t.page);
}

/** Tab id -> the address it was on, for tabs closed to free memory: a task asking for one learns why it is gone. */
const reclaimed = new Map();
const recordOf = (page) => [...registry.values()].find((t) => t.page === page) || null;
function noteReclaimed(page) {
  const tab = recordOf(page);
  if (!tab) return;
  reclaimed.set(tab.id, safeUrl(page));
  if (reclaimed.size > 200) reclaimed.delete(reclaimed.keys().next().value);
}

/** The run in flight: { reason, need, exceptKey, run }. */
let reclaiming = null;
/**
 * Free memory by closing pages, least valuable first, until the working set is
 * back under the low mark (and `need` bytes are free). `poll` acts only above the
 * high mark and reaches untracked pages only when memory is critical; a page about
 * to open goes that far only when it would not fit otherwise; a crash and an OOM
 * kill go all the way. A request that reaches further than the run in flight, or
 * makes room for another page, runs again once that one is done instead of
 * settling for it. Returns the closed pages' URLs.
 */
function reclaimMemory(reason, { need = 0, exceptKey = null } = {}) {
  const busy = reclaiming;
  if (busy && (reason === 'poll' || (busy.reason !== 'poll' && busy.need === need && busy.exceptKey === exceptKey))) return busy.run;
  const entry = { reason, need, exceptKey, run: null };
  // Cleared before the run settles, so a request made after it never joins a finished run.
  entry.run = (busy ? busy.run.catch(() => []) : Promise.resolve()).then(() => reclaimOnce(reason, need, exceptKey)).finally(() => { if (reclaiming === entry) reclaiming = null; });
  reclaiming = entry;
  return entry.run;
}

async function reclaimOnce(reason, need, exceptKey) {
  let m = memory();
  if (!m) return [];
  // Every look also notes which untracked pages moved on, so their idleness is known when it matters.
  if (connecting) noteStrays(await strayPages().catch(() => []));
  const goal = Math.min(m.max * MEM_LOW, m.max - need);
  if (reason === 'poll' ? m.used < m.max * MEM_HIGH : m.used <= goal) return [];
  // Right after a restart nothing is attached yet: connecting re-claims the recorded tabs, so they can be weighed.
  if (!connecting) await browserContext().catch(() => null);
  const deep = reason === 'poll' ? m.used >= m.max * MEM_CRITICAL : reason !== 'page' || m.used + need > m.max;
  const byAge = (a, b) => a.lastUsed - b.lastUsed;
  const finished = (t) => t.finishedAt && t.holder !== 'human' && t.key !== exceptKey;
  const personIdle = (t) => t.key === PERSON && t.key !== exceptKey && Date.now() - t.lastUsed >= PERSON_IDLE_MS;
  // A recorded page still passing its tier's test, not being signed in, and not the one a person looks at.
  const tracked = (test) => (page) => { const t = recordOf(page); return Boolean(t) && !t.locked && t !== frontTab() && test(t); };
  // Each tier: its pages, least valuable first; the test each must still pass when its turn comes; whether it may hold unsaved words.
  const tiers = [
    { pages: () => [...registry.values()].filter(finished).sort(byAge).map((t) => t.page), ok: tracked(finished) },
    { pages: () => [...registry.values()].filter(personIdle).sort(byAge).map((t) => t.page), ok: tracked(personIdle), typed: true },
    ...(deep ? [
      { pages: unusedStrays, ok: (page) => { noteStrays([page]); return !recordOf(page) && strayIdle(page); }, typed: true },
      { pages: spareTabs, ok: tracked(isSpare), typed: true },
    ] : []),
  ];
  const closed = [];
  for (const tier of tiers) {
    for (const page of await tier.pages()) {
      if (m.used <= goal) break;
      // Each close waits and each probe can take seconds: a page listed earlier may since have been
      // taken over, asked about, used again or brought to the front. It is judged again right before it goes.
      if (page.isClosed() || !tier.ok(page)) continue;
      if (tier.typed && (!(await holdsNothingTyped(page)) || page.isClosed() || !tier.ok(page))) continue;
      const url = safeUrl(page);
      noteReclaimed(page);
      await closeKeepingOne([page]);
      closed.push(url);
      // A renderer takes a moment to exit and give its memory back.
      await new Promise((resolve) => setTimeout(resolve, 400));
      m = memory() || m;
    }
    if (m.used <= goal) break;
  }
  if (closed.length) process.stdout.write(`freed memory (${reason}, ${Math.round(m.used / 1048576)}/${Math.round(m.max / 1048576)} MB): closed ${closed.join(' ')}\n`);
  return closed;
}

/** Make room before a task or person opens a page: the page that is wanted comes before pages that are not. */
const makeRoom = (exceptKey) => reclaimMemory('page', { need: MEM_NEED, exceptKey }).catch(() => []);

// -------------------------------------------------------------------- tools

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (content too long, truncated)` : text);
const textResult = (text) => ({ content: [{ type: 'text', text: clip(String(text)) }] });
const str = { type: 'string' };
const num = { type: 'number' };
const tabArg = { type: 'string', description: 'Tab ID (such as t3; see browser_tab_list); defaults to this task\'s current tab' };
const ownTabArg = { type: 'string', description: 'ID of a tab this task created; defaults to this task\'s current tab' };

async function describe(tab) {
  return `Tab ${tab.id}: ${await tab.page.title().catch(() => '')}\n${safeUrl(tab.page)}`;
}

const TOOLS = {
  browser_navigate: {
    mode: 'write', description: 'Open a URL in this task\'s own tab (a tab is created automatically if there is none).', input: { url: str, tab: ownTabArg }, required: ['url'],
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'write', true);
      await makeRoom(ctx.key);
      await tab.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return textResult(await describe(tab));
    },
  },
  browser_go_back: {
    mode: 'write', description: 'Go back one page in this task\'s tab.', input: { tab: ownTabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.goBack({ timeout: 30000 }); return textResult(await describe(tab)); },
  },
  browser_get_text: {
    mode: 'read', description: 'Read the visible body text of a tab (can view other tasks\' tabs read-only).', input: { tab: tabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'read'); return textResult(`${await describe(tab)}\n\n${await tab.page.innerText('body', { timeout: 30000 })}`); },
  },
  browser_get_html: {
    mode: 'read', description: 'Read the HTML of a tab (or of the element a selector matches) (can view other tasks\' tabs read-only).', input: { selector: str, tab: tabArg },
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      return textResult(a.selector ? await tab.page.locator(a.selector).first().evaluate((el) => el.outerHTML) : await tab.page.content());
    },
  },
  browser_snapshot: {
    mode: 'read', description: 'The tab\'s accessibility structure (roles and names), used to work out selectors (can view other tasks\' tabs read-only).', input: { tab: tabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'read'); return textResult(`${await describe(tab)}\n\n${await tab.page.locator('body').ariaSnapshot({ timeout: 30000 })}`); },
  },
  browser_screenshot: {
    mode: 'read', description: 'Take a screenshot of a tab, returning the image and saving it as a file; full_page=true captures the whole page (can view other tasks\' tabs read-only).', input: { full_page: { type: 'boolean' }, tab: tabArg },
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const file = path.join(OUTPUT_DIR, `tab-${tab.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`);
      const data = await capture(tab.page, { fullPage: Boolean(a.full_page) });
      fs.writeFileSync(file, data);
      return { content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `${await describe(tab)}\nScreenshot saved: ${file}` }] };
    },
  },
  browser_save_image: {
    mode: 'read',
    description: 'Save a product picture from a web page into the workspace, for product cards and mixed text-and-image layouts in the answer. On a product page, give only path: the page\'s main product image is saved automatically (the og:image the page declares, otherwise the largest image on the page). On a list page such as search results, use selector to point at that product\'s image element: if the element is an image or contains one, the original image is downloaded; otherwise the element itself is captured. You may also give url. Everything is downloaded as this tab (its cookies and Referer), so there is no need to copy image URLs by hand, and you should not. path is where to save: an absolute path inside the workspace ending in .jpg/.png/.webp, placed in this task\'s directory. Returns the saved path; reference it directly in the answer (can view other tasks\' tabs read-only).',
    input: { path: { type: 'string', description: 'Absolute path to save to, for example /home/gem/workspace/tasks/<task directory>/saros-10r.jpg' }, selector: { type: 'string', description: 'Element to capture (Playwright selector)' }, url: { type: 'string', description: 'Address of the image to download (may be relative)' }, tab: tabArg },
    required: ['path'],
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      const target = path.posix.normalize(String(a.path || ''));
      if (!target.startsWith(`${WORKSPACE}/`) || !/\.(jpe?g|png|webp)$/i.test(target)) throw new Error(`path must be an absolute path inside ${WORKSPACE} ending in .jpg, .png or .webp`);
      // The picture itself, as the page would load it: its cookies and its referer (stores refuse hotlinks).
      const download = async (address) => {
        const from = new URL(String(address), tab.page.url());
        if (!/^https?:$/.test(from.protocol)) throw new Error('url must be an http(s) image address');
        const res = await tab.page.context().request.get(from.href, { headers: { referer: tab.page.url() }, timeout: 20000, maxRedirects: 5 });
        if (!res.ok()) throw new Error(`Image download failed: HTTP ${res.status()}`);
        const type = String(res.headers()['content-type'] || '');
        if (!type.startsWith('image/') || type.includes('svg')) throw new Error(`This address did not return a raster image (${type || 'unknown type'}); use the main image's address or use selector instead`);
        return res.body();
      };
      let data;
      if (a.selector) {
        const element = tab.page.locator(String(a.selector)).first();
        // A picture element is downloaded, not photographed: a screenshot of a zoomed
        // page is cut off by the zoom, and the original is sharper anyway.
        const source = await element.evaluate((el) => {
          const img = el.tagName === 'IMG' ? el : el.querySelector('img');
          if (img) return img.getAttribute('data-old-hires') || img.getAttribute('data-zoom-image') || img.getAttribute('data-large') || img.currentSrc || img.src || null;
          const bg = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage);
          return bg ? new URL(bg[1], location.href).href : null;
        }, null, { timeout: 15000 });
        if (source && /^https?:/i.test(source)) data = await download(source);
        else {
          const png = /\.png$/i.test(target);
          data = await element.screenshot({ type: png ? 'png' : 'jpeg', ...(png ? {} : { quality: 85 }), timeout: 15000, animations: 'disabled' });
        }
      } else if (a.url) data = await download(a.url);
      else {
        // Only a path: the page's own main picture, the one it declares for sharing, else its largest.
        const source = await tab.page.evaluate(() => {
          const meta = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[property="twitter:image"], meta[name="twitter:image"]');
          if (meta && meta.content) return new URL(meta.content, location.href).href;
          let best = null; let area = 0;
          for (const img of document.querySelectorAll('img')) {
            const r = img.getBoundingClientRect();
            if (r.width < 80 || r.height < 80 || r.width * r.height <= area) continue;
            area = r.width * r.height;
            best = img.getAttribute('data-old-hires') || img.currentSrc || img.src || null;
          }
          return best;
        });
        if (!source || !/^https?:/i.test(source)) throw new Error('No main product image was found on this page: use selector to point at the product image element, or give url');
        data = await download(source);
      }
      if (!data.length || data.length > MAX_SAVED_IMAGE) throw new Error(data.length ? 'The image is larger than 8 MB' : 'The image obtained is empty');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      return textResult(`Saved: ${target} (${Math.max(1, Math.round(data.length / 1024))} KB)`);
    },
  },
  browser_click: {
    mode: 'write', description: 'Click an element (Playwright selector); only acts on tabs this task created.', input: { selector: str, tab: ownTabArg }, required: ['selector'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().click({ timeout: 15000 }); await tab.page.waitForLoadState('domcontentloaded').catch(() => undefined); return textResult(`Clicked ${a.selector}\n${await describe(tab)}`); },
  },
  browser_fill: {
    mode: 'write', description: 'Clear and fill an input box (Playwright selector); only acts on tabs this task created.', input: { selector: str, text: str, tab: ownTabArg }, required: ['selector', 'text'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().fill(a.text, { timeout: 15000 }); return textResult(`Filled ${a.selector}`); },
  },
  browser_type: {
    mode: 'write', description: 'Type text character by character at the current focus in this task\'s tab.', input: { text: str, tab: ownTabArg }, required: ['text'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.keyboard.type(a.text); return textResult('Typed'); },
  },
  browser_press_key: {
    mode: 'write', description: 'Press a key in this task\'s tab, for example Enter, Tab, ArrowDown, Control+A.', input: { key: str, tab: ownTabArg }, required: ['key'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.keyboard.press(a.key); return textResult(`Pressed ${a.key}`); },
  },
  browser_select: {
    mode: 'write', description: 'Select a value in a dropdown (Playwright selector); only acts on tabs this task created.', input: { selector: str, value: str, tab: ownTabArg }, required: ['selector', 'value'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().selectOption(a.value, { timeout: 15000 }); return textResult(`Selected ${a.value}`); },
  },
  browser_hover: {
    mode: 'write', description: 'Hover the mouse over an element (Playwright selector); only acts on tabs this task created.', input: { selector: str, tab: ownTabArg }, required: ['selector'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.locator(a.selector).first().hover({ timeout: 15000 }); return textResult(`Hovered over ${a.selector}`); },
  },
  browser_scroll: {
    mode: 'write', description: 'Scroll this task\'s tab up or down; dy is in pixels (negative scrolls up); defaults to one screen down.', input: { dy: num, tab: ownTabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await tab.page.evaluate((dy) => window.scrollBy(0, dy || window.innerHeight), a.dy || 0); return textResult('Scrolled'); },
  },
  browser_evaluate: {
    mode: 'write', description: 'Run a JavaScript expression in this task\'s tab and return the result (it may change the page, so only on tabs this task created).', input: { script: str, tab: ownTabArg }, required: ['script'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); tab.scripted = true; const value = await tab.page.evaluate(a.script, undefined, undefined, false); return textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)); },
  },
  browser_wait: {
    mode: 'read', description: 'Wait for selector to appear, or for text to appear, or for a fixed ms milliseconds (at most 60 seconds).', input: { selector: str, text: str, ms: num, tab: tabArg },
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'read');
      if (a.selector) await tab.page.locator(a.selector).first().waitFor({ timeout: 60000 });
      else if (a.text) await tab.page.getByText(a.text).first().waitFor({ timeout: 60000 });
      else await tab.page.waitForTimeout(Math.min(60000, Math.max(0, a.ms || 1000)));
      return textResult('Wait finished');
    },
  },
  browser_request_human: {
    mode: 'write',
    description: 'Ask the user to act in the browser themselves and wait for them to hand it back (up to 30 minutes): signing in, CAPTCHAs, two-factor verification, entering a password or payment details, paying, placing an order, sending a message, changing account settings and so on, or a page that needs the user\'s judgment. reason tells the user in one sentence what to do.',
    input: { reason: str, tab: ownTabArg }, required: ['reason'],
    run: async (ctx, a, signal) => {
      const tab = await resolveTab(ctx, a.tab, 'write', false, true);
      tab.request = { reason: String(a.reason || '').slice(0, 300) || '需要你在浏览器里操作', at: Date.now() };
      save();
      const outcome = await waitForHuman(tab, signal);
      if (outcome === 'released') {
        return textResult(`The user has handed control back. ${await describe(tab)}\nThe user may have finished the action or changed the page; read the page to confirm its state before continuing.`);
      }
      if (tab.request) { tab.request = null; save(); }
      if (outcome === 'timeout') {
        return { content: [{ type: 'text', text: `Waited ${Math.round(HUMAN_WAIT_MS / 60000)} minutes and the user has not handed back tab ${tab.id}. End this turn and tell the user what they need to do in the browser; once they have done it, they can reference this task to continue.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Stopped waiting: ${outcome === 'closed' ? 'the tab was closed' : 'the task has ended or was stopped'}.` }], isError: true };
    },
  },
  browser_login: {
    mode: 'write',
    description: 'Sign in to the current site with the password manager. First use browser_snapshot to see the sign-in form clearly, then write steps: starting after a fresh reload of the current page, open the sign-in entry, fill {{username}} into the account box, fill {{password}} into the password box (it must be a type=password box), and submit. The system substitutes the account and password the user saved for the placeholders and runs the steps; you never see the values. If the user saved Google sign-in for this site, you are told to click the Google button and which account to choose. If nothing has been saved, the user is asked to fill it in (waiting up to 30 minutes). When it returns, read the page and call browser_login_report to report whether sign-in succeeded.',
    input: {
      steps: {
        type: 'array',
        description: 'Sign-in steps, at most 15. Each step is {action: click|fill|press|wait|select, selector?, value?, key?, ms?}; a value of {{username}} or {{password}} is replaced with the password manager\'s value. Steps that worked on this site last time are reused automatically, so this may be omitted.',
        items: { type: 'object', properties: { action: str, selector: str, value: str, key: str, ms: num }, required: ['action'] },
      },
      tab: ownTabArg,
    },
    run: async (ctx, a, signal) => {
      const tab = await resolveTab(ctx, a.tab, 'write', false, true);
      const site = hostOf(safeUrl(tab.page));
      if (!site) return { content: [{ type: 'text', text: 'The current tab is not a web page; first use browser_navigate to open the site you want to sign in to.' }], isError: true };
      if ((tab.loginTries || 0) >= MAX_LOGIN_TRIES) {
        return { content: [{ type: 'text', text: `Signing in to this site has failed ${tab.loginTries} times already. Do not call browser_login again: call browser_request_human to ask the user to sign in themselves in the browser, and say which step it got stuck on.` }], isError: true };
      }
      const steps = loginSteps(a.steps);
      if (typeof steps === 'string') return { content: [{ type: 'text', text: `steps cannot be used: ${steps}. Fix them and call again.` }], isError: true };
      tab.request = { kind: 'login', site, reason: `需要登录 ${site}`, at: Date.now(), ...(steps ? { steps, url: safeUrl(tab.page) } : {}) };
      save();
      const outcome = await waitForHuman(tab, signal);
      const left = Math.max(0, MAX_LOGIN_TRIES - (tab.loginTries || 0));
      const used = outcome && outcome.source === 'kept' ? ' (using the steps that worked on this site last time)' : '';
      if (outcome && outcome.login === 'submitted') {
        return textResult(`The password manager filled in the account and password${outcome.source === 'guess' ? '' : ' using the steps'} and submitted${used}. ${await describe(tab)}\nRead the page to confirm whether sign-in succeeded, then call browser_login_report to report the result (steps that succeed are remembered for next time). If the page says the account or password is wrong, report failure and tell the user to check it in the password manager; if a verification code or two-factor verification is still required, call browser_request_human.`);
      }
      if (outcome && outcome.login === 'google') {
        const which = outcome.account ? `the Google account ${outcome.account}` : 'the Google account already signed in to the browser';
        return textResult(`The user saved "Sign in with Google" for ${site}, with ${which}. Click a button on the page such as 「使用 Google 登录」, "Continue with Google" or "Sign in with Google" (if you cannot find one, click the sign-in entry first); when Google's account chooser appears, choose ${outcome.account ? 'this account' : 'the signed-in account'}, and if an authorization confirmation appears, click continue. Do not call browser_login again, and do not enter any password; if Google asks for a password, a verification code or two-factor verification, call browser_request_human. When done, read the page to confirm you are signed in. ${await describe(tab)}`);
      }
      if (outcome && outcome.login === 'username_only') {
        return textResult(`The password manager filled in the account and moved to the next step, but no password box appeared. ${await describe(tab)}\nRead the page to confirm its state, write steps, then call browser_login again.`);
      }
      if (outcome && outcome.login) {
        const why = outcome.error || (outcome.login === 'no_form' ? 'no account or password box was found on the page' : 'could not fill in this page');
        return { content: [{ type: 'text', text: left > 0
          ? `Sign-in did not complete${used}: ${why}.\nUse browser_snapshot to see the sign-in form clearly, rewrite steps, then call browser_login again (steps start from a fresh reload of the current page and must include the step that opens the sign-in form). Attempts left: ${left}.`
          : `Sign-in did not complete: ${why}. It has been tried ${MAX_LOGIN_TRIES} times already. Do not call browser_login again: call browser_request_human to ask the user to sign in themselves, and say which step it got stuck on.` }], isError: true };
      }
      if (outcome === 'released') {
        return textResult(`The user chose to sign in themselves in the browser and has handed control back. ${await describe(tab)}\nRead the page to confirm its state before continuing.`);
      }
      if (tab.request) { tab.request = null; save(); }
      if (outcome === 'timeout') {
        return { content: [{ type: 'text', text: `Waited ${Math.round(HUMAN_WAIT_MS / 60000)} minutes and the user has not handled the sign-in on tab ${tab.id}. End this turn and tell the user this site needs them to sign in; once they have done it, they can reference this task to continue.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Stopped waiting: ${outcome === 'closed' ? 'the tab was closed' : 'the task has ended or was stopped'}.` }], isError: true };
    },
  },
  browser_login_report: {
    mode: 'write',
    description: 'After browser_login, read the page and report whether sign-in really succeeded: with ok=true the steps from this attempt are remembered and used directly the next time you sign in to this site; with ok=false, write one sentence in note about where it got stuck (for example "said the password was wrong after submitting", "still on the sign-in form").',
    input: { ok: { type: 'boolean' }, note: str, tab: ownTabArg }, required: ['ok'],
    run: async (ctx, a) => {
      const tab = await resolveTab(ctx, a.tab, 'write');
      if (!tab.lastLogin) return { content: [{ type: 'text', text: 'This tab has not signed in with the password manager recently.' }], isError: true };
      const ok = a.ok === true;
      tab.loginReport = { ...tab.lastLogin, ok, note: String(a.note || '').slice(0, 300), at: Date.now() };
      if (ok) tab.loginTries = 0;
      else tab.loginTries = (tab.loginTries || 0) + 1;
      tab.lastLogin = null;
      save();
      if (ok) return textResult('Recorded: these steps will be used directly the next time you sign in to this site.');
      const left = Math.max(0, MAX_LOGIN_TRIES - tab.loginTries);
      return textResult(left > 0 ? `Recorded this failure. Rewrite steps, then call browser_login again; attempts left: ${left}. If the account or password is wrong, tell the user to check it in the password manager and do not retry.` : `It has been tried ${MAX_LOGIN_TRIES} times already. Do not call browser_login again: call browser_request_human to ask the user to sign in themselves.`);
    },
  },
  browser_tab_list: {
    mode: 'read', description: 'List tabs and the tasks that created them: this task\'s tabs can be acted on, other tasks\' tabs are read-only.', input: {},
    run: async (ctx) => {
      await browserContext();
      const current = cursors.get(ctx.key);
      const rows = await Promise.all([...registry.values()].filter((t) => !t.page.isClosed() && t.key !== PERSON).map(async (t) => {
        const own = t.key === ctx.key;
        // What a person is doing in a tab is theirs: not even its title or address.
        if (t.holder === 'human') return { own, line: `${t.id === current ? '*' : ' '} [${t.id}] (the user is operating it; contents hidden) — ${own ? 'this task' : `task "${t.title}"`}, unavailable for now` };
        const who = own ? 'this task, can act' : `task "${t.title}"${t.finishedAt ? ' (finished)' : ''}, read-only`;
        return { own, line: `${t.id === current ? '*' : ' '} [${t.id}] ${await t.page.title().catch(() => '')} ${safeUrl(t.page)} — ${who}` };
      }));
      if (!rows.length) return textResult('No task has created a tab yet.');
      return textResult(rows.sort((a, b) => Number(b.own) - Number(a.own)).map((r) => r.line).join('\n'));
    },
  },
  browser_tab_new: {
    mode: 'write', description: 'Open a new tab for this task and switch to it, optionally opening a URL.', input: { url: str },
    run: async (ctx, a) => { const tab = await newTab(ctx.key, ctx.title); ctx.tab = tab; if (a.url) await tab.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 }); return textResult(await describe(tab)); },
  },
  browser_tab_select: {
    mode: 'write', description: 'Switch to a tab this task created.', input: { tab: ownTabArg }, required: ['tab'],
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); cursors.set(ctx.key, tab.id); return textResult(await describe(tab)); },
  },
  browser_tab_close: {
    mode: 'write', description: 'Close a tab this task created (the current tab by default).', input: { tab: ownTabArg },
    run: async (ctx, a) => { const tab = await resolveTab(ctx, a.tab, 'write'); await closeKeepingOne([tab.page]); return textResult(`Closed ${tab.id}`); },
  },
  browser_tabs_cleanup: {
    mode: 'write',
    description: 'Clean up the browser: close all tabs of finished tasks, plus pages that belong to no task (such as blank pages). Use it when the user asks to close or clean up tabs. Tabs of tasks in progress and pages the user is operating are not closed; the browser always keeps one blank page.',
    input: {},
    run: async () => {
      const finished = finishedTabs();
      const stray = await strayPages();
      const closed = await closeKeepingOne([...finished.map((t) => t.page), ...stray]);
      const kept = [...registry.values()].filter((t) => !t.page.isClosed() && !finished.includes(t));
      return textResult(`Closed ${closed} page(s). ${kept.length ? `Kept ${kept.length} (tasks in progress or pages the user is operating): ${kept.map((t) => `${t.id} "${t.title}"`).join(', ')}` : 'No other tasks\' pages were kept.'}`);
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

/** Run a tool within the deadline; past it, say so, and close the tab it used if that page is hung (never one a person holds). */
function bounded(ctx, run) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(async () => {
    let note = 'Try again later, or take a different approach.';
    const tab = ctx.tab && registry.get(ctx.tab.id) === ctx.tab && ctx.tab.holder !== 'human' ? ctx.tab : null;
    const target = tab && tab.targetId && (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => [])).find((t) => t.id === tab.targetId);
    // Probing takes seconds: a person may have taken the tab over meanwhile.
    if (target && !(await answers(target)) && !(await answers(target)) && tab.holder !== 'human') {
      await fetch(`${CDP}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      // A hung page reports its close late: forget it now so nobody picks it again.
      forget(tab);
      note = `Tab ${tab.id} stopped responding and was closed; reopen it with browser_navigate if you need it.`;
    }
    reject(new Error(`The action did not finish within ${Math.round(TOOL_DEADLINE_MS / 1000)} seconds. ${note}`));
  }, TOOL_DEADLINE_MS); });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

async function callTool(ctx, name, args, signal) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    return await serialized(ctx.key, async () => {
      // The dispatcher's resource prediction is not an access grant. A task can
      // discover it needs a browser later; recover it before any tool side effect.
      if (READY_URL) {
        const ready = await fetch(READY_URL, {
          method: 'POST', headers: { authorization: `Bearer ${READY_TOKEN}` },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
        });
        await ready.body?.cancel();
        if (!ready.ok) throw new Error('The browser is not ready yet and automatic recovery failed; try again later. This is not a missing browser permission.');
      }
      touchTask(ctx.key, ctx.title);
      // Waiting for a person has its own clock; everything else is bounded, and a
      // late run is left behind so this task's next call is not stuck behind it.
      const run = tool.run(ctx, args || {}, signal);
      const result = name === 'browser_request_human' || name === 'browser_login' ? await run : await bounded(ctx, run);
      save();
      return result;
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const hint = /crashed/i.test(message) ? '\nThe page was killed by the system (most likely out of memory); it has been closed and memory from idle pages freed; reopen it with browser_navigate and try again.' : '';
    return { content: [{ type: 'text', text: `Browser action failed: ${message}${hint}` }], isError: true };
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
      const m = memory();
      return send(res, 200, { ok: true, version: VERSION, pid: process.pid, tabs: registry.size, ...(m ? { memory: { usedMb: Math.round(m.used / 1048576), maxMb: Math.round(m.max / 1048576), oomKills: m.kills } } : {}) });
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
    // The person's overview of every open page, a preview of one, and bringing one to the front.
    if (req.method === 'GET' && url.pathname === '/overview') return send(res, 200, { pages: await overview() });
    if (req.method === 'GET' && url.pathname === '/overview/shot') {
      const found = await pageOfTarget(String(url.searchParams.get('target') || ''));
      if (!found) return send(res, 404, { error: 'no such page' });
      return send(res, 200, { mimeType: 'image/jpeg', data: (await thumbnail(found.page)).toString('base64') });
    }
    if (req.method === 'POST' && url.pathname === '/overview/front') {
      const out = await bringTargetFront(String((await readJson(req)).target || ''));
      return send(res, out.status, out.body);
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
    if (req.method === 'POST' && url.pathname === '/login') {
      const out = await vaultLogin(await readJson(req));
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      const out = await personOpen(await readJson(req));
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && url.pathname === '/reopen') {
      const out = await reopenTab(await readJson(req));
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
  // Finished tasks' tabs close on their own once nobody can follow up on them.
  setInterval(() => {
    const due = finishedTabs(FINISHED_TTL_MS);
    if (due.length) void serialized('__sweep__', () => closeKeepingOne(due.map((t) => t.page))).catch(() => undefined);
  }, Math.min(60_000, FINISHED_TTL_MS)).unref();
  setInterval(() => void closeIdleWorkers().catch(() => undefined), 30_000).unref();
  // Watch the memory limit: an OOM kill since the last look frees memory at once.
  let kills = memory()?.kills ?? 0;
  setInterval(() => {
    const m = memory();
    if (!m) return;
    const killed = m.kills > kills;
    kills = m.kills;
    void reclaimMemory(killed ? 'oom' : 'poll').catch(() => undefined);
  }, MEM_POLL_MS).unref();
  // One task's stray failure must never take every task's browser tools down with it.
  process.on('unhandledRejection', (err) => process.stderr.write(`unhandled rejection: ${err && err.stack ? err.stack : err}\n`));
  server.listen(PORT, '127.0.0.1', () => process.stdout.write(`aio_tabs ${VERSION} listening on ${PORT}\n`));
}

module.exports = { TOOLS, toolList, handleRpc, server, closeIdleWorkers, reclaimMemory };
