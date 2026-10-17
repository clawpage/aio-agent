#!/usr/bin/env node
/**
 * Phone bridge: the Android phone plugged into a Mac over USB, run by the Mac
 * app (src/ui/tauri, phone_link.rs) for the account that linked that Mac. It
 * listens on loopback (PA_PHONE_BRIDGE_PORT, any free port by default) and every
 * request needs the token the app gives it (PHONE_BRIDGE_TOKEN); the control
 * plane reaches it only through the socket it dials (see below).
 *
 *   POST /mcp     mobile-mcp (Streamable HTTP), limited to the tools that act on
 *                 the phone itself: nothing that reads or writes files on this
 *                 machine, installs from it, or reaches mobile-mcp's device cloud
 *   GET  /status  the connected phone, if any
 *   GET  /screenshot  the screen now (JPEG where macOS sips can shrink it, else PNG)
 *   WS   /screen  the live screen (scrcpy, H.264) and touch / key input
 *   POST /browser/mcp     the user's own Chrome on this Mac (user-browser.mjs)
 *   GET  /browser/status  whether that Chrome can be used now
 *   GET  /browser/screenshot?page=<id>  a picture of one page, for the person
 *   POST /browser/front?page=<id>       bring that page to the front (the person takes it over)
 *   WS   /browser/screen?page=<id>      that page live, with the person's clicks, scrolling and typing
 *
 * PA_PHONE_SCREEN_OFF=1 keeps the phone's own screen dark while all of the above
 * still sees it (see keepDark).
 *
 * The bridge dials the control plane with PA_DEVICE_LINK_URL /
 * PA_DEVICE_LINK_TOKEN, so the account that linked this Mac reaches it without
 * any inbound port (bin/device-link-client.mjs).
 *
 *   node bin/phone-bridge.mjs setup-screen
 *     the pinned scrcpy server (the Mac app installs mobile-mcp from its lockfile)
 *   node bin/phone-bridge.mjs devicekit
 *     installs mobile-mcp's helper app on the connected phone (needed to type
 *     Chinese and other non-ASCII text)
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { linkDevice } from "./device-link-client.mjs";
import { createUserBrowser } from "./user-browser.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = process.env.PA_PHONE_DIR ?? path.join(ROOT, "var", "phone");
const PORT = Number(process.env.PA_PHONE_BRIDGE_PORT ?? 0);
const BIND = process.env.PA_PHONE_BRIDGE_BIND ?? "127.0.0.1";
const TOKEN_KEY = "PHONE_BRIDGE_TOKEN";

const MOBILE_MCP_DIR = path.join(DIR, "mobile-mcp");
const MOBILE_MCP_ENTRY = path.join(MOBILE_MCP_DIR, "node_modules", "@mobilenext", "mobile-mcp", "lib", "index.js");
const BROWSER_MCP_ENTRY = path.join(MOBILE_MCP_DIR, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js");
const SCRCPY_VERSION = "4.1";
const SCRCPY_SERVER = path.join(DIR, `scrcpy-server-v${SCRCPY_VERSION}`);
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
const SCRCPY_SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";
const DEVICEKIT_URL = "https://github.com/mobile-next/devicekit-android/releases/download/1.2.6/devicekit.apk";
const DEVICEKIT_SHA256 = "01d933a311dac113bb89f2cb3256482467c1e02b287a2fd5e412863b8f907c51";
const DEVICE_JAR = "/data/local/tmp/aio-scrcpy-server.jar";

/** The mobile-mcp tools offered: they act on the phone and touch nothing on this machine. */
const ALLOWED_TOOLS = new Set([
  "mobile_list_available_devices",
  "mobile_list_apps",
  "mobile_get_foreground_app",
  "mobile_launch_app",
  "mobile_terminate_app",
  "mobile_get_screen_size",
  "mobile_click_on_screen_at_coordinates",
  "mobile_double_tap_on_screen",
  "mobile_long_press_on_screen_at_coordinates",
  "mobile_list_elements_on_screen",
  "mobile_press_button",
  "mobile_open_url",
  "mobile_swipe_on_screen",
  "mobile_type_keys",
  "mobile_take_screenshot",
  "mobile_set_orientation",
  "mobile_get_orientation",
  "mobile_clipboard",
  "mobile_batch_commands",
]);

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: "phone-bridge", msg, ...extra }) + "\n");
}

