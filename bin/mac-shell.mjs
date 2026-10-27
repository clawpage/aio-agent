/**
 * A terminal on this Mac for the account that linked it, offered by the Mac
 * app's bridge (phone-bridge.mjs serves it as POST /shell/mcp and GET
 * /shell/status) only once the person at this Mac turned it on in the app
 * (PA_MAC_SHELL=1). Four tools, the way pi has them: read, write and edit a
 * file, and run a bash command.
 *
 * Commands run in bash inside tmux, on a tmux server of its own (socket
 * `aio-agent`, no tmux.conf), one session per task: a task's `cd` and exported
 * variables carry over from one call to the next, a session nobody used for
 * six hours goes away, and the person can watch with
 * `tmux -L aio-agent attach`. The shell gets a clean environment (none of the
 * bridge's tokens), Homebrew on its PATH and no profile of the user's.
 *
 * Each call is one JSON-RPC request from the gateway (src/control/macShell.ts,
 * which also answers the handshake and the tool list); the task's session is
 * named by the X-AIO-Shell-Session header.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SOCKET = "aio-agent";
export const TOOL_NAMES = ["read", "write", "edit", "bash"];
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_TEXT_FILE = 50 * 1024 * 1024;
export const DEFAULT_TIMEOUT_S = 120;
// The device link reaches the bridge with fetch, which gives up waiting for an answer after 300 s.
export const MAX_TIMEOUT_S = 240;
const IDLE_MS = 6 * 60 * 60_000;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const IMAGES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** A picture larger than this goes back as a smaller JPEG (macOS sips). */
const IMAGE_MAX_BYTES = 1024 * 1024;

export const OFF =
  "The terminal on the user's Mac is turned off. Ask the user to turn on \"Let the AI use this Mac's terminal\" under Phone in the Mac app (on that Mac) if this task needs their Mac; otherwise do the work in the sandbox.";
const NO_TMUX = "tmux is not installed on the user's Mac, so commands cannot run there (read, write and edit still work). Ask the user to install it (brew install tmux).";

/** Where tmux is: PA_TMUX, else Homebrew's, MacPorts' or one on PATH. */
export function findTmux(env = process.env) {
  if (env.PA_TMUX) return env.PA_TMUX;
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", ...(env.PATH ?? "").split(":")];
  return dirs.filter(Boolean).map((d) => path.join(d, "tmux")).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;
}

/** The shell's environment: who the user is and where things are, nothing of the bridge's own (its tokens). */
export function shellEnv(env = process.env, home = os.homedir()) {
  const out = Object.fromEntries(["USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"].filter((k) => env[k]).map((k) => [k, env[k]]));
  out.HOME = env.HOME || home;
  // launchd starts the app without a locale: without one bash and tmux mangle anything that is not ASCII.
  if (!out.LANG && !out.LC_ALL) out.LANG = "en_US.UTF-8";
  out.PATH = [...new Set(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...(env.PATH ?? "").split(":")].filter(Boolean))].join(":");
  out.TERM = "xterm-256color";
  return out;
}

