import type http from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import { randomId } from "./auth/passwords.js";
import { endSocket } from "./http/proxy.js";
import { classifyHost } from "./http/security.js";

/**
 * A Mac running the app offers the phones plugged into it to its own account.
 * The Mac sits behind the user's router, so it dials in: the app's phone bridge
 * keeps one WebSocket open to `DEVICE_LINK_PATH` with the device token its
 * account issued, and the control plane sends the bridge's requests (MCP, status,
 * screenshot) and the live screen down that socket. A link reaches only the
 * account that created it; revoking it closes the socket.
 *
 * The iPhone app links itself the same way (kind `ios`, iosDevice.ts): its own
 * Photos, Reminders and Calendar, answered by the app over the same frames. A
 * kind's links never stand in for the other's.
 *
 * Frames: JSON text for requests, responses and channel control; binary frames
 * carry a channel's binary data, prefixed by the channel id (4 bytes, big endian).
 */
export const DEVICE_LINK_PATH = "/api/device-link/connect";
const MAX_FRAME = 32 * 1024 * 1024;
const PING_MS = 25_000;
const NAME_MAX = 80;

/** What dialed in: the Mac app (its phones, Chrome and terminal), the iPhone app or the Android app (docs/EXEC-ENVS.md). */
export type DeviceKind = "mac" | "ios" | "android";
export const DEVICE_KINDS: readonly DeviceKind[] = ["mac", "ios", "android"];

export interface DeviceLinkInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** One channel through a tunnel: a WebSocket to the bridge (the live screen). */
export class TunnelChannel extends EventEmitter {
  open = false;
  closed = false;
  constructor(private tunnel: Tunnel, readonly id: number) {
    super();
  }
  send(data: Buffer | string, binary: boolean): void {
    if (!this.closed) this.tunnel.channelSend(this.id, data, binary);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tunnel.channelClose(this.id);
    this.emit("close", 1000);
  }
}

export class Tunnel {
  /** What the device says unasked (`{ t: "event", name, data }`): its environments changed, say (envs/registry.ts). */
  readonly events = new EventEmitter();
  #next = 1;
  #pending = new Map<number, { resolve: (r: TunnelResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #channels = new Map<number, TunnelChannel>();
  readonly connectedAt = Date.now();

