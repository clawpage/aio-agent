import type http from "node:http";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import type { Db } from "./db.js";
import type { SessionStore } from "./auth/sessions.js";
import { getUser } from "./auth/owner.js";
import { resolveRequest } from "./http/security.js";
import { endSocket } from "./http/proxy.js";
import { McpGateway, type McpCall } from "./mcpGateway.js";
import type { DeviceLinks, Tunnel, TunnelChannel } from "./deviceLink.js";
import { PHONE_SERVER, PHONE_TOOLS } from "./phoneTools.js";

/**
 * An account's Android phone: plugged into a Mac that runs the app, which runs
 * bin/phone-bridge.mjs and links the Mac to the account that asked (DeviceLinks).
 * Each account reaches only its own: the executor through the member gateway
 * (`/phone/<token>/mcp`, mobile-mcp's tools that act on the phone), the person
 * through the console (`/api/phone/screen`, the live screen and touch). Device
 * tokens stay in the control plane.
 */
const TIMEOUT_MS = 120_000;
const PHONE_OFFLINE = "The Mac with the user's phone is not connected right now (the app on it is closed, asleep or offline). Ask the user to open the app on that Mac, then try again.";
export const PHONE_SCREEN_PATH = "/api/phone/screen";

/** Thread-level MCP wiring for a Codex executor. */
export function phoneThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.phone ? { aio_phone: { url: cfg.phone.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function phoneMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.phone ? { aio_phone: { type: "http", url: cfg.phone.url } } : {};
}

export const PHONE_POLICY =
  "The user's own Android phone is connected (aio_phone, attached by USB to the user's Mac, not a cloud phone): when the user wants you to open an app on the phone, tap, type, look at content on the phone, or do something only a phone app can do, operate it directly with its tools; do not make the user tap it themselves. First get the device id with mobile_list_available_devices; to see the screen, prefer mobile_list_elements_on_screen, and take a screenshot only for what is not in the elements; do known consecutive steps in one go with mobile_batch_commands; after each key step, read the screen once to confirm the result. The user can watch your actions live in 手机 (Phone) in the console workspace. For steps with external effects or that are hard to undo, such as paying, transferring money, placing orders, sending messages or posts to others, deleting content, or changing account or security settings, first tell the user what you are about to do and wait for confirmation. SMS verification codes: when the user asks you to read a verification code this phone received, read it in the SMS app and fill it in, only for the account the user asked you to sign in to or verify this time; when the user has not said so, stop and ask. Sign-in passwords, payment passwords, and fingerprint or face recognition are done by the user personally. When the user needs to operate the phone with their own hands, ask and wait, saying clearly which step to do: the task card shows the phone screen, the user can open it and operate directly, and will reply to you when done; then read the screen once more to confirm before continuing. Do only what the user asked for this time; do not open or change other apps along the way.";

type Device = { serial: string; model: string; name: string; android: string };

export class PhoneGateway extends McpGateway {
  #cfg: Config;
  #log: Logger;
  #links: DeviceLinks;
  #userIdOf: (username: string) => string | null;
  #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  #sessions = new WeakMap<Tunnel, Promise<string>>();

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks }) {
    super({
      ...opts,
      name: "phone",
      // No upstream of its own: every call goes down the socket of the account's Mac (local).
      upstreamUrl: "",
      secretKey: "",
      secretsFile: "",
      // Each account only its own phone: one on a Mac it linked.
      granted: (username) => opts.links.hasLink(opts.userIdOf(username) ?? ""),
      assign: (runtime, url) => { runtime.phone = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
    this.#cfg = opts.cfg;
    this.#log = opts.log.child("phone");
    this.#links = opts.links;
    this.#userIdOf = opts.userIdOf;
  }

  override get enabled(): boolean {
    return true;
  }

  /** Whether the account has a phone to offer (a linked Mac; it may be offline). */
  available(userId: string): boolean {
    return Boolean(userId) && this.#links.hasLink(userId);
  }

  /** Give or take away the runtime's phone tools after its account linked or unlinked a Mac. */
  refresh(runtime: Config): void {
    if (this.available(runtime.runtimeUserId ?? "")) this.provision(runtime);
    else delete runtime.phone;
  }

  /**
   * The executor's MCP session ends here; the gateway keeps its own session with
   * mobile-mcp on each Mac. The handshake never depends on the Mac: Codex starts a
   * thread's MCP servers once and never retries a failed one, so a Mac offline for
   * a moment must not cost the thread its phone. Only tool calls need the Mac, and
   * while it is offline they come back as a tool error the executor can read.
   */
  protected override async local(message: unknown, username: string): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown } };
    // Notifications (initialized, cancelled) have nothing to answer.
    if (id === undefined || id === null) return null;
    if (method === "initialize") {
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, ...PHONE_SERVER } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    const userId = this.#userIdOf(username) ?? "";
    const tunnel = this.available(userId) ? this.#links.tunnelFor(userId) : null;
    if (method === "tools/list") {
      if (tunnel) {
        try {
          const live = (await this.#rpc(tunnel, message)) as { result?: { tools?: unknown[] } };
          if (Array.isArray(live?.result?.tools)) return live;
        } catch (err) {
          this.#log.warn("phone tool list from the Mac failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { jsonrpc: "2.0", id, result: { tools: PHONE_TOOLS } };
    }
    const failed = (why: string) => method === "tools/call"
      ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: why }], isError: true } }
      : { jsonrpc: "2.0", id, error: { code: -32000, message: why } };
    if (!tunnel) return failed(PHONE_OFFLINE);
    try {
      return await this.#rpc(tunnel, message);
    } catch (err) {
      this.#log.warn("phone call failed", { error: err instanceof Error ? err.message : String(err) });
      return failed(this.#links.tunnelFor(userId) ? "The phone bridge on the Mac did not answer; try again." : PHONE_OFFLINE);
    }
  }

  /** Something that is not JSON never reaches the Mac. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }

  /** One JSON-RPC request to the Mac's mobile-mcp on this gateway's session, opened again once if it went stale. */
  async #rpc(tunnel: Tunnel, message: unknown, again = true): Promise<unknown> {
    const session = await this.#session(tunnel);
    const reply = await tunnel.request("POST", "/mcp", {
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": session },
      body: Buffer.from(JSON.stringify(message)),
      timeoutMs: TIMEOUT_MS,
    });
    // mobile-mcp restarted on the Mac (its sessions are gone): a new one, and the call once more.
    if ((reply.status === 400 || reply.status === 404) && again) {
      this.#sessions.delete(tunnel);
      return this.#rpc(tunnel, message, false);
    }
    if (reply.status !== 200) throw new Error(`phone bridge answered ${reply.status}`);
    return rpcAnswer(reply.body.toString("utf8"), (message as { id?: unknown }).id);
  }

  /** This gateway's mobile-mcp session on a Mac's socket; a new socket gets a new one. */
  #session(tunnel: Tunnel): Promise<string> {
    let session = this.#sessions.get(tunnel);
    if (!session) {
      session = (async () => {
        const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
        const init = await tunnel.request("POST", "/mcp", {
          headers,
          body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "aio-phone-gateway", version: "1" } } })),
          timeoutMs: 30_000,
        });
        const id = init.headers["mcp-session-id"];
        if (init.status !== 200 || !id) throw new Error(`phone bridge did not open a session (${init.status})`);
        await tunnel.request("POST", "/mcp", {
          headers: { ...headers, "mcp-session-id": id },
          body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
          timeoutMs: 30_000,
        });
        return id;
      })();
      session.catch(() => { if (this.#sessions.get(tunnel) === session) this.#sessions.delete(tunnel); });
      this.#sessions.set(tunnel, session);
    }
    return session;
  }

  /** The account's connected phone, as its Mac's bridge sees it; null when the Mac is offline. */
  async status(userId: string): Promise<{ device: Device | null } | null> {
    try {
      const tunnel = this.available(userId) ? this.#links.tunnelFor(userId) : null;
      const reply = tunnel ? await tunnel.request("GET", "/status", { timeoutMs: 15_000 }) : null;
      if (!reply || reply.status !== 200) return null;
      return { device: (JSON.parse(reply.body.toString("utf8")) as { device?: Device | null }).device ?? null };
    } catch {
      return null;
    }
  }

  /** The screen now, for a task card; null when the Mac or the phone is not there. */
  async screenshot(userId: string): Promise<{ type: string; body: Buffer } | null> {
    try {
      const tunnel = this.available(userId) ? this.#links.tunnelFor(userId) : null;
      const reply = tunnel ? await tunnel.request("GET", "/screenshot", { timeoutMs: 20_000 }) : null;
      return reply?.status === 200 ? { type: reply.headers["content-type"] ?? "image/png", body: reply.body } : null;
    } catch {
      return null;
    }
  }

  /** Whether an upgrade is the console's phone screen. */
  ownsUpgrade(req: http.IncomingMessage): boolean {
    return (req.url ?? "").split("?")[0] === PHONE_SCREEN_PATH;
  }

  /**
   * The live screen for an account's console: its session on the primary origin,
   * opened by the console itself (Origin), relayed to that account's Mac.
   */
  handleUpgrade(deps: { db: Db; sessions: SessionStore }, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const rec = resolveRequest({ cfg: this.#cfg, sessions: deps.sessions, req });
    const origin = (rec?.origin ?? "").replace(/\/+$/, "");
    const fromConsole = this.#cfg.primaryOrigins.some((o) => o.replace(/\/+$/, "") === origin);
    const session = rec?.kind === "primary" ? rec.session : null;
    const user = session && deps.sessions.isLive(session.id) ? getUser(deps.db, session.ownerId) : null;
    if (!fromConsole || !user) {
      this.#log.warn("phone screen refused", { origin: rec?.origin ?? null, kind: rec?.kind ?? null, user: user?.username ?? null });
      return endSocket(socket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    if (!this.available(user.id)) return endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    this.#wss.handleUpgrade(req, socket, head, (client) => {
      this.#relay(client, channelSocket(this.#links.tunnelFor(user.id)?.socket("/screen")), () => deps.sessions.isLive(session!.id));
    });
  }

  #relay(client: WebSocket, upstream: ScreenUpstream, live: () => boolean): void {
    const close = (code = 1011, reason = "") => {
      clearInterval(timer);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
      upstream.close();
    };
    const timer = setInterval(() => { if (!live()) close(1008, "signed out"); }, 100);
    // A slow viewer drops video instead of piling it up; once it has caught up it asks the bridge for a key frame.
    let behind = false;
    upstream.on("message", (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (binary && (behind || client.bufferedAmount > 1024 * 1024)) {
        behind = client.bufferedAmount > 256 * 1024;
        if (!behind) upstream.send(JSON.stringify({ t: "reset" }));
        return;
      }
      client.send(data, { binary });
    });
    client.on("message", (data, binary) => {
      if (!binary) upstream.send(data.toString("utf8"));
    });
    upstream.on("close", (code) => close(code === 1000 ? 1000 : 1011, "phone closed"));
    upstream.on("error", (err) => {
      this.#log.warn("phone bridge unreachable", { error: err.message });
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message: "手机服务暂时不可用" }));
      close();
    });
    client.on("close", () => close(1000));
    client.on("error", () => close());
  }
}

