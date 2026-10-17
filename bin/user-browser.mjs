/**
 * The user's own Chrome on this Mac, offered next to the phone by the Mac app's
 * bridge (phone-bridge.mjs serves it as POST /browser/mcp and GET /browser/status).
 * chrome-devtools-mcp attaches to the Chrome the user is already running
 * (--autoConnect, Chrome 144+), with their tabs and signed-in accounts; the user
 * allows that once in chrome://inspect/#remote-debugging and in the prompt Chrome
 * shows when the bridge connects. Nothing is launched: no Chrome open for remote
 * debugging means the tools answer that the user's browser is unavailable, and the
 * agent falls back to its sandbox browser.
 *
 * Only tools that act inside the browser pass: nothing that reads or writes files
 * on this Mac (uploads, saving screenshots, traces or snapshots to a path), nothing
 * that changes the browser itself (emulation, window size), and pages only open
 * http(s) or about:blank (no file://, no chrome:// settings pages).
 *
 * chrome-devtools-mcp speaks MCP over stdio; this module keeps one child and one
 * MCP session with it, and answers each JSON-RPC request the gateway sends on its
 * own (the gateway keeps no session with the Mac).
 *
 * The person's console gets the same Chrome through that one connection (Chrome
 * asks to allow each new one): a picture of a task's page, bringing it to the
 * front, and a live view (JPEG frames) that takes clicks, scrolling, keys and text.
 * Those use tools the agent is not offered (click_at), never files on this Mac.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** The tools offered: they act in the user's Chrome and reach nothing else on this Mac. */
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
/** Until the child has reached Chrome once, a call that hangs is Chrome waiting for the user to allow the connection. */
const CONNECT_TIMEOUT_MS = 40_000;
/** Once one call has waited that long, later ones only check whether the user has allowed it meanwhile. */
const STILL_WAITING_MS = 3_000;

export const UNAVAILABLE =
  "The user's Chrome on their Mac is not available for automation right now: Chrome is not open, or remote debugging is not turned on in chrome://inspect/#remote-debugging. Use the sandbox browser (aio_tabs) for this task instead.";
const NOT_ALLOWED =
  "Chrome on the user's Mac did not accept the connection in time: Chrome asks the user to allow remote debugging when the agent connects, and nobody allowed it yet. Use the sandbox browser (aio_tabs) for now, or ask the user to click Allow in Chrome and try again.";
/** Live view: at most this often a new frame, sooner after an input. */
const FRAME_MS = 500;
/** Keys the person's live view may press. */
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);
const NO_FILES = "Files on the user's Mac are not reachable from here: call it again without any file path (screenshots and snapshots come back in the reply).";

/** Chrome's own profile directory, where a Chrome open for remote debugging writes DevToolsActivePort. */
export function defaultUserDataDir() {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

/** The reason a tools/call may not go through, or null. */
export function refused(msg) {
  if (msg?.method !== "tools/call") return null;
  const name = msg.params?.name;
  if (!ALLOWED_TOOLS.has(name)) return `tool ${name} is not available in the user's browser`;
  const args = msg.params?.arguments ?? {};
  if (Object.keys(args).some((k) => PATH_ARG.test(k))) return NO_FILES;
  if ((name === "new_page" || (name === "navigate_page" && (args.type ?? "url") === "url")) && !PAGE_URL.test(String(args.url ?? ""))) {
    return "Only http(s) pages (or about:blank) can be opened in the user's browser.";
  }
  return null;
}

/** The offered tools, without the arguments that name files on this Mac. */
export function filterTools(tools) {
  return tools.filter((t) => ALLOWED_TOOLS.has(t?.name)).map((t) => {
    const schema = t.inputSchema ?? {};
    const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !PATH_ARG.test(k)));
    const required = (schema.required ?? []).filter((k) => !PATH_ARG.test(k));
    return { ...t, inputSchema: { ...schema, properties, ...(schema.required ? { required } : {}) } };
  });
}

