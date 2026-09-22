import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Config } from "../config.js";
import type { RequestContext } from "./security.js";
import { originAllowed, UNSAFE_METHODS } from "./security.js";
import { COOKIE_NAMES, parseCookies } from "../auth/sessions.js";
import type { SessionStore } from "../auth/sessions.js";
import type { Logger } from "../logger.js";

const CONTROL_COOKIES = new Set(Object.values(COOKIE_NAMES).flatMap((n) => [n.session, n.csrf]));

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request headers that belong to the control plane (or to the edge) and must never
 * be forwarded into the sandbox.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-csrf-token",
  "x-pa-csrf",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-aio-proxy-port",
  ...CONTROL_COOKIES,
]);

export interface ProxyDeps {
  cfg: Config;
  log: Logger;
  sessions: SessionStore;
}

/** Remove our own control-plane cookies before forwarding to the sandbox. */
export function filterUpstreamCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const cookies = parseCookies(header);
  const kept = Object.entries(cookies)
    .filter(([k]) => !CONTROL_COOKIES.has(k))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return kept.length ? kept.join("; ") : undefined;
}

/**
 * Sanitize an upstream Set-Cookie so sandbox cookies stay host-only on the
 * companion origin and match the request scheme. Returns null when the cookie
 * name collides with a control-plane cookie (cookie-tossing defence).
 */
export function rewriteSetCookie(value: string, secure: boolean): string | null {
  const parts = value.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf("=");
  const name = eq >= 0 ? nameValue.slice(0, eq) : nameValue;
  if (!name || CONTROL_COOKIES.has(name)) return null;

  const kept: string[] = [];
  let hasSecure = false;
  let hasPath = false;
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower.startsWith("domain=")) continue; // force host-only
    if (lower === "secure") {
      hasSecure = true;
      continue;
    }
    if (lower.startsWith("samesite=")) continue; // normalized below
    if (lower === "httponly") {
      kept.push(attr);
      continue;
    }
    if (lower.startsWith("path=")) {
      hasPath = true;
      kept.push(attr);
      continue;
    }
    kept.push(attr);
  }
  if (!hasPath) kept.push("Path=/");
  kept.push("SameSite=Lax");
  if (secure || hasSecure) kept.push("Secure");
  return [nameValue, ...kept].join("; ");
}

/** Build the CSP frame-ancestors value covering only the companion and control origins. */
export function frameAncestorsValue(cfg: Config): string {
  return `frame-ancestors 'self' https://${cfg.primaryHost}`;
}

/**
 * Sanitize response headers while preserving upstream CSP semantics. The
 * frame-ancestors directive is rewritten (not dropped) to allow exactly the
 * companion origin and the primary control-plane origin.
 */
export function sanitizeResponseHeaders(
  cfg: Config,
  headers: http.IncomingHttpHeaders,
  secure: boolean,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "x-frame-options") continue; // replaced by CSP frame-ancestors below
    if (lower === "content-security-policy") {
      const values = (Array.isArray(value) ? value : [String(value)]).map((v) => String(v));
      const policies: string[] = [];
      for (const policy of values) {
        const filtered = policy
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s && !s.toLowerCase().startsWith("frame-ancestors"))
          .join("; ");
        if (filtered) policies.push(filtered);
      }
      policies.push(frameAncestorsValue(cfg));
      out["content-security-policy"] = policies as unknown as string;
      continue;
    }
    if (lower === "set-cookie") {
      const arr = (Array.isArray(value) ? value : [String(value)])
        .map((v) => rewriteSetCookie(v, secure))
        .filter((v): v is string => v !== null);
      if (arr.length) out["set-cookie"] = arr;
      continue;
    }
    out[key] = value;
  }
  if (!out["content-security-policy"]) {
    // A lone frame-ancestors policy does not restrict scripts and prevents
    // clickjacking of the companion origin by unrelated sites.
    out["content-security-policy"] = frameAncestorsValue(cfg);
  }
  return out;
}