/** The screen relay's upstream: a channel down the Mac's socket. */
interface ScreenUpstream {
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: Buffer, binary: boolean) => void): unknown;
  on(event: "close", cb: (code: number) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

/** A linked Mac's screen channel; no channel (the Mac is offline) fails at once. */
function channelSocket(ch: TunnelChannel | undefined): ScreenUpstream {
  if (ch) return { send: (data) => ch.send(data, false), close: () => ch.close(), on: (event: string, cb: (...args: any[]) => void) => ch.on(event, cb) } as ScreenUpstream;
  const gone = new EventEmitter();
  queueMicrotask(() => { gone.emit("error", new Error("the Mac is not connected")); gone.emit("close", 1011); });
  return { send: () => undefined, close: () => undefined, on: (event: string, cb: (...args: any[]) => void) => gone.on(event, cb) } as ScreenUpstream;
}

/** The JSON-RPC answer to request `id` in a reply that is JSON or a server-sent event stream. */
function rpcAnswer(text: string, id: unknown): unknown {
  const candidates = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
  for (const candidate of candidates) {
    try {
      const msg = JSON.parse(candidate) as { id?: unknown };
      if (msg && msg.id === id) return msg;
    } catch { /* not this line */ }
  }
  throw new Error("phone bridge reply had no answer");
}
