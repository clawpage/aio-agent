/**
 * The phone bridge's way out of the user's home network: it dials the control
 * plane (src/control/deviceLink.ts) with the device token its account issued
 * and serves what comes down the socket from its own loopback server. Only the
 * bridge's endpoints pass: POST /mcp, GET /status, GET /screenshot, and the
 * /screen WebSocket; anything else is answered 404 without reaching it.
 *
 * Frames: JSON text for requests, responses and channel control; binary frames
 * carry a channel's binary data, prefixed by the channel id (4 bytes, big endian).
 */
import WebSocket from "ws";

const ROUTES = new Set(["POST /mcp", "GET /status", "GET /screenshot"]);
const PASSED_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
const REPLY_HEADERS = ["content-type", "mcp-session-id"];
const MAX_FRAME = 32 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {string} opts.url      wss://<primary host>/api/device-link/connect
 * @param {string} opts.token    the device token (dl_...)
 * @param {string} opts.name     this Mac's name, shown in the account's list
 * @param {string} opts.local    the bridge on loopback, http://127.0.0.1:<port>
 * @param {string} opts.localToken  the bridge's own token
 * @param {(state: "connecting"|"online"|"offline"|"revoked", detail?: string) => void} opts.onState
 */
export function linkDevice({ url, token, name, local, localToken, onState }) {
  let ws = null;
  let stopped = false;
  let retry = 1000;
  let timer = null;
  const channels = new Map();
  const auth = { authorization: `Bearer ${localToken}` };

  const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  async function request({ id, method, path, headers = {}, body = "" }) {
    if (!ROUTES.has(`${method} ${path}`)) return send({ t: "res", id, status: 404, headers: {}, body: "" });
    try {
      const passed = Object.fromEntries(PASSED_HEADERS.filter((h) => typeof headers[h] === "string").map((h) => [h, headers[h]]));
      const res = await fetch(`${local}${path}`, { method, headers: { ...passed, ...auth }, body: method === "POST" ? Buffer.from(body, "base64") : undefined });
      const reply = Buffer.from(await res.arrayBuffer());
      const out = Object.fromEntries(REPLY_HEADERS.filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)]));
      send({ t: "res", id, status: res.status, headers: out, body: reply.toString("base64") });
    } catch (err) {
      send({ t: "res", id, status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "phone unavailable" })).toString("base64") });
    }
  }

  function open(ch, path) {
    if (path !== "/screen") return send({ t: "closed", ch, code: 1008 });
    const upstream = new WebSocket(`${local.replace(/^http/, "ws")}/screen`, { headers: auth, maxPayload: 16 * 1024 * 1024 });
    channels.set(ch, upstream);
    upstream.on("open", () => send({ t: "opened", ch }));
    upstream.on("message", (data, binary) => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (binary) {
        const head = Buffer.alloc(4);
        head.writeUInt32BE(ch);
        ws.send(Buffer.concat([head, data]));
      } else {
        send({ t: "msg", ch, data: data.toString("utf8") });
      }
    });
    upstream.on("close", (code) => {
      if (channels.get(ch) === upstream) channels.delete(ch);
      send({ t: "closed", ch, code });
    });
    upstream.on("error", () => upstream.terminate());
  }

  function closeChannels() {
    for (const upstream of channels.values()) upstream.terminate();
    channels.clear();
  }

  function connect() {
    if (stopped) return;
    onState("connecting");
    ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "x-aio-device-name": encodeURIComponent(name).slice(0, 240) }, maxPayload: MAX_FRAME });
    ws.on("open", () => {
      retry = 1000;
      onState("online");
    });
    ws.on("message", (data, binary) => {
      if (binary) {
        if (data.length < 4) return;
        const upstream = channels.get(data.readUInt32BE(0));
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data.subarray(4));
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
      if (msg.t === "req") void request(msg);
      else if (msg.t === "open" && Number.isInteger(msg.ch)) open(msg.ch, msg.path);
      else if (msg.t === "msg" && channels.get(msg.ch)?.readyState === WebSocket.OPEN) channels.get(msg.ch).send(String(msg.data ?? ""));
      else if (msg.t === "close") { channels.get(msg.ch)?.close(); channels.delete(msg.ch); }
    });
    ws.on("unexpected-response", (_req, res) => {
      // A token the server no longer knows (the link was removed): stop for good.
      if (res.statusCode === 401) { stopped = true; onState("revoked"); }
    });
    ws.on("close", (code) => {
      closeChannels();
      if (code === 4001) { stopped = true; onState("revoked"); return; }
      if (stopped) return;
      onState("offline");
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60_000);
    });
    ws.on("error", () => { /* close follows */ });
  }

  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      closeChannels();
      ws?.close(1000);
    },
  };
}
