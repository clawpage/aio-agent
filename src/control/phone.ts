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
  "已接入用户本人的 Android 手机（aio_phone，USB 连在家里的电脑上，不是云手机）：用户要你在手机上打开 App、点按、输入、查看手机里的内容，或做只有手机 App 能办的事时，用它的工具直接操作，不要让用户自己去点。先用 mobile_list_available_devices 取设备 id；看屏幕优先用 mobile_list_elements_on_screen，元素里没有的再截图；已知的连续步骤用 mobile_batch_commands 一次做完；每完成一步关键操作后读一次屏幕确认结果。用户在控制台工作区的「手机」里能实时看到你的操作。付款、转账、下单、发消息或发帖给别人、删除内容、改账号或安全设置这类有外部影响或难撤销的步骤，先把要做的内容告诉用户并等确认；遇到登录密码、验证码或人脸识别，停下来请用户在手机上自己完成。只做用户这次要求的事，不顺手打开或改动别的 App。";

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
