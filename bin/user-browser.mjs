/**
 * The AI's own Chrome on this Mac, offered next to the phone by the Mac app's
 * bridge (phone-bridge.mjs serves it as POST /browser/mcp and GET /browser/status).
 *
 * It is the Google Chrome installed on the Mac, started by this bridge with a
 * profile of its own (beside the phone runtime), never the user's profile: a
 * Chrome the bridge starts may be opened for remote debugging without the
 * prompt Chrome raises for the user's own browser, and the sign-ins made in it
 * stay in that profile. It runs headless, so it has no window, Dock icon or focus
 * to take from the person using the Mac; the console shows its pages instead (a
 * screencast of each, the way OBS shows a window that is not in front).
 * chrome-devtools-mcp drives it (--browserUrl), each page the agent opens gets a
 * window of its own (every page keeps painting, whatever the others do), and the
 * bridge keeps one DevTools connection of its own for the person's live view.
 *
 * Only tools that act inside the browser pass: nothing that reads or writes files
 * on this Mac (uploads, saving screenshots, traces or snapshots to a path), nothing
 * that changes the browser itself (emulation, window size), and pages only open
 * http(s) or about:blank (no file://, no chrome:// settings pages).
 *
 * chrome-devtools-mcp speaks MCP over stdio; this module keeps one child and one
 * MCP session with it, and answers each JSON-RPC request the gateway sends on its
 * own (the gateway keeps no session with the Mac).
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

/** The tools offered: they act in the AI's Chrome and reach nothing else on this Mac. */
export const ALLOWED_TOOLS = new Set([
  "list_pages",
  "new_page",
  "select_page",
  "close_page",
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "wait_for",
  "click",
  "hover",
  "fill",
  "fill_form",
  "type_text",
  "press_key",
  "drag",
  "handle_dialog",
  "evaluate_script",
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
]);

/** Arguments that name a file on this Mac (filePath, filePaths, requestFilePath, outputDirPath, ...). */
const PATH_ARG = /path/i;
const PAGE_URL = /^(https?:\/\/|about:blank$)/i;
const CALL_TIMEOUT_MS = 100_000;
/** Chrome writes its DevTools port within a second or two; a cold start after an update takes longer. */
const START_TIMEOUT_MS = 30_000;
/** Every page the agent opens: a desktop window of its own. */
const PAGE_SIZE = { width: 1280, height: 800 };
/** Live view: the largest picture sent (pages are 1280 wide; a zoomed phone wants every pixel of that). */
const FRAME_MAX = 1600;
/** …and at most one picture this often: a scrolling page paints far faster than the link to the console carries. */
const FRAME_GAP_MS = 125;

export const UNAVAILABLE =
  "The AI's Chrome on the user's Mac is not available right now: Google Chrome is not installed on that Mac, or it did not start. Use the sandbox browser (aio_tabs) for this task instead.";
const NO_FILES = "Files on the user's Mac are not reachable from here: call it again without any file path (screenshots and snapshots come back in the reply).";

/** Where Google Chrome is installed: the system's Applications folder, else the user's own. */
export function defaultChromePath(home = process.env.HOME ?? "") {
  const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
  return [path.join("/Applications", app), path.join(home, "Applications", app)].find((p) => fs.existsSync(p)) ?? path.join("/Applications", app);
}

/**
 * The user agent of that Chrome as a window would send it: headless Chrome names
 * itself HeadlessChrome, which sites treat as a robot. Null when the version is unknown.
 */
export function userAgentFor(chromePath) {
  try {
    const plist = fs.readFileSync(path.join(path.dirname(path.dirname(chromePath)), "Info.plist"), "utf8");
    const major = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./.exec(plist)?.[1];
    return major ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : null;
  } catch {
    return null;
  }
}

/**
 * The Mac's preferred languages as Chrome names them ("zh-Hans-US" -> "zh-CN"):
 * headless Chrome would otherwise ask every site for English.
 */