function adbPath() {
  if (process.env.PA_ADB) return process.env.PA_ADB;
  for (const home of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), "Library", "Android", "sdk")]) {
    if (home && fs.existsSync(path.join(home, "platform-tools", "adb"))) return path.join(home, "platform-tools", "adb");
  }
  return "adb";
}
const ADB = adbPath();

function readToken() {
  return process.env[TOKEN_KEY]?.trim() || null;
}

async function download(url, file, sha256) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
  fs.writeFileSync(file, body);
}

async function setupScreen() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(SCRCPY_SERVER)) {
    console.log(`downloading scrcpy server v${SCRCPY_VERSION}`);
    await download(SCRCPY_URL, SCRCPY_SERVER, SCRCPY_SHA256);
  }
}

async function installDevicekit() {
  fs.mkdirSync(DIR, { recursive: true });
  const apk = path.join(DIR, "devicekit.apk");
  await download(DEVICEKIT_URL, apk, DEVICEKIT_SHA256);
  const serial = await phoneSerial();
  if (!serial) throw new Error("no phone connected (adb devices)");
  console.log(`installing devicekit on ${serial}`);
  await run(ADB, ["-s", serial, "install", "-r", apk]);
}

// ------------------------------------------------------------------ device

/** The phone to use: PA_PHONE_SERIAL, or the only USB-attached device that is ready. */
async function phoneSerial() {
  const { stdout } = await run(ADB, ["devices", "-l"], { timeout: 10_000 });
  const ready = stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device");
  if (process.env.PA_PHONE_SERIAL) return ready.some((p) => p[0] === process.env.PA_PHONE_SERIAL) ? process.env.PA_PHONE_SERIAL : null;
  return ready[0]?.[0] ?? null;
}