/** The bash the tmux session runs: a prompt, no pagers, and the runner each call types into it. */
function rcFile(dir) {
  return `[ -x /usr/libexec/path_helper ] && eval "$(/usr/libexec/path_helper -s)"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"
export PAGER=cat GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 BASH_SILENCE_DEPRECATION_WARNING=1
HISTFILE=${JSON.stringify(path.join(dir, "history"))}
PS1='\\w \\$ '
# One call: its command sourced here (so cd and export stay), output to a file, then the exit code.
__aio_run() {
  local __aio_p="$1"
  printf '\\n$ %s\\n' "$(head -n 20 "$__aio_p.cmd")"
  { . "$__aio_p.cmd"; } > "$__aio_p.out" 2>&1 < /dev/null
  printf '%s' "$?" > "$__aio_p.rc.tmp"
  tail -n 50 "$__aio_p.out"
  mv "$__aio_p.rc.tmp" "$__aio_p.rc"
}
`;
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The last lines of an output, within the line and byte limits; whether anything was cut. */
export function tail(out) {
  let lines = out.split("\n");
  const total = lines.length;
  let cut = false;
  if (lines.length > MAX_LINES) { lines = lines.slice(-MAX_LINES); cut = true; }
  let kept = lines.join("\n");
  while (Buffer.byteLength(kept) > MAX_BYTES && lines.length > 1) { lines.shift(); kept = lines.join("\n"); cut = true; }
  if (Buffer.byteLength(kept) > MAX_BYTES) { kept = Buffer.from(kept).subarray(-MAX_BYTES).toString("utf8"); cut = true; }
  return { kept, cut, total, shown: lines.length };
}

/** edits[] applied to a file's text: each oldText found exactly once, none overlapping. */
export function applyEdits(original, edits) {
  const bom = original.startsWith("﻿") ? "﻿" : "";
  const crlf = original.includes("\r\n");
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const body = lf(bom ? original.slice(1) : original);
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits must list at least one { oldText, newText }.");
  const ranges = edits.map((e, i) => {
    if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") throw new Error(`edits[${i}] needs oldText and newText strings.`);
    const old = lf(e.oldText);
    if (!old) throw new Error(`edits[${i}].oldText is empty.`);
    const at = body.indexOf(old);
    if (at < 0) throw new Error(`edits[${i}].oldText was not found. It must match the file exactly, including whitespace and indentation; read the file again.`);
    if (body.indexOf(old, at + 1) >= 0) throw new Error(`edits[${i}].oldText appears more than once; include more surrounding lines so it is unique.`);
    return { at, end: at + old.length, next: lf(e.newText), i };
  }).sort((a, b) => a.at - b.at);
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k].at < ranges[k - 1].end) throw new Error(`edits[${ranges[k - 1].i}] and edits[${ranges[k].i}] overlap; merge them into one edit.`);
  }
  let out = body;
  for (const r of [...ranges].reverse()) out = out.slice(0, r.at) + r.next + out.slice(r.end);
  const lines = ranges.map((r) => body.slice(0, r.at).split("\n").length);
  return { text: bom + (crlf ? out.replace(/\n/g, "\r\n") : out), lines };
}