  constructor(readonly linkId: string, readonly ownerId: string, private ws: WebSocket, readonly kind: DeviceKind = "mac") {
    ws.on("message", (data, binary) => this.#receive(data as Buffer, binary));
    ws.on("close", () => this.#shutdown());
  }

  get alive(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  request(method: string, path: string, opts: { headers?: Record<string, string>; body?: Buffer; timeoutMs: number }): Promise<TunnelResponse> {
    if (!this.alive) return Promise.reject(new Error("device offline"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("device timeout"));
      }, opts.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t: "req", id, method, path, headers: opts.headers ?? {}, body: opts.body?.toString("base64") ?? "" }));
    });
  }

  socket(path: string): TunnelChannel {
    const ch = new TunnelChannel(this, this.#next++);
    this.#channels.set(ch.id, ch);
    if (this.alive) this.ws.send(JSON.stringify({ t: "open", ch: ch.id, path }));
    else queueMicrotask(() => { ch.closed = true; ch.emit("error", new Error("device offline")); ch.emit("close", 1011); });
    return ch;
  }

  channelSend(id: number, data: Buffer | string, binary: boolean): void {
    if (!this.alive) return;
    if (binary) {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(id);
      this.ws.send(Buffer.concat([head, Buffer.isBuffer(data) ? data : Buffer.from(data)]));
    } else {
      this.ws.send(JSON.stringify({ t: "msg", ch: id, data: data.toString() }));
    }
  }

  channelClose(id: number): void {
    this.#channels.delete(id);
    if (this.alive) this.ws.send(JSON.stringify({ t: "close", ch: id }));
  }

  close(code = 1000, reason = ""): void {
    this.ws.close(code, reason);
    this.#shutdown();
  }

  #receive(data: Buffer, binary: boolean): void {
    if (binary) {
      if (data.length < 4) return;
      this.#channels.get(data.readUInt32BE(0))?.emit("message", data.subarray(4), true);
      return;
    }
    let msg: { t?: string; id?: number; ch?: number; status?: number; headers?: Record<string, string>; body?: string; data?: string; code?: number };
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.t === "event" && typeof (msg as { name?: unknown }).name === "string") {
      this.events.emit("event", (msg as { name: string }).name, (msg as { data?: unknown }).data);
      return;
    }
    if (msg.t === "res" && typeof msg.id === "number") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve({ status: Number(msg.status) || 502, headers: msg.headers ?? {}, body: Buffer.from(msg.body ?? "", "base64") });
      return;
    }
    const ch = typeof msg.ch === "number" ? this.#channels.get(msg.ch) : undefined;
    if (!ch) return;
    if (msg.t === "opened") {
      ch.open = true;
      ch.emit("open");
    } else if (msg.t === "msg") {
      ch.emit("message", Buffer.from(msg.data ?? "", "utf8"), false);
    } else if (msg.t === "closed") {
      this.#channels.delete(ch.id);
      ch.closed = true;
      ch.emit("close", msg.code ?? 1000);
    }
  }

  #shutdown(): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("device offline"));
    }
    this.#pending.clear();
    for (const [, ch] of this.#channels) {
      ch.closed = true;
      ch.emit("close", 1011);
    }
    this.#channels.clear();
  }
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class DeviceLinks {
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  #tunnels = new Map<string, Tunnel>();
  #watchers = new Set<(tunnel: Tunnel, online: boolean) => void>();
  #log: Logger;
  /** Told when an account's first link of a kind appears or its last one goes, so its runtime gains or loses the tools. */
  onAccountChange?: (ownerId: string) => void;

  constructor(private db: Db, private cfg: Config, log: Logger) {
    this.#log = log.child("device-link");
  }

  /** A new link for an account; the token is shown once and only its hash is kept. */
  create(ownerId: string, name: string, kind: DeviceKind = "mac"): { link: DeviceLinkInfo; token: string } {
    const first = !this.hasLink(ownerId, kind);
    const token = `dl_${randomBytes(32).toString("base64url")}`;
    const link = { id: randomId("dlink"), name: name.trim().slice(0, NAME_MAX), createdAt: Date.now() };
    this.db.prepare("INSERT INTO device_links (id,owner_id,token_hash,name,created_at,kind) VALUES (?,?,?,?,?,?)").run(link.id, ownerId, hash(token), link.name, link.createdAt, kind);
    if (first) this.onAccountChange?.(ownerId);
    return { link: { ...link, lastSeenAt: null, online: false }, token };
  }

  list(ownerId: string, kind: DeviceKind = "mac"): DeviceLinkInfo[] {
    return (this.db.prepare("SELECT id,name,created_at,last_seen_at FROM device_links WHERE owner_id=? AND kind=? ORDER BY created_at DESC").all(ownerId, kind) as Array<{ id: string; name: string; created_at: number; last_seen_at: number | null }>)
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, online: Boolean(this.#tunnels.get(r.id)?.alive) }));
  }

  /** Only the account's own link; its socket closes at once. */
  revoke(ownerId: string, id: string): boolean {
    const row = this.db.prepare("SELECT kind FROM device_links WHERE id=? AND owner_id=?").get(id, ownerId) as { kind: DeviceKind } | undefined;
    const removed = Boolean(row) && Number(this.db.prepare("DELETE FROM device_links WHERE id=? AND owner_id=?").run(id, ownerId).changes) > 0;
    if (!removed) return false;
    this.#tunnels.get(id)?.close(4001, "revoked");
    this.#tunnels.delete(id);
    if (!this.hasLink(ownerId, row!.kind)) this.onAccountChange?.(ownerId);
    return true;
  }

  hasLink(ownerId: string, kind: DeviceKind = "mac"): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM device_links WHERE owner_id=? AND kind=? LIMIT 1").get(ownerId, kind));
  }

  /** The account's most recently connected device of a kind that is online. */
  tunnelFor(ownerId: string, kind: DeviceKind = "mac"): Tunnel | null {
    let best: Tunnel | null = null;
    for (const t of this.#tunnels.values()) if (t.ownerId === ownerId && t.kind === kind && t.alive && (!best || t.connectedAt > best.connectedAt)) best = t;
    return best;
  }

  /** Every online device of an account, of every kind. */
  tunnelsFor(ownerId: string): Tunnel[] {
    return [...this.#tunnels.values()].filter((t) => t.ownerId === ownerId && t.alive);
  }

  /** Told of each device that comes online or goes; the returned function stops it. */
  watch(fn: (tunnel: Tunnel, online: boolean) => void): () => void {
    this.#watchers.add(fn);
    return () => this.#watchers.delete(fn);
  }

  #tell(tunnel: Tunnel, online: boolean): void {
    for (const fn of this.#watchers) {
      try { fn(tunnel, online); } catch (err) { this.#log.warn("device link watcher failed", { error: err instanceof Error ? err.message : String(err) }); }
    }
  }

  ownsUpgrade(req: http.IncomingMessage): boolean {
    return (req.url ?? "").split("?")[0] === DEVICE_LINK_PATH;
  }

  /** The app's bridge dialing in on the primary host with its device token. */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const host = req.headers.host;
    const token = /^Bearer (dl_[A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const row = token ? (this.db.prepare("SELECT id,owner_id,kind FROM device_links WHERE token_hash=?").get(hash(token)) as { id: string; owner_id: string; kind: DeviceKind } | undefined) : undefined;
    if (classifyHost(this.cfg, host) !== "primary" || !row) {
      this.#log.warn("device link refused", { host, known: Boolean(row) });
      return endSocket(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    let name = "";
    try { name = decodeURIComponent(String(req.headers["x-aio-device-name"] ?? "")).trim().slice(0, NAME_MAX); } catch { /* keep the stored name */ }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#tunnels.get(row.id)?.close(4002, "replaced");
      const tunnel = new Tunnel(row.id, row.owner_id, ws, row.kind);
      this.#tunnels.set(row.id, tunnel);
      const seen = () => this.db.prepare("UPDATE device_links SET last_seen_at=?" + (name ? ",name=?" : "") + " WHERE id=?").run(...(name ? [Date.now(), name, row.id] : [Date.now(), row.id]));
      seen();
      this.#log.info("device link online", { link: row.id, kind: row.kind });
      this.#tell(tunnel, true);
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const ping = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, PING_MS);
      ws.on("close", () => {
        clearInterval(ping);
        if (this.#tunnels.get(row.id) === tunnel) this.#tunnels.delete(row.id);
        try { seen(); } catch { /* link revoked meanwhile */ }
        this.#log.info("device link offline", { link: row.id });
        this.#tell(tunnel, false);
      });
      ws.on("error", () => ws.terminate());
    });
  }

  close(): void {
    for (const t of this.#tunnels.values()) t.close(1001, "shutdown");
    this.#tunnels.clear();
  }
}