export function buildUpstreamHeaders(ctx: RequestContext, req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-pa-")) continue;
    headers[key] = value;
  }
  const cookie = filterUpstreamCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  headers.host = ctx.host;
  headers["x-forwarded-host"] = ctx.host;
  headers["x-forwarded-proto"] = ctx.secure ? "https" : "http";
  headers["x-forwarded-for"] = ctx.ip;
  return headers;
}

/**
 * Tear down a long-lived proxied connection when its session is revoked or
 * expires. Returns a disposer that removes the listeners.
 */
function attachSessionGuard(deps: ProxyDeps, ctx: RequestContext, destroy: () => void): () => void {
  const sessionId = ctx.session?.id;
  if (!sessionId) return () => undefined;
  const onRevoked = (id: string) => {
    if (id === sessionId) destroy();
  };
  deps.sessions.events.on("revoked", onRevoked);
  const timer = setInterval(() => {
    if (!deps.sessions.isLive(sessionId)) destroy();
  }, 30_000);
  timer.unref?.();
  return () => {
    deps.sessions.events.off("revoked", onRevoked);
    clearInterval(timer);
  };
}

/**
 * Rewrite a raw upgrade response head: sandbox cookies are filtered exactly like
 * HTTP responses so a malicious/buggy upstream cannot toss our control cookies.
 */