/** Whether a Chrome open for remote debugging answers on the port its profile names. */
export async function chromeReady(userDataDir) {
  let port;
  try {
    port = Number(fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
  } catch {
    return false;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const textOf = (result) => (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const toolError = (id, text) => reply(id, { content: [{ type: "text", text }], isError: true });

/**
 * @param {object} opts
 * @param {string} opts.entry        chrome-devtools-mcp's bin script
 * @param {string} [opts.userDataDir] the Chrome profile to attach to (Chrome's own by default)
 * @param {(msg: string, extra?: object) => void} opts.log
 * @param {{ connect?: number, stillWaiting?: number }} [opts.waitMs]  shorter waits for tests
 */
export function createUserBrowser({ entry, userDataDir = defaultUserDataDir(), log, waitMs = {} }) {
  const connectMs = waitMs.connect ?? CONNECT_TIMEOUT_MS;
  const stillWaitingMs = waitMs.stillWaiting ?? STILL_WAITING_MS;
  /** @type {null | {proc: import("node:child_process").ChildProcess, init: Promise<object>, pending: Map<number, (m: object) => void>, reached: boolean}} */
  let child = null;
  let next = 1;
  let closed = false;

  function start() {
    // --experimentalVision adds click_at, which only the person's live view uses. No --screenshotMaxWidth/Height:
    // a downscaled capture is a clipped one beyond the viewport, which makes the user's Chrome window flash on every picture.
    const proc = spawn(process.execPath, [entry, "--autoConnect", "--userDataDir", userDataDir, "--performanceCrux=false", "--experimentalVision"], {
      env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map();
    const self = { proc, pending, reached: false, asked: false, init: null };
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) return write(self, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    });
    proc.stdin.on("error", () => undefined);
    proc.on("exit", (code, signal) => {
      if (child === self) child = null;
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

  async function ready() {
    child ??= start();
    const self = child;
    return { self, init: await self.init };
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
    if (!(await chromeReady(userDataDir))) return toolError(id, UNAVAILABLE);
    const { self } = await ready();
    const answer = await call(self, "tools/call", params, self.reached ? CALL_TIMEOUT_MS : self.asked ? stillWaitingMs : connectMs);
    if (answer.timeout) {
      // The connection stays pending in Chrome's prompt: a later Allow still counts, and no new prompt is raised per task.
      if (!self.reached) { self.asked = true; return toolError(id, NOT_ALLOWED); }
      return toolError(id, "The user's browser did not answer in time; read the page again before retrying.");
    }
    if (answer.result && !answer.result.isError) self.reached = true;
    // Chrome went away while the prompt was up (the call failed): the next connection asks again in full.
    else self.asked = false;
    return answer.result ? reply(id, answer.result) : toolError(id, answer.error?.message ?? "the browser tools failed");
  }

  /** A tool for the person's console (not offered to the agent): its result, or an Error. */
  async function personTool(name, args, timeoutMs = 20_000) {
    if (!(await chromeReady(userDataDir))) throw new Error("Chrome on this Mac is not available");
    const { self } = await ready();
    const answer = await call(self, "tools/call", { name, arguments: args }, self.reached ? timeoutMs : stillWaitingMs);
    if (answer.timeout) throw new Error("Chrome did not answer");
    if (!answer.result || answer.result.isError) throw new Error(textOf(answer.result) || answer.error?.message || `${name} failed`);
    self.reached = true;
    return answer.result;
  }

  async function screenshot(pageId) {
    const result = await personTool("take_screenshot", { pageId, format: "jpeg", quality: 50 });
    const image = result.content?.find((c) => c.type === "image");
    if (!image) throw new Error("no picture of the page");
    return { type: image.mimeType ?? "image/jpeg", body: Buffer.from(image.data, "base64") };
  }

  /** The page's viewport in CSS pixels: where the live view's fractions land. */
  async function viewport(pageId) {
    const found = /\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(textOf(await personTool("evaluate_script", { pageId, function: "() => [innerWidth, innerHeight]" })));
    if (!found) throw new Error("the page did not report its size");
    return { width: Number(found[1]), height: Number(found[2]) };
  }

  /** One input from the live view; positions are fractions of the viewport. */
  async function input(pageId, msg, size) {
    const at = (v, n) => Math.round(clamp(v, 0, 1) * n);
    if (msg.t === "click") return personTool("click_at", { pageId, x: at(msg.x, size.width), y: at(msg.y, size.height) });
    if (msg.t === "scroll") {
      // The scrollable box under the pointer (or the page): wheel scrolling as the person expects.
      const x = at(msg.x, size.width), y = at(msg.y, size.height), dy = Math.round(clamp(msg.dy, -5000, 5000));
      return personTool("evaluate_script", { pageId, function: `() => { let el = document.elementFromPoint(${x}, ${y}); while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY))) el = el.parentElement; (el ?? document.scrollingElement ?? document.documentElement).scrollBy(0, ${dy}); }` });
    }
    if (msg.t === "text" && typeof msg.s === "string" && msg.s) return personTool("type_text", { pageId, text: msg.s.slice(0, 2000) });
    if (msg.t === "key" && KEYS.has(msg.k)) return personTool("press_key", { pageId, key: msg.k });
    if (msg.t === "nav" && ["back", "forward", "reload"].includes(msg.to)) return personTool("navigate_page", { pageId, type: msg.to });
    return null;
  }

  /**
   * The live view of one page on a WebSocket: binary frames are JPEG pictures,
   * text frames `{type:"size"}` / `{type:"error"}`; what comes back is input.
   */
  function stream(ws, pageId) {
    let open = true;
    let size = null;
    let sizeAt = 0;
    let wake = null;
    const say = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    ws.on("close", () => { open = false; wake?.(); });
    ws.on("error", () => ws.terminate());
    ws.on("message", async (data, binary) => {
      if (binary) return;
      let msg;
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
      try {
        size ??= await viewport(pageId);
        await input(pageId, msg, size);
      } catch (err) {
        say({ type: "error", message: err.message });
      }
      wake?.();
    });
    void (async () => {
      while (open) {
        const started = Date.now();
        try {
          if (!size || started - sizeAt > 5000) {
            size = await viewport(pageId);
            sizeAt = started;
            say({ type: "size", ...size });
          }
          const shot = await screenshot(pageId);
          // A slow viewer skips frames instead of piling them up.
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(shot.body, { binary: true });
        } catch (err) {
          say({ type: "error", message: err.message });
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!open) break;
        await new Promise((r) => { wake = r; setTimeout(r, Math.max(0, FRAME_MS - (Date.now() - started))); });
        wake = null;
      }
    })();
  }

  return {
    handle,
    screenshot,
    /** Bring a task's page to the front of the user's Chrome window (the person takes it over). */
    async front(pageId) {
      await personTool("select_page", { pageId, bringToFront: true });
    },
    stream,
    /** Whether the user's Chrome can be used now (open for remote debugging). */
    async status() {
      return { available: await chromeReady(userDataDir), connected: Boolean(child?.reached) };
    },
    close() {
      closed = true;
      if (child) stop(child);
    },
  };
}
