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
import type { DeviceLinks, TunnelChannel } from "./deviceLink.js";

/**
 * An account's Android phone, served by bin/phone-bridge.mjs. Two places run
 * the bridge: this host, for the owner's phone on its USB (`PA_PHONE_BRIDGE_URL`),
 * and the Mac app of any account, which links the Mac's USB phones to that
 * account only (DeviceLinks). Each account reaches only its own: the executor
 * through the member gateway (`/phone/<token>/mcp`, mobile-mcp's tools that act
 * on the phone), the person through the console (`/api/phone/screen`, the live
 * screen and touch). Bridge and device tokens stay in the control plane.
 */
export const PHONE_BRIDGE_KEY = "PHONE_BRIDGE_TOKEN";
const TIMEOUT_MS = 120_000;
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
  "The user's own Android phone is connected (aio_phone, attached by USB to a computer at home, not a cloud phone): when the user wants you to open an app on the phone, tap, type, look at content on the phone, or do something only a phone app can do, operate it directly with its tools; do not make the user tap it themselves. First get the device id with mobile_list_available_devices; to see the screen, prefer mobile_list_elements_on_screen, and take a screenshot only for what is not in the elements; do known consecutive steps in one go with mobile_batch_commands; after each key step, read the screen once to confirm the result. The user can watch your actions live in 手机 (Phone) in the console workspace. For steps with external effects or that are hard to undo, such as paying, transferring money, placing orders, sending messages or posts to others, deleting content, or changing account or security settings, first tell the user what you are about to do and wait for confirmation. SMS verification codes: when the user asks you to read a verification code this phone received, read it in the SMS app and fill it in, only for the account the user asked you to sign in to or verify this time; when the user has not said so, stop and ask. Sign-in passwords, payment passwords, and fingerprint or face recognition are done by the user personally. When the user needs to operate the phone with their own hands, ask and wait, saying clearly which step to do: the task card shows the phone screen, the user can open it and operate directly, and will reply to you when done; then read the screen once more to confirm before continuing. Do only what the user asked for this time; do not open or change other apps along the way.";

type Device = { serial: string; model: string; name: string; android: string };

/** Where an account's phone is reached: this host's bridge, its linked Mac, or nowhere. */
type Upstream = { kind: "host" } | { kind: "link"; links: DeviceLinks } | null;