export function rewriteHandshakeResponse(head: string, secure: boolean): string {
  const lines = head.split("\r\n");
  const out: string[] = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) {
      out.push(line);
      continue;
    }
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name.toLowerCase() === "set-cookie") {
      const rewritten = rewriteSetCookie(value, secure);
      if (rewritten) out.push(`set-cookie: ${rewritten}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\r\n");
}

function upstreamRequestLine(req: http.IncomingMessage, ctx: RequestContext): string[] {
  const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-pa-")) continue;
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  const cookie = filterUpstreamCookie(req.headers.cookie);
  if (cookie) lines.push(`Cookie: ${cookie}`);
  lines.push(`Host: ${ctx.host}`);
  lines.push(`X-Forwarded-Host: ${ctx.host}`);
  lines.push(`X-Forwarded-Proto: ${ctx.secure ? "https" : "http"}`);
  lines.push(`X-Forwarded-For: ${ctx.ip}`);
  return lines;
}

export function handleProxyHttp(
  deps: ProxyDeps,
  ctx: RequestContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const { cfg, log } = deps;
  if (UNSAFE_METHODS.has(req.method ?? "GET")) {
    if (!ctx.origin || !originAllowed(cfg, "workspace", ctx.origin)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "origin_denied", message: "来源站点不被允许" }));
      return;
    }
  }

  const upstream = http.request({
    host: "127.0.0.1",
    port: cfg.sandbox.hostPort,
    method: req.method,
    path: req.url,
    headers: buildUpstreamHeaders(ctx, req),
  });

  // Bound connection + response-header latency only; streamed bodies stay unbounded.
  let headersReceived = false;
  const connectTimer = setTimeout(() => {
    if (!headersReceived) {
      log.warn("sandbox proxy connect/header timeout", { url: req.url, timeoutMs: cfg.proxyConnectTimeoutMs });
      upstream.destroy(new Error("upstream connect/header timeout"));
    }
  }, cfg.proxyConnectTimeoutMs);

  upstream.on("response", (upRes) => {
    headersReceived = true;
    clearTimeout(connectTimer);
    res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, sanitizeResponseHeaders(cfg, upRes.headers, ctx.secure));
    upRes.pipe(res);
  });

  upstream.on("error", (err) => {
    clearTimeout(connectTimer);
    log.warn("sandbox proxy error", { url: req.url, error: String(err) });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "sandbox_unavailable", message: "沙箱服务暂不可用，请稍后重试" }));
  });

  const detachGuard = attachSessionGuard(deps, ctx, () => {
    upstream.destroy();
    if (!res.headersSent) res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "session_revoked", message: "会话已失效，请重新登录" }));
  });

  req.pipe(upstream);
  const finish = () => {
    clearTimeout(connectTimer);
    detachGuard();
    upstream.destroy();
  };
  res.on("close", finish);
  req.on("aborted", finish);
}

/** Raw TCP upgrade proxy for WebSocket / CDP connections. */
export function handleProxyUpgrade(
  deps: ProxyDeps,
  ctx: RequestContext,
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const { cfg, log } = deps;
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? (originHeader[0] ?? null) : (originHeader ?? null);
  if (!origin || !originAllowed(cfg, "workspace", origin)) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstream = net.connect(cfg.sandbox.hostPort, "127.0.0.1");
  let handshakeDone = false;
  const connectTimer = setTimeout(() => {
    if (handshakeDone) return;
    log.warn("sandbox upgrade handshake timeout", { url: req.url });
    upstream.destroy();
    clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
  }, cfg.proxyConnectTimeoutMs);

  let closed = false;
  let detachGuard: () => void = () => undefined;
  const close = (why: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    detachGuard();
    log.debug("upgrade proxy closed", { url: req.url, why });
    upstream.destroy();
    clientSocket.destroy();
  };

  detachGuard = attachSessionGuard(deps, ctx, () => close("session-revoked"));

  // Buffer the upstream handshake so cookies can be filtered before the client
  // sees them, then switch to raw piping for the rest of the session.
  /**
   * Copy between sockets with backpressure handling: a long VNC/CDP session must
   * not buffer unbounded data in memory when one side is slower.
   */
  const pipeWithBackpressure = (from: Duplex, to: Duplex) => {
    let paused = false;
    const onData = (chunk: Buffer) => {
      if (to.destroyed || from.destroyed) return;
      if (to.write(chunk) === false) {
        paused = true;
        from.pause();
        to.once("drain", () => {
          paused = false;
          if (!from.destroyed) from.resume();
        });
      }
    };
    from.on("data", onData);
    from.on("end", () => {
      if (!to.destroyed) to.end();
    });
    return () => {
      from.off("data", onData);
      if (paused) from.resume();
    };
  };

  // Buffer the upstream handshake so cookies can be filtered before the client
  // sees them, then switch to raw piping for the rest of the session.
  let pending = Buffer.alloc(0);
  const onUpstreamData = (chunk: Buffer) => {
    if (handshakeDone) return;
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0) {
      if (pending.length > 64 * 1024) close("handshake-too-large");
      return;
    }
    handshakeDone = true;
    clearTimeout(connectTimer);
    const headText = pending.subarray(0, end).toString("latin1");
    const rest = pending.subarray(end + 4);
    pending = Buffer.alloc(0);
    if (!clientSocket.destroyed) {
      clientSocket.write(rewriteHandshakeResponse(headText, ctx.secure) + "\r\n\r\n");
      if (rest.length) clientSocket.write(rest);
    }
    upstream.off("data", onUpstreamData);
    // From here on both directions stream with backpressure handling.
    pipeWithBackpressure(upstream, clientSocket);
    pipeWithBackpressure(clientSocket, upstream);
  };

  upstream.on("connect", () => {
    upstream.write(upstreamRequestLine(req, ctx).join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.on("data", onUpstreamData);
    // Client bytes that arrive before the handshake completes stay buffered by
    // the paused socket and are released once the upstream is ready.
    clientSocket.pause();
    const release = () => {
      if (!upstream.destroyed) clientSocket.resume();
    };
    upstream.once("data", release);
    upstream.once("close", release);
  });

  upstream.on("error", () => close("upstream-error"));
  upstream.on("end", () => close("upstream-end"));
  clientSocket.on("error", () => close("client-error"));
  clientSocket.on("end", () => close("client-end"));
  clientSocket.on("close", () => close("client-close"));
  upstream.on("close", () => close("upstream-close"));
}
