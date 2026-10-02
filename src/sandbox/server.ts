import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../common/logger.js";
import {
  NODE_TOKEN_HEADER,
  PROTOCOL_HEADER,
  SANDBOX_HEADER,
  STREAM_STDERR,
  STREAM_STDOUT,
  type EnsureRequest,
  type ExecRequest,
  type NodeInfo,
  type NodeVersion,
  type SpawnClientMessage,
  type SpawnServerMessage,
} from "../common/protocol.js";
import { SANDBOX_PROTOCOL } from "../common/version.js";
import type { SandboxDriver } from "./driver.js";

const OUR_HEADERS = new Set([NODE_TOKEN_HEADER, PROTOCOL_HEADER, SANDBOX_HEADER]);
const MAX_BODY = 64 * 1024 * 1024;
const ROUTE = /^\/v1\/sandboxes\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(?:\/(ensure|stop|restart|peer-ports|exec|spawn))?$/;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface SandboxdOptions {
  driver: SandboxDriver;
  log: Logger;
  token: string;
  version: string;
}

/**
 * sandboxd's HTTP surface. Every request but `/healthz` must carry the node
 * token; every request but `/v1/version` must also name a protocol range that
 * includes this node's, so an incompatible control plane is refused up front.
 */
export function createSandboxd(opts: SandboxdOptions): http.Server {
  const { driver, log } = opts;
  const token = Buffer.from(opts.token);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

  const authorized = (req: http.IncomingMessage): boolean => {
    const supplied = Buffer.from(String(req.headers[NODE_TOKEN_HEADER] ?? ""));
    return supplied.length === token.length && timingSafeEqual(supplied, token);
  };
  const compatible = (req: http.IncomingMessage): boolean => {
    const match = /^(\d+)-(\d+)$/.exec(String(req.headers[PROTOCOL_HEADER] ?? ""));
    return !!match && Number(match[1]) <= SANDBOX_PROTOCOL && SANDBOX_PROTOCOL <= Number(match[2]);
  };
  const version = (): NodeVersion => ({ component: "sandbox", version: opts.version, protocol: SANDBOX_PROTOCOL });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://sandboxd");
        if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
        if (!authorized(req)) throw new HttpError(401, "unauthorized", "节点令牌无效");
        if (req.method === "GET" && url.pathname === "/v1/version") return send(res, 200, version());
        if (!compatible(req)) throw new HttpError(409, "incompatible", `沙箱节点协议 ${SANDBOX_PROTOCOL} 不在控制面支持的范围（${String(req.headers[PROTOCOL_HEADER] ?? "未声明")}）内`);
        if (req.headers[SANDBOX_HEADER]) return await proxyHttp(driver, log, req, res);
        if (req.method === "GET" && url.pathname === "/v1/node") {
          const info = await driver.info();
          const running = info.sandboxes.filter((s) => s.running).length;
          // Every sandbox may use 2 GB; what is left is what a new one can count on.
          const memAvailable = info.memTotal === null ? null : Math.max(0, info.memTotal - running * 2 * 1024 ** 3);
          return send(res, 200, { ...version(), ...info, memAvailable } satisfies NodeInfo);
        }
        const route = ROUTE.exec(url.pathname);
        if (!route) throw new HttpError(404, "not_found", "没有这个接口");
        const [, name, action] = route;
        if (!action && req.method === "GET") return send(res, 200, await driver.inspect(name!));
        if (req.method !== "POST" || !action || action === "spawn") throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
        const body = (await readJson(req)) as Record<string, unknown>;
        switch (action) {
          case "ensure": {
            const { spec, readyTimeoutMs } = body as unknown as EnsureRequest;
            if (spec?.name !== name) throw new HttpError(400, "bad_request", "沙箱名与参数不一致");
            return send(res, 200, await driver.ensure(spec, clampTimeout(readyTimeoutMs, 180_000)));
          }
          case "stop":
            await driver.stop(name!);
            return send(res, 200, { ok: true });
          case "restart":
            return send(res, 200, await driver.restart(name!, clampTimeout(body.readyTimeoutMs, 180_000)));
          case "peer-ports":
            await driver.peerPorts(name!, body.ports as number[]);
            return send(res, 200, { ok: true });
          case "exec":
            return send(res, 200, await driver.exec(name!, body as unknown as ExecRequest));
        }
      } catch (err) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const status = err instanceof HttpError ? err.status : 500;
        const code = err instanceof HttpError ? err.code : "failed";
        const message = err instanceof Error ? err.message : String(err);
        if (status >= 500) log.warn("request failed", { url: req.url, error: message });
        send(res, status, { error: code, message });
      }
    })();
  });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        if (!authorized(req)) throw new HttpError(401, "unauthorized", "节点令牌无效");
        if (!compatible(req)) throw new HttpError(409, "incompatible", "协议不兼容");
        if (req.headers[SANDBOX_HEADER]) return await proxyUpgrade(driver, log, req, socket, head);
        const route = ROUTE.exec(new URL(req.url ?? "/", "http://sandboxd").pathname);
        if (!route || route[2] !== "spawn") throw new HttpError(404, "not_found", "没有这个接口");
        wss.handleUpgrade(req, socket, head, (ws) => spawnSession(driver, log, route[1]!, ws));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
    })();
  });
  return server;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function clampTimeout(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30 * 60_000) : fallback;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "请求过大");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "请求不是 JSON");
  }
}