export function macLanguages(read = () => execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 3000 })) {
  let listed;
  try {
    listed = [...read().matchAll(/"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?\s*[,)]/g)].map((m) => m[1]);
  } catch {
    return [];
  }
  const chrome = listed.map((tag) => {
    const [lang, ...rest] = tag.split("-");
    if (lang === "zh") return rest.includes("Hant") ? (rest.includes("HK") ? "zh-HK" : "zh-TW") : "zh-CN";
    const region = rest.find((p) => /^[A-Z]{2}$/.test(p));
    return region ? `${lang}-${region}` : lang;
  });
  return [...new Set(chrome)];
}

/** Chrome's command line: its own profile, headless, open for DevTools on loopback only. */
export function chromeArgs(profileDir, userAgent, languages = []) {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    // navigator.webdriver stays false, as in a browser a person uses.
    "--disable-blink-features=AutomationControlled",
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    ...(languages.length ? [`--lang=${languages[0]}`, `--accept-lang=${languages.join(",")}`] : []),
    `--window-size=${PAGE_SIZE.width},${PAGE_SIZE.height}`,
    // Every page keeps running at full speed, whether or not anyone looks at it.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ];
}

/** The reason a tools/call may not go through, or null. */
export function refused(msg) {
  if (msg?.method !== "tools/call") return null;
  const name = msg.params?.name;
  if (!ALLOWED_TOOLS.has(name)) return `tool ${name} is not available in the AI's Chrome`;
  const args = msg.params?.arguments ?? {};
  if (Object.keys(args).some((k) => PATH_ARG.test(k))) return NO_FILES;
  if ((name === "new_page" || (name === "navigate_page" && (args.type ?? "url") === "url")) && !PAGE_URL.test(String(args.url ?? ""))) {
    return "Only http(s) pages (or about:blank) can be opened in the AI's Chrome.";
  }
  return null;
}

/** The offered tools, without the arguments that name files on this Mac or that only make sense for a shared browser. */
export function filterTools(tools) {
  return tools.filter((t) => ALLOWED_TOOLS.has(t?.name)).map((t) => {
    const schema = t.inputSchema ?? {};
    const drop = (k) => PATH_ARG.test(k) || (t.name === "new_page" && (k === "background" || k === "isolatedContext"));
    const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !drop(k)));
    const required = (schema.required ?? []).filter((k) => !drop(k));
    return { ...t, inputSchema: { ...schema, properties, ...(schema.required ? { required } : {}) } };
  });
}

/** The DevTools port a running Chrome wrote into its profile, if it answers there. */
async function livePort(profileDir) {
  let port, wsPath;
  try {
    [port, wsPath] = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n");
  } catch {
    return null;
  }
  port = Number(port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !wsPath?.startsWith("/devtools/browser/")) return null;
  const open = await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
  return open ? { port, wsPath: wsPath.trim() } : null;
}

