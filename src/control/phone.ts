import type http from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import type { Db } from "./db.js";
import type { SessionStore } from "./auth/sessions.js";
import { getUser } from "./auth/owner.js";
import { resolveRequest } from "./http/security.js";
import { endSocket } from "./http/proxy.js";
import { McpGateway } from "./mcpGateway.js";

/**
 * The owner's Android phone, plugged into the host and served by
 * bin/phone-bridge.mjs. Only the owner reaches it: the executor through the
 * member gateway (`/phone/<token>/mcp`, mobile-mcp's tools that act on the phone),
 * the person through the console (`/api/phone/screen`, the live screen and
 * touch). The bridge token stays in the control plane.
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

export class PhoneGateway extends McpGateway {
  #cfg: Config;
  #log: Logger;
  #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null }) {
    super({
      ...opts,
      name: "phone",
      upstreamUrl: opts.cfg.phoneBridge.url ? `${opts.cfg.phoneBridge.url}/mcp` : "",
      secretKey: PHONE_BRIDGE_KEY,
      secretsFile: opts.cfg.phoneBridge.secretsFile,
      // The owner's runtime only: a member never reaches the owner's phone.
      granted: (_username, runtime) => !runtime.memberRuntime,
      assign: (runtime, url) => { runtime.phone = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
    this.#cfg = opts.cfg;
    this.#log = opts.log.child("phone");
  }

  /** The connected phone, as the bridge sees it; null when the bridge is down. */
  async status(): Promise<{ device: { serial: string; model: string; name: string; android: string } | null } | null> {
    if (!this.enabled) return null;
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
  async screenshot(): Promise<{ type: string; body: Buffer } | null> {
    if (!this.enabled) return null;
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
   * The live screen for the owner's console: an owner session on the primary
   * origin, opened by the console itself (Origin), relayed to the bridge.
   */
  handleUpgrade(deps: { db: Db; sessions: SessionStore }, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const rec = resolveRequest({ cfg: this.#cfg, sessions: deps.sessions, req });
    const origin = (rec?.origin ?? "").replace(/\/+$/, "");
    const fromConsole = this.#cfg.primaryOrigins.some((o) => o.replace(/\/+$/, "") === origin);
    const session = rec?.kind === "primary" ? rec.session : null;
    const user = session && deps.sessions.isLive(session.id) ? getUser(deps.db, session.ownerId) : null;
    if (!this.enabled) return endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    if (!fromConsole || user?.role !== "owner") {
      this.#log.warn("phone screen refused", { origin: rec?.origin ?? null, kind: rec?.kind ?? null, user: user?.username ?? null });
      return endSocket(socket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    this.#wss.handleUpgrade(req, socket, head, (client) => this.#relay(client, () => deps.sessions.isLive(session!.id)));
  }

  #relay(client: WebSocket, live: () => boolean): void {
    const upstream = new WebSocket(`${this.#cfg.phoneBridge.url.replace(/^http/, "ws")}/screen`, {
      headers: { authorization: `Bearer ${this.upstreamToken()}` },
      maxPayload: 16 * 1024 * 1024,
    });
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