/**
 * @param {object} opts
 * @param {boolean} opts.enabled  the person at this Mac turned the terminal on
 * @param {string|null} [opts.tmux]  tmux's path (findTmux by default)
 * @param {string} [opts.home]
 * @param {string} [opts.socket]  the tmux server's socket name (tests use their own)
 * @param {string} [opts.stateDir]  where each session keeps its runner, commands and output
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
export function createMacShell({ enabled, tmux = findTmux(), home = os.homedir(), socket = SOCKET, stateDir = path.join(os.tmpdir(), "aio-mac-shell"), log = () => {} }) {
  const env = shellEnv(process.env, home);
  /** session -> its calls in turn, so two calls of one task never type into the shell at once */
  const queues = new Map();
  /** path -> its writes in turn */
  const writes = new Map();
  let seq = 0;

  const tm = async (...args) => (await run(tmux, ["-L", socket, "-f", "/dev/null", ...args], { env, timeout: 15_000 })).stdout;
  const alive = (name) => tm("has-session", "-t", `=${name}`).then(() => true, () => false);
  const dirOf = (name) => path.join(stateDir, name);

  const serial = (map, key, fn) => {
    const prev = map.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    map.set(key, settled);
    void settled.then(() => { if (map.get(key) === settled) map.delete(key); });
    return next;
  };

  /** Where a relative path starts: the task's shell's directory, else home. */
  async function cwdOf(name) {
    if (!tmux || !(await alive(name))) return home;
    const dir = (await tm("display-message", "-p", "-t", `=${name}:`, "#{pane_current_path}").catch(() => "")).trim();
    return dir || home;
  }

  async function resolve(name, p) {
    if (typeof p !== "string" || !p.trim()) throw new Error("path is required.");
    const given = p.trim();
    const expanded = given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(await cwdOf(name), expanded);
  }

  async function start(name) {
    const dir = dirOf(name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "rc"), rcFile(dir), { mode: 0o600 });
    await tm("new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", home, "/bin/bash", "--rcfile", path.join(dir, "rc"), "-i");
    await tm("set-option", "-t", `=${name}`, "history-limit", "10000").catch(() => undefined);
    log("shell session started", { session: name });
  }

  /** The task's shell, ready for a command: started if missing, interrupted (or replaced) if a command is still running. */
  async function ready(name) {
    if (!(await alive(name))) { await start(name); return ""; }
    const busy = async () => (await tm("display-message", "-p", "-t", `=${name}:`, "#{pane_current_command}").catch(() => "bash")).trim() !== "bash";
    if (!(await busy())) return "";
    await tm("send-keys", "-t", `=${name}:`, "C-c").catch(() => undefined);
    await sleep(1000);
    if (!(await busy())) return "[An earlier command was still running in this shell; it was interrupted (Ctrl-C).]\n";
    await tm("kill-session", "-t", `=${name}`).catch(() => undefined);
    await start(name);
    return "[An earlier command was still running and did not stop; the shell was restarted (working directory and variables reset).]\n";
  }

  async function bash(name, args) {
    if (!tmux) return text(NO_TMUX, true);
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return text("command is required.", true);
    const timeoutS = Math.min(Math.max(Number(args.timeout) > 0 ? Number(args.timeout) : DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
    return serial(queues, name, async () => {
      const note = await ready(name);
      const base = path.join(dirOf(name), String(++seq));
      fs.writeFileSync(`${base}.cmd`, command.endsWith("\n") ? command : `${command}\n`, { mode: 0o600 });
      // The leading space keeps the runner out of the shell's history.
      await tm("send-keys", "-t", `=${name}:`, "-l", ` __aio_run ${base}`);
      await tm("send-keys", "-t", `=${name}:`, "Enter");
      const done = () => fs.existsSync(`${base}.rc`);
      const end = Date.now() + timeoutS * 1000;
      let ended = "";
      for (let n = 0; !done(); n++) {
        if (Date.now() > end) {
          await tm("send-keys", "-t", `=${name}:`, "C-c").catch(() => undefined);
          for (let k = 0; k < 30 && !done(); k++) await sleep(100);
          if (done()) ended = `[Timed out after ${timeoutS} s and interrupted (Ctrl-C). Run long jobs in the background (nohup … &) and check on them.]`;
          else {
            await tm("kill-session", "-t", `=${name}`).catch(() => undefined);
            ended = `[Timed out after ${timeoutS} s; it did not stop on Ctrl-C, so the shell was restarted (working directory and variables reset).]`;
          }
          break;
        }
        // The command ended the shell itself (exit): the next call starts a new one.
        if (n % 10 === 9 && !(await alive(name))) { ended = "[The shell exited; the next command starts a new one (working directory and variables reset).]"; break; }
        await sleep(100);
      }
      const out = fs.existsSync(`${base}.out`) ? fs.readFileSync(`${base}.out`, "utf8") : "";
      const code = done() ? Number(fs.readFileSync(`${base}.rc`, "utf8").trim()) : null;
      const { kept, cut, total, shown } = tail(out.replace(/\n+$/, ""));
      for (const ext of [".cmd", ".rc"]) fs.rmSync(`${base}${ext}`, { force: true });
      if (!cut) fs.rmSync(`${base}.out`, { force: true });
      const parts = [note + (kept || "(no output)")];
      if (cut) parts.push(`[Showing the last ${shown} of ${total} lines. Full output: ${base}.out]`);
      if (ended) parts.push(ended);
      else if (code !== 0) parts.push(`Command exited with code ${code}`);
      return text(parts.join("\n\n"), Boolean(ended) || code !== 0);
    });
  }

  async function read(name, args) {
    const file = await resolve(name, args.path);
    const stat = await fs.promises.stat(file);
    if (stat.isDirectory()) return text(`${file} is a directory; list it with bash (ls).`, true);
    const type = IMAGES[path.extname(file).toLowerCase()];
    if (type) {
      let body = await fs.promises.readFile(file);
      let mime = type;
      if (body.length > IMAGE_MAX_BYTES && fs.existsSync("/usr/bin/sips")) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mac-shell-img-"));
        try {
          await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "75", "-Z", "1600", file, "--out", path.join(tmp, "i.jpg")], { timeout: 20_000 });
          body = fs.readFileSync(path.join(tmp, "i.jpg"));
          mime = "image/jpeg";
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      return { content: [{ type: "text", text: `Read image file ${file} [${mime}]` }, { type: "image", data: body.toString("base64"), mimeType: mime }] };
    }
    if (stat.size > MAX_TEXT_FILE) return text(`${file} is ${Math.round(stat.size / 1024 / 1024)} MB; read parts of it with bash (head, tail, sed -n).`, true);
    const buf = await fs.promises.readFile(file);
    if (buf.subarray(0, 8192).includes(0)) return text(`${file} is a binary file; inspect it with bash (file, xxd, strings).`, true);
    const lines = buf.toString("utf8").split("\n");
    const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
    if (offset > lines.length) return text(`offset ${offset} is past the end of ${file} (${lines.length} lines).`, true);
    const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || MAX_LINES), MAX_LINES));
    const picked = [];
    let bytes = 0;
    for (let i = offset - 1; i < lines.length && picked.length < limit; i++) {
      const size = Buffer.byteLength(lines[i]) + 1;
      if (bytes + size > MAX_BYTES && picked.length) break;
      if (size > MAX_BYTES) return text(`Line ${i + 1} of ${file} is longer than ${MAX_BYTES / 1024} KB; read it with bash: sed -n '${i + 1}p' ${JSON.stringify(file)} | head -c ${MAX_BYTES}`, true);
      picked.push(lines[i]);
      bytes += size;
    }
    const last = offset + picked.length - 1;
    const more = last < lines.length ? `\n\n[Showing lines ${offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.]` : "";
    return text(picked.join("\n") + more);
  }

  async function write(name, args) {
    const file = await resolve(name, args.path);
    if (typeof args.content !== "string") return text("content is required (a string).", true);
    return serial(writes, file, async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, args.content);
      return text(`Wrote ${Buffer.byteLength(args.content)} bytes to ${file}`);
    });
  }

  async function edit(name, args) {
    const file = await resolve(name, args.path);
    return serial(writes, file, async () => {
      const { text: next, lines } = applyEdits(await fs.promises.readFile(file, "utf8"), args.edits);
      await fs.promises.writeFile(file, next);
      return text(`Applied ${lines.length} edit${lines.length === 1 ? "" : "s"} to ${file} (at line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}).`);
    });
  }

  // Sessions of tasks long finished go, with their files.
  const reaper = setInterval(async () => {
    if (!tmux) return;
    const listed = await tm("list-sessions", "-F", "#{session_name} #{session_activity}").catch(() => "");
    for (const line of listed.split("\n")) {
      const [name, at] = line.trim().split(" ");
      if (!name?.startsWith("aio-") || Date.now() - Number(at) * 1000 < IDLE_MS) continue;
      await tm("kill-session", "-t", `=${name}`).catch(() => undefined);
      fs.rmSync(dirOf(name), { recursive: true, force: true });
      log("shell session ended (idle)", { session: name });
    }
  }, 10 * 60_000);
  reaper.unref();

  return {
    status() {
      return { enabled: Boolean(enabled), tmux: Boolean(tmux) };
    },

    /** One JSON-RPC request; `session` names the task's shell (X-AIO-Shell-Session). */
    async handle(message, session) {
      const { id, method, params } = message ?? {};
      if (id === undefined || id === null) return null;
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is answered by the gateway` } };
      if (!enabled) return { jsonrpc: "2.0", id, result: text(OFF, true) };
      const name = `aio-${typeof session === "string" && SESSION.test(session) ? session : "main"}`;
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const tool = { read, write, edit, bash }[params?.name];
      if (!tool) return { jsonrpc: "2.0", id, result: text(`Unknown tool ${params?.name}; the tools are ${TOOL_NAMES.join(", ")}.`, true) };
      try {
        return { jsonrpc: "2.0", id, result: await tool(name, args) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: text(err?.code === "ENOENT" ? `No such file or directory: ${err.path ?? args.path}` : err?.message ?? String(err), true) };
      }
    },

    /** The bridge is ending: the shells go with it. */
    close() {
      clearInterval(reaper);
      // Synchronously: this also runs on the way out of the process.
      if (tmux) try { execFileSync(tmux, ["-L", socket, "-f", "/dev/null", "kill-server"], { env, timeout: 5000, stdio: "ignore" }); } catch { /* no server */ }
    },
  };
}