/** The name the phone shows for itself (Settings → About), e.g. "Galaxy Z Flip6"; empty if unset. */
async function deviceName(serial) {
  const { stdout } = await run(ADB, ["-s", serial, "shell", "settings", "get", "global", "device_name"], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
  const name = stdout.trim();
  return name === "null" ? "" : name;
}

async function phoneInfo() {
  const serial = await phoneSerial();
  if (!serial) return null;
  const prop = async (name) => (await run(ADB, ["-s", serial, "shell", "getprop", name], { timeout: 10_000 })).stdout.trim();
  const [model, name, release] = await Promise.all([prop("ro.product.model"), deviceName(serial), prop("ro.build.version.release")]);
  return { serial, model, name: name || model, android: release };
}

/** The screen now, small enough for a task card: sips (macOS) makes a JPEG, elsewhere the PNG as is. */
async function screenshot() {
  const serial = await phoneSerial();
  if (!serial) return null;
  // A foldable has two screens: capture the first one that is on (as mobile-mcp does), or screencap warns into the PNG.
  const { stdout: displays } = await run(ADB, ["-s", serial, "shell", "cmd", "display", "get-displays"], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
  const on = displays.split("\n").find((l) => l.startsWith("Display id ") && l.includes(", state ON,"));
  const display = on && /uniqueId "(?:local:)?([^"]+)"/.exec(on)?.[1];
  const { stdout: raw } = await run(ADB, ["-s", serial, "exec-out", "screencap", "-p", ...(display ? ["-d", display] : [])], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
  const start = raw.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (start < 0) throw new Error("screencap returned no image");
  const png = raw.subarray(start);
  if (!fs.existsSync("/usr/bin/sips")) return { type: "image/png", body: png };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-phone-"));
  try {
    fs.writeFileSync(path.join(dir, "s.png"), png);
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "900", path.join(dir, "s.png"), "--out", path.join(dir, "s.jpg")], { timeout: 15_000 });
    return { type: "image/jpeg", body: fs.readFileSync(path.join(dir, "s.jpg")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ mobile-mcp

const internalAuth = randomBytes(24).toString("hex");
let mcpPort = 0;
let mcpChild = null;

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startMobileMcp() {
  if (shuttingDown) return;
  mcpPort = await freePort();
  mcpChild = spawn(process.execPath, [MOBILE_MCP_ENTRY, "--listen", `127.0.0.1:${mcpPort}`], {
    env: {
      ...process.env,
      MOBILEMCP_AUTH: internalAuth,
      MOBILEMCP_DISABLE_TELEMETRY: "1",
      PATH: `${path.dirname(ADB)}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  mcpChild.on("exit", (code, signal) => {
    mcpChild = null;
    if (shuttingDown) return;
    log("mobile-mcp exited; restarting in 3s", { code, signal });
    setTimeout(() => void startMobileMcp(), 3000);
  });
  log("mobile-mcp started", { pid: mcpChild.pid, port: mcpPort });
}

function rpcError(id, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message } };
}

/** The reason a JSON-RPC message may not go through, or null. */
function refused(msg) {
  if (msg?.method !== "tools/call") return null;
  const name = msg.params?.name;
  if (!ALLOWED_TOOLS.has(name)) return `tool ${name} is not available`;
  if (name === "mobile_batch_commands") {
    const steps = Array.isArray(msg.params?.arguments?.steps) ? msg.params.arguments.steps : [];
    const bad = steps.find((s) => !ALLOWED_TOOLS.has(s?.name) || s?.name === "mobile_batch_commands");
    if (bad) return `tool ${bad?.name} is not available`;
  }
  return null;
}

/** Drop the tools that are not offered from a tools/list result. */
function filterResult(msg) {
  if (Array.isArray(msg?.result?.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => ALLOWED_TOOLS.has(t.name));
    for (const tool of msg.result.tools) {
      if (tool.name === "mobile_batch_commands" && typeof tool.description === "string") {
        tool.description = tool.description.replace(/Tools allowed as steps: .*$/s, `Tools allowed as steps: ${[...ALLOWED_TOOLS].filter((n) => n !== "mobile_batch_commands" && n !== "mobile_take_screenshot").join(", ")}.`);
      }
    }
  }
  return msg;
}

async function handleMcp(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return sendJson(res, 400, rpcError(null, "invalid JSON")); }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const msg of messages) {
    const why = refused(msg);
    if (why) return sendJson(res, 200, rpcError(msg.id, why));
  }
  if (!mcpChild) return sendJson(res, 502, { error: "mobile-mcp unavailable" });
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${internalAuth}`,
  };
  for (const name of ["mcp-session-id", "mcp-protocol-version"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
  const upstream = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
  const type = upstream.headers.get("content-type") ?? "application/json";
  const text = await upstream.text();
  let out = text;
  if (type.includes("text/event-stream")) {
    out = text.split("\n").map((line) => {
      if (!line.startsWith("data:")) return line;
      try { return `data: ${JSON.stringify(filterResult(JSON.parse(line.slice(5))))}`; } catch { return line; }
    }).join("\n");
  } else if (type.includes("json") && text) {
    try { out = JSON.stringify(filterResult(JSON.parse(text))); } catch { /* pass through */ }
  }
  const session = upstream.headers.get("mcp-session-id");
  res.writeHead(upstream.status, { "content-type": type, "cache-control": "no-store", ...(session ? { "mcp-session-id": session } : {}) });
  res.end(out);
}

// ------------------------------------------------------------------ screen (scrcpy)

/** Android key codes the viewer may send. */
const KEYS = { back: 4, home: 3, recents: 187, power: 26, volup: 24, voldown: 25 };
const ACTIONS = { down: 0, up: 1, move: 2, cancel: 3 };

/** A byte reader over a socket: `await read(n)` resolves with exactly n bytes. */
function reader(socket) {
  let buf = Buffer.alloc(0);
  let want = null;
  let ended = null;
  socket.on("data", (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; pump(); });
  const fail = (err) => { ended = err ?? new Error("closed"); pump(); };
  socket.on("end", () => fail());
  socket.on("close", () => fail());
  socket.on("error", (err) => fail(err));
  function pump() {
    if (!want) return;
    if (buf.length >= want.n) {
      const out = buf.subarray(0, want.n);
      buf = buf.subarray(want.n);
      const w = want; want = null; w.resolve(out);
    } else if (ended) {
      const w = want; want = null; w.reject(ended);
    }
  }
  return (n) => new Promise((resolve, reject) => { want = { n, resolve, reject }; pump(); });
}

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

const DARK_JAR = "/data/local/tmp/aio-scrcpy-dark.jar";
const DARK_IDLE_MS = 120_000;

/**
 * Switch the phone's panels off while it stays awake (scrcpy's "turn screen off"):
 * the system keeps drawing, so screenshots, mobile-mcp and the live screen still
 * see everything. A short control-only scrcpy session sends the one message and
 * ends without cleanup, so the panels stay off until the phone is next woken
 * (its own jar: a live-screen session that ends deletes its own).
 */
async function darken(serial) {
  await run(ADB, ["-s", serial, "push", SCRCPY_SERVER, DARK_JAR], { timeout: 30_000 });
  const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
  const { stdout } = await run(ADB, ["-s", serial, "forward", "tcp:0", `localabstract:scrcpy_${scid}`], { timeout: 10_000 });
  const port = Number(stdout.trim());
  const proc = spawn(ADB, ["-s", serial, "shell", `CLASSPATH=${DARK_JAR}`, "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION,
    `scid=${scid}`, "log_level=info", "tunnel_forward=true", "video=false", "audio=false", "control=true", "send_device_meta=false",
    "clipboard_autosync=false", "power_on=false", "cleanup=false"], { stdio: ["ignore", "pipe", "pipe"] });
  const off = new Promise((resolve) => proc.stdout.on("data", (d) => { if (/display turned off/i.test(d.toString())) resolve(true); }));
  let control;
  try {
    for (let attempt = 0; ; attempt++) {
      if (proc.exitCode !== null) throw new Error("scrcpy server exited");
      try {
        control = await connectOnce(port);
        await reader(control)(1);
        break;
      } catch {
        control?.destroy();
        if (attempt > 50) throw new Error("scrcpy server did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    control.write(Buffer.from([10, 0])); // SET_DISPLAY_POWER off
    if (!(await Promise.race([off, new Promise((r) => setTimeout(() => r(false), 5000))]))) throw new Error("display did not turn off");
  } finally {
    control?.destroy();
    proc.kill("SIGTERM");
    await run(ADB, ["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => undefined);
  }
}

/**
 * PA_PHONE_SCREEN_OFF=1: keep the phone's screen dark. It is darkened at start and again
 * after two quiet minutes once someone has woken it (power button) and used it; a phone
 * put to sleep is left asleep.
 */
function keepDark() {
  let activity = null;
  let quietSince = 0;
  let darkened = null;
  let busy = false;
  const tick = async () => {
    if (busy || shuttingDown) return;
    busy = true;
    try {
      const serial = await phoneSerial();
      if (!serial) return;
      const { stdout } = await run(ADB, ["-s", serial, "shell", "dumpsys power | grep -E 'mWakefulness=|mLastUserActivityTime='"], { timeout: 10_000 });
      const seen = `${serial}:${/mLastUserActivityTime=(\d+)/.exec(stdout)?.[1] ?? ""}`;
      if (activity !== null && seen !== activity) quietSince = Date.now();
      activity = seen;
      if (!/mWakefulness=Awake/.test(stdout) || darkened === activity || Date.now() - quietSince < DARK_IDLE_MS) return;
      await darken(serial);
      darkened = activity;
      log("phone screen darkened", { serial });
    } catch (err) {
      log("darkening the phone screen failed", { error: err.message });
    } finally {
      busy = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), 20_000);
}

/**
 * One scrcpy session shared by every viewer: started for the first viewer and
 * stopped a little after the last one leaves, so an unwatched phone does no
 * encoding.
 */
class Screen {
  viewers = new Set();
  /** @type {null | {serial:string, proc:import("node:child_process").ChildProcess, video:net.Socket, control:net.Socket, port:number}} */
  session = null;
  starting = null;
  stopTimer = null;
  name = "";
  size = null;
  config = null;

  async join(ws) {
    clearTimeout(this.stopTimer);
    this.viewers.add(ws);
    ws.needKey = true;
    ws.on("close", () => this.leave(ws));
    ws.on("message", (data, binary) => { if (!binary) this.input(data.toString("utf8")); });
    try {
      if (!this.session) await (this.starting ??= this.start().finally(() => { this.starting = null; }));
    } catch (err) {
      log("screen start failed", { error: err.message });
      this.send(ws, { type: "error", message: err.message });
      ws.close(1011, "start failed");
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    this.send(ws, { type: "device", name: this.name });
    if (this.size) this.send(ws, { type: "session", ...this.size });
    if (this.config) ws.send(this.config);
    // A new decoder needs a key frame: ask the encoder for one now.
    this.control(Buffer.from([17]));
  }

  leave(ws) {
    this.viewers.delete(ws);
    if (this.viewers.size === 0) {
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => this.stop("no viewers"), 15_000);
    }
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    for (const ws of this.viewers) this.send(ws, obj);
  }

  async start() {
    const serial = await phoneSerial();
    if (!serial) throw new Error("没有连接手机（请用 USB 连接并允许调试）");
    if (!fs.existsSync(SCRCPY_SERVER)) throw new Error("scrcpy server missing; reinstall the phone runtime (Mac app)");
    await run(ADB, ["-s", serial, "push", SCRCPY_SERVER, DEVICE_JAR], { timeout: 30_000 });
    const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
    const { stdout } = await run(ADB, ["-s", serial, "forward", "tcp:0", `localabstract:scrcpy_${scid}`], { timeout: 10_000 });
    const port = Number(stdout.trim());
    const proc = spawn(ADB, ["-s", serial, "shell", `CLASSPATH=${DEVICE_JAR}`, "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION,
      `scid=${scid}`, "log_level=info", "tunnel_forward=true", "audio=false", "control=true", "video_codec=h264",
      "max_size=1600", "max_fps=30", "video_bit_rate=6000000", "clipboard_autosync=false", "power_off_on_close=false", "cleanup=true"], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => log("scrcpy", { out: d.toString().trim() }));
    proc.stderr.on("data", (d) => log("scrcpy", { err: d.toString().trim() }));
    const cleanup = () => { proc.kill("SIGTERM"); void run(ADB, ["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => undefined); };
    try {
      // With a forward tunnel adb accepts before the server listens: only the dummy byte proves it.
      let video, read;
      for (let attempt = 0; ; attempt++) {
        if (proc.exitCode !== null) throw new Error("scrcpy server exited");
        try {
          video = await connectOnce(port);
          read = reader(video);
          await read(1);
          break;
        } catch {
          video?.destroy();
          if (attempt > 50) throw new Error("scrcpy server did not start");
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const control = await connectOnce(port);
      control.on("data", () => undefined); // device messages (clipboard acks) are not used
      control.on("error", () => undefined);
      const model = (await read(64)).toString("utf8").replace(/\0.*$/s, "");
      this.name = (await deviceName(serial)) || model;
      const codec = (await read(4)).readUInt32BE(0);
      if (codec !== 0x68323634) throw new Error(`unexpected video codec ${codec.toString(16)}`);
      this.session = { serial, proc, video, control, port };
      proc.on("exit", () => this.stop("server exited"));
      video.on("close", () => this.stop("video closed"));
      log("screen started", { serial, name: this.name });
      void this.pump(read);
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  async pump(read) {
    try {
      for (;;) {
        const head = await read(12);
        if (head[0] & 0x80) {
          this.size = { width: head.readUInt32BE(4), height: head.readUInt32BE(8) };
          this.config = null;
          this.broadcast({ type: "session", ...this.size });
          continue;
        }
        const ptsFlags = head.readBigUInt64BE(0);
        const data = await read(head.readUInt32BE(8));
        const config = (ptsFlags & (1n << 62n)) !== 0n;
        const key = (ptsFlags & (1n << 61n)) !== 0n;
        // Binary frame to the viewer: [flags][pts u64][payload]; flags 1 = config, 2 = key frame.
        const frame = Buffer.alloc(9 + data.length);
        frame[0] = (config ? 1 : 0) | (key ? 2 : 0);
        frame.writeBigUInt64BE(config ? 0n : ptsFlags & ((1n << 61n) - 1n), 1);
        data.copy(frame, 9);
        if (config) this.config = frame;
        for (const ws of this.viewers) {
          if (ws.readyState !== ws.OPEN) continue;
          if (config) { ws.send(frame); continue; }
          // A slow viewer skips ahead to the next key frame instead of queueing video.
          if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.needKey = true; continue; }
          if (ws.needKey && !key) continue;
          ws.needKey = false;
          ws.send(frame);
        }
      }
    } catch {
      this.stop("stream ended");
    }
  }

  control(buf) {
    const s = this.session;
    if (s && !s.control.destroyed) s.control.write(buf);
  }

  /** A viewer's input, in screen fractions so it survives rotation and scaling. */
  input(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!this.session || !this.size) return;
    const { width, height } = this.size;
    const pos = (buf, at, x, y) => {
      buf.writeInt32BE(Math.round(Math.min(1, Math.max(0, Number(x) || 0)) * width), at);
      buf.writeInt32BE(Math.round(Math.min(1, Math.max(0, Number(y) || 0)) * height), at + 4);
      buf.writeUInt16BE(width, at + 8);
      buf.writeUInt16BE(height, at + 10);
    };
    if (msg.t === "touch" && msg.a in ACTIONS) {
      const buf = Buffer.alloc(32);
      buf[0] = 2;
      buf[1] = ACTIONS[msg.a];
      buf.writeBigUInt64BE(BigInt(Math.abs(Math.trunc(Number(msg.id) || 0)) % 10), 2);
      pos(buf, 10, msg.x, msg.y);
      buf.writeUInt16BE(msg.a === "up" ? 0 : 0xffff, 22);
      this.control(buf);
    } else if (msg.t === "scroll") {
      const buf = Buffer.alloc(21);
      buf[0] = 3;
      pos(buf, 1, msg.x, msg.y);
      const fp = (v) => Math.round(Math.min(1, Math.max(-1, (Number(v) || 0) / 16)) * 0x7fff);
      buf.writeInt16BE(fp(msg.dx), 13);
      buf.writeInt16BE(fp(msg.dy), 15);
      this.control(buf);
    } else if (msg.t === "reset") {
      // The viewer's decoder lost its place: ask for a fresh key frame.
      this.control(Buffer.from([17]));
    } else if (msg.t === "key" && msg.k in KEYS) {
      for (const action of [0, 1]) {
        const buf = Buffer.alloc(14);
        buf[0] = 0;
        buf[1] = action;
        buf.writeInt32BE(KEYS[msg.k], 2);
        this.control(buf);
      }
    } else if (msg.t === "text" && typeof msg.s === "string" && msg.s.length > 0) {
      // Through the clipboard with paste, so Chinese and emoji arrive as typed.
      const text = Buffer.from(msg.s.slice(0, 2000), "utf8");
      const buf = Buffer.alloc(14 + text.length);
      buf[0] = 9;
      buf.writeBigUInt64BE(0n, 1);
      buf[9] = 1;
      buf.writeUInt32BE(text.length, 10);
      text.copy(buf, 14);
      this.control(buf);
    }
  }

  stop(why) {
    clearTimeout(this.stopTimer);
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.size = null;
    this.config = null;
    s.video.destroy();
    s.control.destroy();
    s.proc.kill("SIGTERM");
    void run(ADB, ["-s", s.serial, "forward", "--remove", `tcp:${s.port}`]).catch(() => undefined);
    log("screen stopped", { why });
    for (const ws of this.viewers) ws.close(1011, "screen stopped");
  }
}

// ------------------------------------------------------------------ server

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req, token) {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

let shuttingDown = false;

async function serve() {
  const token = readToken();
  if (!token) { log(`fatal: ${TOKEN_KEY} missing; reinstall the phone runtime (Mac app)`); process.exit(1); }
  if (!fs.existsSync(MOBILE_MCP_ENTRY)) { log("fatal: mobile-mcp missing; reinstall the phone runtime (Mac app)"); process.exit(1); }
  await startMobileMcp();
  const dark = process.env.PA_PHONE_SCREEN_OFF === "1" ? keepDark() : null;
  const screen = new Screen();
  // An older phone runtime has no browser tools: the browser then answers unavailable, the phone works on.
  const browser = fs.existsSync(BROWSER_MCP_ENTRY)
    ? createUserBrowser({ entry: BROWSER_MCP_ENTRY, ...(process.env.PA_BROWSER_USER_DATA_DIR ? { userDataDir: process.env.PA_BROWSER_USER_DATA_DIR } : {}), log })
    : null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req, token)) return sendJson(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://bridge");
      if (url.pathname === "/status" && req.method === "GET") {
        return sendJson(res, 200, { device: await phoneInfo().catch(() => null), viewers: screen.viewers.size, streaming: Boolean(screen.session) });
      }
      if (url.pathname === "/screenshot" && req.method === "GET") {
        const shot = await screenshot();
        if (!shot) return sendJson(res, 404, { error: "no phone" });
        res.writeHead(200, { "content-type": shot.type, "cache-control": "no-store" });
        return res.end(shot.body);
      }
      if (url.pathname === "/browser/status" && req.method === "GET") {
        return sendJson(res, 200, browser ? await browser.status() : { available: false, connected: false });
      }
      const page = Number(url.searchParams.get("page"));
      if ((url.pathname === "/browser/screenshot" || url.pathname === "/browser/front") && browser && Number.isInteger(page) && page > 0) {
        try {
          if (url.pathname === "/browser/front") {
            if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
            await browser.front(page);
            return sendJson(res, 200, { ok: true });
          }
          const shot = await browser.screenshot(page);
          res.writeHead(200, { "content-type": shot.type, "cache-control": "no-store" });
          return res.end(shot.body);
        } catch (err) {
          return sendJson(res, 404, { error: err.message });
        }
      }
      if (url.pathname === "/mcp" || url.pathname === "/browser/mcp") {
        if (req.method === "DELETE") return sendJson(res, 200, {});
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) return sendJson(res, 413, { error: "too large" });
          chunks.push(chunk);
        }
        if (url.pathname === "/mcp") return await handleMcp(req, res, Buffer.concat(chunks));
        if (!browser) return sendJson(res, 503, { error: "browser tools missing; reinstall the phone runtime (Mac app)" });
        let msg;
        try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return sendJson(res, 400, rpcError(null, "invalid JSON")); }
        const answer = await browser.handle(msg);
        if (answer === null) { res.writeHead(202, { "cache-control": "no-store" }); return res.end(); }
        return sendJson(res, 200, answer);
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      log("request failed", { url: req.url, error: err.message });
      if (!res.headersSent) sendJson(res, 502, { error: "phone unavailable" });
      else res.destroy();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    const page = Number(url.searchParams.get("page"));
    const browserScreen = url.pathname === "/browser/screen" && browser && Number.isInteger(page) && page > 0;
    if ((url.pathname !== "/screen" && !browserScreen) || !authorized(req, token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => (browserScreen ? browser.stream(ws, page) : void screen.join(ws)));
  });
  let link = null;
  server.listen(PORT, BIND, () => {
    const port = server.address().port;
    log("listening", { bind: BIND, port, adb: ADB });
    // In the Mac app: dial the control plane, which then reaches this bridge for its account (device-link-client.mjs).
    if (process.env.PA_DEVICE_LINK_URL && process.env.PA_DEVICE_LINK_TOKEN) {
      link = linkDevice({
        url: process.env.PA_DEVICE_LINK_URL,
        token: process.env.PA_DEVICE_LINK_TOKEN,
        name: process.env.PA_DEVICE_NAME || os.hostname(),
        local: `http://127.0.0.1:${port}`,
        localToken: token,
        onState: (state) => {
          log("link", { state });
          // The link was removed: nothing will reach this bridge again, and the app forgets the token when it ends.
          if (state === "revoked") shutdown();
        },
      });
    }
  });
  const shutdown = () => {
    shuttingDown = true;
    link?.close();
    clearInterval(dark);
    screen.stop("shutdown");
    browser?.close();
    mcpChild?.kill("SIGTERM");
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // However the bridge ends (its port taken, a crash), mobile-mcp and the browser tools go with it instead of piling up orphaned.
  process.on("exit", () => { mcpChild?.kill("SIGTERM"); browser?.close(); });
}

if (process.argv[2] === "devicekit") {
  installDevicekit().catch((err) => { console.error(err.message); process.exit(1); });
} else if (process.argv[2] === "setup-screen") {
  // The Mac app installs mobile-mcp from its own lockfile; only the scrcpy server comes from here.
  setupScreen().catch((err) => { console.error(err.message); process.exit(1); });
} else {
  void serve();
}