export class PhoneGateway extends McpGateway {
  #cfg: Config;
  #log: Logger;
  #links: DeviceLinks | undefined;
  #userIdOf: (username: string) => string | null;
  #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links?: DeviceLinks }) {
    const self: { gateway?: PhoneGateway } = {};
    super({
      ...opts,
      name: "phone",
      upstreamUrl: opts.cfg.phoneBridge.url ? `${opts.cfg.phoneBridge.url}/mcp` : "",
      secretKey: PHONE_BRIDGE_KEY,
      secretsFile: opts.cfg.phoneBridge.secretsFile,
      // Each account only its own phone: the owner the host's, any account its linked Mac's.
      granted: (username) => self.gateway!.available(opts.userIdOf(username) ?? ""),
      assign: (runtime, url) => { runtime.phone = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
    self.gateway = this;
    this.#cfg = opts.cfg;
    this.#log = opts.log.child("phone");
    this.#links = opts.links;
    this.#userIdOf = opts.userIdOf;
  }

  /** The host bridge alone; a linked Mac needs no host configuration. */
  get #hostEnabled(): boolean {
    return super.enabled;
  }

  override get enabled(): boolean {
    return this.#hostEnabled || Boolean(this.#links);
  }

  #upstream(userId: string): Upstream {
    // The host's phone is the owner's (the root runtime's account), and only the owner's.
    if (userId && userId === this.#cfg.runtimeUserId && this.#hostEnabled) return { kind: "host" };
    if (userId && this.#links?.hasLink(userId)) return { kind: "link", links: this.#links };
    return null;
  }

  /** Whether the account has a phone to offer (it may still be offline). */
  available(userId: string): boolean {
    return this.#upstream(userId) !== null;
  }

  /** Give or take away the runtime's phone tools after its account linked or unlinked a Mac. */
  refresh(runtime: Config): void {
    if (this.available(runtime.runtimeUserId ?? "")) this.provision(runtime);
    else delete runtime.phone;
  }

  protected override async forward(call: McpCall, res: http.ServerResponse): Promise<boolean> {
    const upstream = this.#upstream(this.#userIdOf(call.username) ?? "");
    if (upstream?.kind === "host") return false;
    const tunnel = upstream ? upstream.links.tunnelFor(this.#userIdOf(call.username)!) : null;
    if (!tunnel) {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "phone_offline", message: "The Mac with the phone is not connected: open the app on it" }));
      return true;
    }
    const reply = await tunnel.request("POST", "/mcp", {
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...call.headers },
      body: call.body,
      timeoutMs: TIMEOUT_MS,
    });
    if (reply.status === 401 || reply.status === 403) {
      this.#log.warn("linked phone bridge rejected the call");
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "phone unavailable" }));
      return true;
    }
    const session = reply.headers["mcp-session-id"];
    res.writeHead(reply.status, {
      "content-type": reply.headers["content-type"] ?? "application/json",
      "cache-control": "no-store",
      ...(session ? { "mcp-session-id": session } : {}),
    });
    res.end(reply.body);
    return true;
  }

  /** The account's connected phone, as its bridge sees it; null when the bridge is down. */
  async status(userId: string): Promise<{ device: Device | null } | null> {
    const upstream = this.#upstream(userId);
    if (!upstream) return null;
    if (upstream.kind === "link") {
      try {
        const tunnel = upstream.links.tunnelFor(userId);
        const reply = tunnel ? await tunnel.request("GET", "/status", { timeoutMs: 15_000 }) : null;
        if (!reply || reply.status !== 200) return null;
        return { device: (JSON.parse(reply.body.toString("utf8")) as { device?: Device | null }).device ?? null };
      } catch {
        return null;
      }
    }
    try {
      const res = await fetch(`${this.#cfg.phoneBridge.url}/status`, {
        headers: { authorization: `Bearer ${this.upstreamToken()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { device?: { serial: string; model: string; name: string; android: string } | null };
      return { device: body.device ?? null };
    } catch {
      return null;
    }
  }

  /** The screen now, for a task card; null when the bridge or the phone is not there. */
  async screenshot(userId: string): Promise<{ type: string; body: Buffer } | null> {
    const upstream = this.#upstream(userId);
    if (!upstream) return null;
    if (upstream.kind === "link") {
      try {
        const tunnel = upstream.links.tunnelFor(userId);
        const reply = tunnel ? await tunnel.request("GET", "/screenshot", { timeoutMs: 20_000 }) : null;
        return reply?.status === 200 ? { type: reply.headers["content-type"] ?? "image/png", body: reply.body } : null;
      } catch {
        return null;
      }
    }
    try {
      const res = await fetch(`${this.#cfg.phoneBridge.url}/screenshot`, {
        headers: { authorization: `Bearer ${this.upstreamToken()}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      return { type: res.headers.get("content-type") ?? "image/png", body: Buffer.from(await res.arrayBuffer()) };
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
   * opened by the console itself (Origin), relayed to that account's bridge.
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
    const target = this.#upstream(user.id);
    if (!target) return endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    this.#wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = target.kind === "host"
        ? new WebSocket(`${this.#cfg.phoneBridge.url.replace(/^http/, "ws")}/screen`, {
          headers: { authorization: `Bearer ${this.upstreamToken()}` },
          maxPayload: 16 * 1024 * 1024,
        })
        : channelSocket(target.links.tunnelFor(user.id)?.socket("/screen"));
      this.#relay(client, upstream, () => deps.sessions.isLive(session!.id));
    });
  }

  #relay(client: WebSocket, upstream: ScreenUpstream, live: () => boolean): void {
    const close = (code = 1011, reason = "") => {
      clearInterval(timer);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      else upstream.terminate();
    };
    // A signed-out session loses the screen; a slow viewer pushes back on the bridge, which skips to the next key frame.
    const timer = setInterval(() => {
      if (!live()) return close(1008, "signed out");
      if (upstream.isPaused && client.bufferedAmount < 256 * 1024) upstream.resume();
    }, 100);
    upstream.on("message", (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data, { binary });
      if (client.bufferedAmount > 1024 * 1024) upstream.pause();
    });
    client.on("message", (data, binary) => {
      if (!binary && upstream.readyState === WebSocket.OPEN) upstream.send(data.toString("utf8"));
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

/** What the screen relay needs of its upstream: a WebSocket to the host bridge, or a tunnel channel. */
type ScreenUpstream = Pick<WebSocket, "readyState" | "isPaused" | "pause" | "resume" | "close" | "terminate"> & {
  send(data: string): void;
  on(event: "message", cb: (data: Buffer, binary: boolean) => void): unknown;
  on(event: "close", cb: (code: number) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
};

/** A linked Mac's screen channel as a ScreenUpstream; no channel (the Mac is offline) fails at once. */
function channelSocket(ch: TunnelChannel | undefined): ScreenUpstream {
  const emitter = ch ?? new EventEmitter();
  if (!ch) queueMicrotask(() => { emitter.emit("error", new Error("the Mac is not connected")); emitter.emit("close", 1011); });
  return {
    get readyState() { return ch && !ch.closed ? WebSocket.OPEN : WebSocket.CLOSED; },
    isPaused: false,
    pause: () => undefined,
    resume: () => undefined,
    close: () => ch?.close(),
    terminate: () => ch?.close(),
    send: (data: string) => ch?.send(data, false),
    on: (event: string, cb: (...args: never[]) => void) => emitter.on(event, cb as (...args: unknown[]) => void),
  } as ScreenUpstream;
}
