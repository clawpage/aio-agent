/**
 * Keeps the sandbox's `codex app-server` running across control-plane restarts.
 *
 * `serve` runs detached inside the sandbox: it owns the app-server and listens on
 * a unix socket. `attach` is what the control plane runs over `docker exec -i`:
 * it joins its stdio to that socket. Restarting the control plane only ends the
 * attach process; the app-server and its turns go on, and the next control plane
 * attaches again and picks up where the last one stopped:
 *
 * - Every notification and server request from Codex gets a sequence number
 *   (`aioSeq`) and stays in a journal until the control plane acknowledges it
 *   (`aio/bridge/ack`). Attaching with `aio/bridge/attach {after}` replays the
 *   journal after that number, then any server request still unanswered.
 * - Request ids are the bridge's own towards Codex, so a reply to a request from
 *   an earlier attachment never reaches a later one under a reused id.
 * - `initialize` is answered from the first one's reply once Codex has it.
 * - The first message on every attachment is `aio/bridge/hello`: whether Codex
 *   was ever initialized, the key it was started with (the control plane starts a
 *   new one when idle if its own key differs), and whether the journal had to drop
 *   messages the attachment asked for (`gap`).
 * - `aio/bridge/retire` stops Codex and the bridge.
 *
 * Plain Node (the sandbox image ships it), no dependencies. No backticks or
 * dollar-brace in here: it is a template literal.
 */
export const APP_SERVER_BRIDGE_JS = String.raw`import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";

const [mode, sock, ...rest] = process.argv.slice(2);

function lines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}

if (mode === "attach") {
  const c = net.connect(sock);
  c.on("error", () => process.exit(3));
  c.on("connect", () => {
    process.stdin.pipe(c);
    c.pipe(process.stdout);
  });
  c.on("close", () => process.exit(0));
  process.stdin.on("end", () => c.end());
} else if (mode === "serve") {
  const key = rest[0];
  const argv = rest.slice(rest.indexOf("--") + 1);
  const MAX_ENTRIES = 50000, MAX_BYTES = 64 * 1024 * 1024;
  const probe = net.connect(sock);
  probe.on("connect", () => { probe.destroy(); process.exit(0); });
  probe.on("error", () => serve());

  function serve() {
    try { fs.unlinkSync(sock); } catch {}
    const log = fs.createWriteStream(sock + ".log", { flags: "w" });
    let logged = 0;
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (d) => { if (logged < 8 * 1024 * 1024) { logged += d.length; log.write(d); } });
    let seq = 0, dropped = 0, bytes = 0, client = null, gen = 0, nextId = 1, initReply = null, initialized = false;
    const journal = [];
    const unanswered = new Map();
    const ids = new Map();
    const send = (out) => { if (client) client.write(out + "\n"); };
    const toCodex = (msg) => { try { child.stdin.write(JSON.stringify(msg) + "\n"); } catch {} };
    const trim = (upTo) => {
      while (journal.length && (journal[0].seq <= upTo || journal.length > MAX_ENTRIES || bytes > MAX_BYTES)) {
        const e = journal.shift();
        bytes -= e.out.length;
        if (e.seq > upTo) dropped = e.seq;
      }
    };
    lines(child.stdout, (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
        const asked = ids.get(msg.id);
        ids.delete(msg.id);
        if (!asked) return;
        if (asked.method === "initialize" && !msg.error) initReply = msg;
        if (asked.gen !== gen) return;
        msg.id = asked.id;
        send(JSON.stringify(msg));
        return;
      }
      msg.aioSeq = ++seq;
      const out = JSON.stringify(msg);
      journal.push({ seq, out });
      bytes += out.length;
      trim(0);
      if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) unanswered.set(String(msg.id), { seq, out });
      send(out);
    });
    child.on("exit", (code) => {
      try { fs.unlinkSync(sock); } catch {}
      if (client) client.destroy();
      log.end(() => process.exit(code ?? 1));
    });
    const server = net.createServer((socket) => {
      let attached = false;
      lines(socket, (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!attached) {
          if (msg.method !== "aio/bridge/attach") { socket.destroy(); return; }
          attached = true;
          if (client) client.destroy();
          client = socket;
          gen += 1;
          const after = Number(msg.params && msg.params.after) || 0;
          send(JSON.stringify({ jsonrpc: "2.0", method: "aio/bridge/hello", params: { key, fresh: !initReply, gap: after < dropped, seq } }));
          const replayed = new Set();
          for (const e of journal) if (e.seq > after) { replayed.add(e.seq); send(e.out); }
          for (const r of unanswered.values()) if (!replayed.has(r.seq)) send(r.out);
          return;
        }
        if (socket !== client) return;
        if (msg.method === "aio/bridge/ack") { trim(Number(msg.params && msg.params.seq) || 0); return; }
        if (msg.method === "aio/bridge/retire") { child.kill("SIGTERM"); return; }
        if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
          if (msg.method === "initialize" && initReply) { send(JSON.stringify(Object.assign({}, initReply, { id: msg.id }))); return; }
          const id = nextId++;
          ids.set(id, { gen, id: msg.id, method: msg.method });
          msg.id = id;
          toCodex(msg);
          return;
        }
        if (msg.method === "initialized") { if (initialized) return; initialized = true; }
        if (msg.method === undefined && msg.id !== undefined && msg.id !== null) unanswered.delete(String(msg.id));
        toCodex(msg);
      });
      socket.on("error", () => {});
      socket.on("close", () => { if (client === socket) client = null; });
    });
    server.listen(sock);
  }
} else {
  process.exit(2);
}
`;

/** Where the bridge script, its socket and Codex's stderr live inside the sandbox. */
export function appServerBridgePaths(codexHome: string): { script: string; socket: string } {
  return { script: `${codexHome}/tools/aio-codex-bridge/bridge.mjs`, socket: "/tmp/aio-codex-bridge.sock" };
}