/** A DevTools connection: send(method, params, sessionId) and the events it carries. */
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 1;
    const pending = new Map();
    const listeners = new Set();
    let closed = false;
    const cdp = {
      send(method, params = {}, sessionId) {
        if (closed) return Promise.reject(new Error("Chrome closed"));
        const id = next++;
        return new Promise((ok, fail) => {
          pending.set(id, { ok, fail });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      get closed() { return closed; },
      onClose: null,
      close() { ws.close(); },
    };
    ws.addEventListener("open", () => resolve(cdp));
    ws.addEventListener("error", () => { if (!closed) reject(new Error("Chrome's DevTools did not answer")); });
    ws.addEventListener("close", () => {
      closed = true;
      for (const { fail } of pending.values()) fail(new Error("Chrome closed"));
      pending.clear();
      cdp.onClose?.();
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== undefined) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter?.fail(new Error(msg.error.message));
        else waiter?.ok(msg.result);
        return;
      }
      for (const fn of listeners) fn(msg);
    });
  });
}

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const textOf = (result) => (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const toolError = (id, text) => reply(id, { content: [{ type: "text", text }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keys the person's live view may press: [code, keyCode, text]. */
const KEYS = {
  Enter: ["Enter", 13, "\r"], Backspace: ["Backspace", 8], Tab: ["Tab", 9], Escape: ["Escape", 27], Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
};
/** Shortcuts the live view passes on as editing commands (Chrome on a Mac takes these, not the key itself). */
const COMMANDS = { a: "selectAll", z: "undo", Z: "redo", x: "cut", c: "copy" };
const BUTTONS = { left: 1, right: 2, middle: 4 };

/**
 * @param {object} opts
 * @param {string} opts.entry        chrome-devtools-mcp's bin script
 * @param {string} opts.profileDir   the AI's own Chrome profile
 * @param {string} [opts.chromePath] the Chrome executable (Google Chrome by default)
 * @param {(msg: string, extra?: object) => void} opts.log
 */
export function createUserBrowser({ entry, profileDir, chromePath = defaultChromePath(), log }) {
  /** @type {null | {proc: import("node:child_process").ChildProcess, port: number | null, init: Promise<object>, pending: Map<number, (m: object) => void>, reached: boolean}} */
  let child = null;
  /** @type {null | {cdp: object, port: number, proc: import("node:child_process").ChildProcess | null}} */
  let chrome = null;
  let starting = null;
  let next = 1;
  let closed = false;
  /** pageId (chrome-devtools-mcp's, for its current session) -> Chrome's target id */
  const targets = new Map();
  let opening = Promise.resolve();

  /** The AI's Chrome, started (or found still running from an earlier bridge) on first need. */
  function ensureChrome() {
    if (chrome && !chrome.cdp.closed) return Promise.resolve(chrome);
    starting ??= (async () => {
      try {
        fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
        let found = await livePort(profileDir);
        let proc = null;
        if (!found) {
          if (!fs.existsSync(chromePath)) throw new Error("Google Chrome is not installed");
          // A port file left by a Chrome that is gone would be read as this one's.
          fs.rmSync(path.join(profileDir, "DevToolsActivePort"), { force: true });
          proc = spawn(chromePath, chromeArgs(profileDir, userAgentFor(chromePath), macLanguages()), { stdio: "ignore" });
          let exited = false;
          proc.once("exit", (code, signal) => { exited = true; if (!closed) log("ai chrome exited", { code, signal }); });
          proc.once("error", () => { exited = true; });
          const until = Date.now() + START_TIMEOUT_MS;
          while (!found && !exited && Date.now() < until) {
            await sleep(100);
            found = await livePort(profileDir);
          }
          if (!found) { proc.kill("SIGTERM"); throw new Error("Chrome did not start"); }
          log("ai chrome started", { pid: proc.pid, port: found.port });
        } else {
          log("ai chrome found running", { port: found.port });
        }
        const cdp = await connectCdp(`ws://127.0.0.1:${found.port}${found.wsPath}`);
        const self = { cdp, port: found.port, proc };
        cdp.onClose = () => {
          if (chrome === self) chrome = null;
          targets.clear();
          // Its pages went with it: the next call starts over with a new Chrome and a new session.
          if (child) stop(child);
        };
        chrome = self;
        return self;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function start(port) {
    // Before Chrome runs (a handshake, a tool list) the server gets a port nothing answers on: it connects only on a tool call.
    const proc = spawn(process.execPath, [entry, "--browserUrl", `http://127.0.0.1:${port ?? 9}`, "--performanceCrux=false"], {
      env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map();
    const self = { proc, port, pending, reached: false, init: null };
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) return write(self, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    });
    proc.stdin.on("error", () => undefined);
    proc.on("exit", (code, signal) => {
      if (child === self) child = null;
      targets.clear();
      for (const resolve of pending.values()) resolve({ error: { message: "browser tools stopped" } });
      pending.clear();
      if (!closed) log("browser tools exited", { code, signal });
    });
    self.init = call(self, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "aio-user-browser", version: "1" } }, 30_000).then((m) => {
      if (!m.result) throw new Error(m.error?.message ?? "browser tools did not start");
      write(self, { jsonrpc: "2.0", method: "notifications/initialized" });
      return m.result;
    });
    self.init.catch(() => stop(self));
    log("browser tools started", { pid: proc.pid });
    return self;
  }

  function write(self, msg) {
    if (self.proc.stdin.writable) self.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** One request to the child; resolves with its answer, or with `{ timeout: true }`. */
  function call(self, method, params, timeoutMs) {
    const id = next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { self.pending.delete(id); resolve({ timeout: true }); }, timeoutMs);
      self.pending.set(id, (m) => { clearTimeout(timer); self.pending.delete(id); resolve(m); });
      write(self, { jsonrpc: "2.0", id, method, params });
    });
  }

  function stop(self) {
    if (child === self) child = null;
    self.proc.kill("SIGTERM");
  }

  /** The MCP session; for a tool call, one attached to the running Chrome. */
  async function ready(port) {
    if (child && port !== undefined && child.port !== port) stop(child);
    child ??= start(port ?? chrome?.port ?? null);
    const self = child;
    return { self, init: await self.init };
  }

  /** A tool call on the running Chrome: its result, or an Error. */
  async function tool(name, args, timeoutMs = CALL_TIMEOUT_MS) {
    const { port } = await ensureChrome();
    const { self } = await ready(port);
    const answer = await call(self, "tools/call", { name, arguments: args }, timeoutMs);
    if (answer.timeout) throw new Error("Chrome did not answer in time");
    if (!answer.result || answer.result.isError) throw new Error(textOf(answer.result) || answer.error?.message || `${name} failed`);
    self.reached = true;
    return answer.result;
  }

  /**
   * new_page: a window of its own (chrome-devtools-mcp would open a tab, which stops
   * painting whenever another task's tab is in front), then the page loads in it.
   */
  async function newPage(args) {
    // One at a time: the new window is found by the mark it opens with.
    const done = opening.then(async () => {
      const { cdp } = await ensureChrome();
      const mark = `aio-${crypto.randomBytes(6).toString("hex")}`;
      const { targetId } = await cdp.send("Target.createTarget", { url: `about:blank#${mark}`, newWindow: true, background: true, ...PAGE_SIZE });
      let pageId = null;
      for (let i = 0; i < 20 && pageId === null; i++) {
        const found = new RegExp(`^(\\d+): .*about:blank#${mark}`, "m").exec(textOf(await tool("list_pages", {})));
        if (found) pageId = Number(found[1]);
        else await sleep(100);
      }
      if (pageId === null) {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
        throw new Error("the new page did not show up");
      }
      targets.set(pageId, targetId);
      return pageId;
    });
    opening = done.catch(() => undefined);
    const pageId = await done;
    const loaded = await tool("navigate_page", { pageId, type: "url", url: args.url, ...(args.timeout ? { timeout: args.timeout } : {}) });
    // Selected, so the page list marks it as this call's page (the gateway reads that line).
    await tool("select_page", { pageId, bringToFront: false }).catch(() => undefined);
    const pages = await tool("list_pages", {});
    // Only the last page list, where this page is the selected one, names pages.
    const withoutPages = (c) => (c.type === "text" ? { ...c, text: c.text.replace(/^## Pages\n(?:.*\n?)*?(?=^## |(?![^]))/m, "").trim() } : c);
    return { content: [...(loaded.content ?? []).map(withoutPages).filter((c) => c.type !== "text" || c.text), ...(pages.content ?? [])] };
  }

  /** The answer to one JSON-RPC message from the gateway; null for a notification. */
  async function handle(msg) {
    if (Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { id, method, params } = msg ?? {};
    if (id === undefined || id === null) return null;
    if (method === "ping") return reply(id, {});
    if (method === "initialize" || method === "tools/list") {
      const { self, init } = await ready();
      if (method === "initialize") return reply(id, { ...init, protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : init.protocolVersion });
      const listed = await call(self, "tools/list", params ?? {}, 30_000);
      if (!listed.result) throw new Error("browser tools did not list their tools");
      return reply(id, { ...listed.result, tools: filterTools(listed.result.tools ?? []) });
    }
    if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } };
    const why = refused(msg);
    if (why) return toolError(id, why);
    try {
      await ensureChrome();
    } catch (err) {
      log("ai chrome unavailable", { error: err.message });
      return toolError(id, UNAVAILABLE);
    }
    const args = params.arguments ?? {};
    if (params.name === "new_page") {
      try {
        return reply(id, await newPage(args));
      } catch (err) {
        return toolError(id, err.message);
      }
    }
    // Nothing the agent does brings a page forward: there is no window, and the person's view follows each page anyway.
    const forwarded = params.name === "select_page" ? { ...params, arguments: { ...args, bringToFront: false } } : params;
    const { self } = await ready(chrome?.port);
    const answer = await call(self, "tools/call", forwarded, CALL_TIMEOUT_MS);
    if (answer.timeout) return toolError(id, "The AI's Chrome did not answer in time; read the page again before retrying.");
    if (answer.result && !answer.result.isError) self.reached = true;
    if (params.name === "close_page" && answer.result && !answer.result.isError) targets.delete(args.pageId);
    return answer.result ? reply(id, answer.result) : toolError(id, answer.error?.message ?? "the browser tools failed");
  }

  /** Chrome's target behind one of chrome-devtools-mcp's page ids (marked through the page itself when not known). */
  async function targetOf(pageId) {
    const { cdp } = await ensureChrome();
    const known = targets.get(pageId);
    if (known) return known;
    const mark = `aio-${crypto.randomBytes(6).toString("hex")}`;
    await tool("evaluate_script", { pageId, function: `() => { window.__aioPage = ${JSON.stringify(mark)}; return true; }` }, 20_000);
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const info of targetInfos.filter((t) => t.type === "page")) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      try {
        const { result } = await cdp.send("Runtime.evaluate", { expression: "window.__aioPage", returnByValue: true }, sessionId);
        if (result?.value === mark) {
          targets.set(pageId, info.targetId);
          return info.targetId;
        }
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
    }
    throw new Error("that page is not open any more");
  }

  async function screenshot(pageId) {
    const result = await tool("take_screenshot", { pageId, format: "jpeg", quality: 50 }, 20_000);
    const image = result.content?.find((c) => c.type === "image");
    if (!image) throw new Error("no picture of the page");
    return { type: image.mimeType ?? "image/jpeg", body: Buffer.from(image.data, "base64") };
  }

  /** One input from the live view on the page's session; positions are fractions of the viewport. */
  async function input(cdp, sessionId, msg, size, held) {
    const x = Math.round(clamp(msg.x, 0, 1) * size.width), y = Math.round(clamp(msg.y, 0, 1) * size.height);
    const mouse = (params) => cdp.send("Input.dispatchMouseEvent", { x, y, modifiers: modifiers(msg.mods), ...params }, sessionId);
    if (msg.t === "click") {
      const button = msg.button === "right" ? "right" : "left";
      await mouse({ type: "mouseMoved", buttons: 0 });
      await mouse({ type: "mousePressed", button, buttons: BUTTONS[button], clickCount: clamp(msg.count ?? 1, 1, 3) });
      return mouse({ type: "mouseReleased", button, buttons: 0, clickCount: clamp(msg.count ?? 1, 1, 3) });
    }
    if (msg.t === "pointer" && ["down", "move", "up"].includes(msg.phase)) {
      // A press held across moves: dragging a slider, a map, a "press and hold" check, or selecting text.
      const button = msg.button === "right" ? "right" : msg.button === "middle" ? "middle" : "left";
      if (msg.phase === "down") held.add(button);
      if (msg.phase === "up") held.delete(button);
      const buttons = [...held].reduce((n, b) => n | BUTTONS[b], 0);
      if (msg.phase === "move") return mouse({ type: "mouseMoved", buttons, ...(held.size ? { button: [...held][0] } : {}) });
      return mouse({ type: msg.phase === "down" ? "mousePressed" : "mouseReleased", button, buttons, clickCount: 1 });
    }
    if (msg.t === "wheel" || msg.t === "scroll") {
      // A real wheel turn: whatever scrolls under the pointer scrolls, sideways too.
      return mouse({ type: "mouseWheel", deltaX: Math.round(clamp(msg.dx ?? 0, -5000, 5000)), deltaY: Math.round(clamp(msg.dy ?? 0, -5000, 5000)) });
    }
    if (msg.t === "text" && typeof msg.s === "string" && msg.s) return cdp.send("Input.insertText", { text: msg.s.slice(0, 2000) }, sessionId);
    if (msg.t === "key" && typeof msg.k === "string") {
      const mods = modifiers(msg.mods);
      const command = (mods & 4 || mods & 2) && COMMANDS[mods & 8 ? msg.k.toUpperCase() : msg.k.toLowerCase()];
      if (command) return cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: msg.k, modifiers: mods, commands: [command] }, sessionId);
      const key = KEYS[msg.k];
      if (!key) return null;
      const [code, keyCode, text] = key;
      const base = { key: msg.k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods };
      await cdp.send("Input.dispatchKeyEvent", { type: text && !mods ? "keyDown" : "rawKeyDown", ...base, ...(text && !mods ? { text, unmodifiedText: text } : {}) }, sessionId);
      return cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
    }
    if (msg.t === "nav" && ["back", "forward"].includes(msg.to)) {
      const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory", {}, sessionId);
      const entry = entries[currentIndex + (msg.to === "back" ? -1 : 1)];
      return entry ? cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId) : null;
    }
    if (msg.t === "nav" && msg.to === "reload") return cdp.send("Page.reload", {}, sessionId);
    return null;
  }

  /**
   * The live view of one page on a WebSocket: binary frames are JPEG pictures as
   * Chrome paints them (a screencast: a still page sends nothing), text frames
   * `{type:"size"}` / `{type:"error"}`; what comes back is input.
   */
  function stream(ws, pageId) {
    let open = true;
    let detach = () => undefined;
    const say = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    ws.on("close", () => { open = false; detach(); });
    ws.on("error", () => ws.terminate());
    void (async () => {
      try {
        const { cdp } = await ensureChrome();
        const targetId = await targetOf(pageId);
        if (!open) return;
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        let size = { width: PAGE_SIZE.width, height: PAGE_SIZE.height };
        const held = new Set();
        let unacked = null;
        const ack = () => {
          if (unacked === null) return;
          const frame = unacked;
          unacked = null;
          void cdp.send("Page.screencastFrameAck", { sessionId: frame }, sessionId).catch(() => undefined);
        };
        let pump = null;
        const off = cdp.on((msg) => {
          if (msg.method === "Target.detachedFromTarget" ? msg.params?.sessionId === sessionId : msg.sessionId === sessionId && msg.method === "Inspector.detached") {
            say({ type: "error", message: "the page was closed" });
            ws.close(1000, "page closed");
            return;
          }
          if (msg.sessionId !== sessionId) return;
          if (msg.method === "Page.screencastFrame") {
            const { data, metadata, sessionId: frame } = msg.params;
            const width = Math.round(metadata.deviceWidth), height = Math.round(metadata.deviceHeight);
            if (width !== size.width || height !== size.height) { size = { width, height }; say({ type: "size", ...size }); }
            if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, "base64"), { binary: true });
            // The next picture is asked for once this one has left, and not sooner than FRAME_GAP_MS: a slow viewer gets fewer, never a backlog.
            unacked = frame;
            const sentAt = Date.now();
            const drain = () => {
              const wait = FRAME_GAP_MS - (Date.now() - sentAt);
              if (open && (wait > 0 || ws.bufferedAmount >= 256 * 1024)) pump = setTimeout(drain, Math.max(wait, 50));
              else { pump = null; ack(); }
            };
            if (!pump) drain();
          }
        });
        detach = () => {
          off();
          clearTimeout(pump);
          void cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
          void cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
          // A press the viewer left behind (the socket dropped mid-drag) is let go.
          for (const button of held) void cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button, buttons: 0 }, sessionId).catch(() => undefined);
        };
        if (!open) return detach();
        await cdp.send("Page.enable", {}, sessionId);
        const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId).catch(() => null);
        if (metrics?.cssVisualViewport) size = { width: Math.round(metrics.cssVisualViewport.clientWidth), height: Math.round(metrics.cssVisualViewport.clientHeight) };
        say({ type: "size", ...size });
        // The page as it is now, then whatever it paints next.
        const first = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, sessionId).catch(() => null);
        if (first && ws.readyState === ws.OPEN) ws.send(Buffer.from(first.data, "base64"), { binary: true });
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: FRAME_MAX, maxHeight: FRAME_MAX, everyNthFrame: 1 }, sessionId);
        // One input at a time, in order: a press, its moves and its release stay a drag.
        let queue = Promise.resolve();
        ws.on("message", (data, binary) => {
          if (binary) return;
          let msg;
          try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
          queue = queue.then(() => input(cdp, sessionId, msg, size, held)).catch((err) => say({ type: "error", message: err.message }));
        });
      } catch (err) {
        say({ type: "error", message: err.message });
        ws.close(1011, "unavailable");
      }
    })();
  }

  return {
    handle,
    screenshot,
    /** The person takes a page over: it has no window to bring forward, so only check it is still open. */
    async front(pageId) {
      await targetOf(pageId);
    },
    stream,
    /** Whether the AI's Chrome can be used (Chrome installed), and whether it is running now. */
    async status() {
      return { available: fs.existsSync(chromePath), connected: Boolean(chrome && !chrome.cdp.closed && child?.reached) };
    },
    close() {
      closed = true;
      if (child) stop(child);
      // Its own Chrome ends with the bridge; one found running from an earlier bridge is asked to close.
      if (chrome?.proc) chrome.proc.kill("SIGTERM");
      else if (chrome) void chrome.cdp.send("Browser.close").catch(() => undefined);
    },
  };
}

/** Modifier bits as DevTools counts them, from the live view's names. */
function modifiers(mods) {
  if (!Array.isArray(mods)) return 0;
  return (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") ? 2 : 0) | (mods.includes("meta") ? 4 : 0) | (mods.includes("shift") ? 8 : 0);
}
