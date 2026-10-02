#!/usr/bin/env node
"use strict";
// A pinned Playwright connection captures/restores the default Chrome context.
// State is written only to a private file; stdout contains counts or fixed codes.
const fs = require('node:fs');
const path = require('node:path');
const LIMIT = Math.max(100, Number(process.env.BROWSER_STORAGE_DEADLINE_MS) || 25000);
const CLEANUP = 5000;
const blank = '<!doctype html><html><body></body></html>';
class StorageError extends Error { constructor(code) { super(code); this.code = code; } }
const args = { command: process.argv[2], origins: [] };
for (let i = 3; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (key === 'origin') args.origins.push(new URL(process.argv[i + 1]).origin);
  else args[key] = process.argv[i + 1];
}
args.endpoint ||= 'http://127.0.0.1:9222';
const started = Date.now();
let expired = false;
let browser, context, cdp;
const probes = new Map();
const creations = new Set();
let priorTargets, priorActive;
function bounded(work, ms, code = 'storage_deadline') {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StorageError(code)), Math.max(1, ms));
  })]).finally(() => clearTimeout(timer));
}
function step(work) {
  if (expired) return Promise.reject(new StorageError('storage_deadline'));
  return bounded(work, LIMIT - (Date.now() - started));
}
async function aio(method, pathname) {
  const response = await fetch(`http://127.0.0.1:8080${pathname}`, {
    method, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new StorageError('focus_unavailable');
  return response.json();
}
async function pageIds() {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page').map(t => t.targetId).sort();
}
async function probeFor(origin) {
  // A create RPC may finish just after our deadline. Register its target before
  // resolving, and settle in-flight creations before enumerating cleanup IDs.
  const creation = cdp.send('Target.createTarget', { url: 'about:blank', background: true }).then(result => {
    probes.set(result.targetId, null);
    return result;
  });
  creations.add(creation);
  creation.then(() => creations.delete(creation), () => creations.delete(creation));
  const { targetId } = await step(creation);
  let page;
  while (!page) {
    for (const candidate of context.pages()) {
      const session = await step(context.newCDPSession(candidate));
      try {
        const info = await step(session.send('Target.getTargetInfo'));
        if (info.targetInfo.targetId === targetId) page = candidate;
      } finally { await step(session.detach()); }
      if (page) break;
    }
    if (!page) await step(new Promise(resolve => setTimeout(resolve, 20)));
  }
  probes.set(targetId, page);
  const session = await step(context.newCDPSession(page));
  try {
    await step(session.send('Network.setBypassServiceWorker', { bypass: true }));
    await step(page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: blank })));
    await step(page.goto(origin, { waitUntil: 'domcontentloaded', timeout: Math.max(1, LIMIT - (Date.now() - started)) }));
  } finally { await step(session.detach()); }
  return page;
}
async function capture() {
  priorTargets = await step(pageIds());
  const rows = (await step(aio('GET', '/v1/browser/tabs'))).data;
  const active = rows?.filter(row => row.is_active);
  if (!Array.isArray(rows) || active?.length !== 1 || rows.length !== priorTargets.length) {
    throw new StorageError('focus_unavailable');
  }
  priorActive = active[0].index;
  const origins = [...new Set(args.origins)].filter(o => /^https?:\/\//.test(o));
  const pages = new Map();
  // Keep one offline page for every origin until storageState finishes. This
  // lets Playwright collect from existing pages without creating fallback tabs.
  for (const origin of origins) pages.set(origin, await probeFor(origin));
  const state = await step(context.storageState({ indexedDB: true }));
  for (const origin of origins) {
    if (state.origins.some(entry => entry.origin === origin)) continue;
    // Playwright intentionally omits empty origins. Prove they are empty before
    // normalizing an empty entry; non-empty omissions fail closed.
    const empty = await step(pages.get(origin).evaluate(async () =>
      localStorage.length === 0 && (await indexedDB.databases()).length === 0));
    if (!empty) throw new StorageError('origin_export_incomplete');
    state.origins.push({ origin, localStorage: [], indexedDB: [] });
  }
  return { state, requestedOrigins: origins.length };
}
async function cleanup() {
  let ok = true;
  try { await bounded(Promise.allSettled([...creations]), 1000); } catch { ok = false; }
  // Close only targets this process created, even when page adoption failed.
  for (const id of probes.keys()) {
    try { await bounded(cdp.send('Target.closeTarget', { targetId: id }), 1000); }
    catch { ok = false; }
  }
  if (priorTargets) {
    try {
      const now = await bounded(pageIds(), 1000);
      if (JSON.stringify(now) !== JSON.stringify(priorTargets)) ok = false;
      else if (priorActive !== undefined) await bounded(aio('PUT', `/v1/browser/tabs/${priorActive}/activate`), 3500);
    } catch { ok = false; }
  }
  // On a CDP connection close() detaches; it does not terminate Chromium.
  try { if (browser) await bounded(browser.close(), 1000); } catch { ok = false; }
  return ok;
}
async function main() {
  let result, failure;
  try {
    if (!['export', 'import'].includes(args.command)) throw new StorageError('unknown_command');
    const pw = require(path.resolve(args.vendor, 'index.js'));
    browser = await step(pw.chromium.connectOverCDP(args.endpoint, { timeout: Math.min(LIMIT, 10000) }));
    context = browser.contexts()[0];
    if (!context) throw new StorageError('context_missing');
    cdp = await step(browser.newBrowserCDPSession());
    if (args.command === 'export') result = await capture();
    else {
      const payload = JSON.parse(fs.readFileSync(args.in, 'utf8'));
      const state = payload.state ?? payload;
      if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new StorageError('bad_state');
      // Playwright 1.63.0 public setStorageState hard-codes no timeout. Use the
      // same pinned channel with a server-side deadline so its finally closes
      // the internal storage page *before* we detach CDP. An outer Promise.race
      // alone leaves that page behind. Keep cleanup headroom for the server.
      if (!context._channel?.setStorageState) throw new StorageError('vendor_incompatible');
      await step(context._channel.setStorageState({ storageState: state }, {
        timeout: Math.max(1, LIMIT - (Date.now() - started) - 100),
      }));
      result = { state };
    }
  } catch (error) {
    expired = true;
    failure = error instanceof StorageError ? error.code : error?.name === 'TimeoutError' ? 'storage_deadline' : 'storage_error';
  } finally {
    const cleaned = await bounded(cleanup(), CLEANUP, 'cleanup_failed').catch(() => false);
    if (!cleaned) failure ||= 'cleanup_failed';
  }
  if (failure) {
    process.stdout.write(JSON.stringify({ ok: false, code: failure }) + '\n');
    process.exit(1); // bound a hung underlying API after cleanup/detach
  }
  const { state } = result;
  if (args.command === 'export') {
    fs.writeFileSync(args.out, JSON.stringify({ schema: 1, capturedAt: Date.now(), state }) + '\n', { mode: 0o600 });
    fs.chmodSync(args.out, 0o600);
  }
  process.stdout.write(JSON.stringify({ ok: true, cookies: state.cookies.length, origins: state.origins.length,
    requestedOrigins: result.requestedOrigins,
    localStorageEntries: state.origins.reduce((n, o) => n + (o.localStorage?.length || 0), 0),
    indexedDbDatabases: state.origins.reduce((n, o) => n + (o.indexedDB?.length || 0), 0) }) + '\n');
}
main().catch(() => { process.stdout.write('{"ok":false,"code":"storage_error"}\n'); process.exit(1); });