/** The request's own headers, minus the ones addressed to this node. */
function forwardedHeaders(req: http.IncomingMessage): string[] {
  const out: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (!OUR_HEADERS.has(req.rawHeaders[i]!.toLowerCase())) out.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  return out;
}

async function proxyHttp(driver: SandboxDriver, log: Logger, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const target = await driver.target(String(req.headers[SANDBOX_HEADER]));
  const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: forwardedHeaders(req) as unknown as http.OutgoingHttpHeaders });
  upstream.on("response", (up) => {
    res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    log.debug("proxy error", { error: String(err) });
    if (!res.headersSent) send(res, 502, { error: "sandbox_unreachable", message: "沙箱暂时无法连接" });
    else res.destroy();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

async function proxyUpgrade(driver: SandboxDriver, log: Logger, req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const target = await driver.target(String(req.headers[SANDBOX_HEADER]));
  const upstream = net.connect(target.port, target.host);
  const headers = forwardedHeaders(req);
  let lines = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`;
  upstream.on("connect", () => {
    upstream.write(`${lines}\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", (err) => {
    log.debug("upgrade proxy error", { error: String(err) });
    close();
  });
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
}

/** One streamed command per socket; closing the socket ends the command. */
function spawnSession(driver: SandboxDriver, log: Logger, name: string, ws: WebSocket): void {
  let child: import("node:child_process").ChildProcess | null = null;
  let started = false;
  let closed = false;
  let done = false;
  // Stdin (and eof/kill) can arrive while the command is still being started.
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  const finish = (message: SpawnServerMessage) => {
    if (done) return;
    done = true;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message), () => ws.close());
  };
  const handle = (proc: import("node:child_process").ChildProcess, data: Buffer, binary: boolean) => {
    if (binary) {
      proc.stdin?.write(data);
      return;
    }
    try {
      const msg = JSON.parse(String(data)) as SpawnClientMessage;
      if (msg.type === "eof") proc.stdin?.end();
      else if (msg.type === "kill") proc.kill((msg.signal as NodeJS.Signals | undefined) ?? "SIGTERM");
    } catch {
      log.debug("ignored malformed spawn message");
    }
  };
  const begin = async (raw: Buffer, binary: boolean) => {
    let proc: import("node:child_process").ChildProcess;
    try {
      const start = JSON.parse(String(raw)) as SpawnClientMessage;
      if (binary || start.type !== "start") throw new Error("第一条消息必须是 start");
      proc = await driver.spawn(name, start);
    } catch (err) {
      finish({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    child = proc;
    const forward = (channel: number) => (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([channel]), chunk]));
    };
    proc.stdout?.on("data", forward(STREAM_STDOUT));
    proc.stderr?.on("data", forward(STREAM_STDERR));
    proc.stdin?.on("error", () => undefined);
    proc.on("error", (err) => finish({ type: "error", message: err.message }));
    proc.on("close", (code, signal) => finish({ type: "exit", code, signal }));
    for (const m of pending.splice(0)) handle(proc, m.data, m.binary);
    if (closed) stop(proc);
  };
  const stop = (proc: import("node:child_process").ChildProcess) => {
    // The caller went away: end the command the way a closed pipe would.
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.stdin?.end();
      proc.kill("SIGTERM");
    }
  };
  ws.on("message", (data, binary) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (!started) {
      started = true;
      void begin(chunk, binary);
    } else if (!child) pending.push({ data: chunk, binary });
    else handle(child, chunk, binary);
  });
  ws.on("close", () => {
    closed = true;
    if (child) stop(child);
  });
  ws.on("error", () => ws.terminate());
}
