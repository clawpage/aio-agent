import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { Config } from "../config.js";
import type { SandboxUpstream } from "../sandbox/node.js";
import type { RequestContext } from "./security.js";
import { originAllowed, UNSAFE_METHODS } from "./security.js";
import { COOKIE_NAMES, parseCookies } from "../auth/sessions.js";
import type { SessionStore } from "../auth/sessions.js";
import type { Logger } from "../../common/logger.js";
import { isBrowserBoundPath, isStaticAssetPath } from "../browser/service.js";

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
  /** The sandbox's web port, reached through its node. */
  upstream: SandboxUpstream;
  /** Called on client bytes of a proxied socket (typing in a workspace tab); an open socket alone is not use. */
  activity?: () => void;
  /**
   * Optional browser lifecycle gate. When present, a request whose path is
   * genuinely browser/CDP/VNC bound holds a lease for the whole connection, so
   * the browser cannot be released out from under an in-flight navigation or an
   * open VNC/CDP socket. Terminal, file, code-server and Jupyter traffic is never
   * protected, and neither is an iframe's static assets.
   */
  browser?: BrowserCallGate | null;
}

/** The slice of the browser service the proxy needs; keeps this module decoupled. */
export interface BrowserCallGate {
  /** Reserve synchronously; returns the release function. */
  reserveCall(): () => void;
  /** Resolve once the browser is usable; rejects fail-closed. */
  ready(): Promise<void>;
}

/**
 * True when this request should hold the browser awake: the path must be
 * browser-bound, and must not be a static asset the panel merely renders. This is
 * what stops a long-lived iframe from holding the browser up through its own
 * images/scripts while still protecting a real navigation or an API call.
 */
export function shouldProtectBrowser(url: string | undefined): boolean {
  if (!url) return false;
  return isBrowserBoundPath(url) && !isStaticAssetPath(url);
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
    // Control-plane and node headers are only ever set here, never taken from the client.
    if (lower.startsWith("x-pa-") || lower.startsWith("x-aio-")) continue;
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

/**
 * Write a complete HTTP response on a raw socket and close it after the write is
 * flushed. `write()` followed immediately by `destroy()` can truncate the bytes,
 * which an edge proxy reports as 502 instead of the real status code.
 */
export function endSocket(socket: Duplex, response: string): void {
  if (socket.destroyed) return;
  socket.end(response);
  const timer = setTimeout(() => socket.destroy(), 2000);
  timer.unref?.();
  socket.on("close", () => clearTimeout(timer));
}

function upstreamRequestLine(req: http.IncomingMessage, ctx: RequestContext, upstream: SandboxUpstream): string[] {
  const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-pa-") || lower.startsWith("x-aio-")) continue;
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
  for (const [key, value] of Object.entries(upstream.headers)) lines.push(`${key}: ${value}`);
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

  // Browser-bound traffic holds the browser awake for the connection's lifetime.
  // The lease is reserved synchronously, before the upstream call is even queued,
  // so an idle release can never win the race. A released browser is rebuilt
  // first, which is what makes a hidden panel's navigation work on re-show.
  const browserGate = deps.browser && shouldProtectBrowser(req.url) ? deps.browser.reserveCall() : null;
  const forward = () => proxyHttpUpstream(deps, ctx, req, res, browserGate);
  if (!browserGate || !deps.browser) {
    forward();
    return;
  }
  // The wake can take seconds. Attach the disconnect guard *before* awaiting it,
  // so a client that goes away while the browser is being rebuilt does not later
  // start a ghost upstream request and leak the call lease.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    browserGate();
  };
  let clientGone = false;
  const onClientGone = () => {
    clientGone = true;
    releaseOnce();
  };
  res.on("close", onClientGone);
  req.on("aborted", onClientGone);
  // A logout during the wait must abort too, exactly like an in-flight proxy.
  const detachEarlyGuard = attachSessionGuard(deps, ctx, () => {
    clientGone = true;
    releaseOnce();
    if (!res.headersSent) res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "session_revoked", message: "会话已失效，请重新登录" }));
  });
  void (async () => {
    try {
      await deps.browser!.ready();
    } catch (err) {
      releaseOnce();
      detachEarlyGuard();
      res.off("close", onClientGone);
      req.off("aborted", onClientGone);
      log.warn("browser unavailable for proxied request", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "browser_unavailable", message: "浏览器正在恢复，请稍后重试" }));
      return;
    }
    // The wait is over: hand the remaining lifetime to the upstream pass, which
    // installs its own guards. Drop ours so nothing is released twice.
    detachEarlyGuard();
    res.off("close", onClientGone);
    req.off("aborted", onClientGone);
    if (clientGone || res.writableEnded || res.destroyed || req.socket.destroyed) {
      // The client left (or logged out) while we were waiting: never start a
      // ghost upstream. The lease was already released exactly once.
      releaseOnce();
      return;
    }
    forward();
  })();
}

/** The actual reverse-proxy pass; split out so the browser gate can await first. */
function proxyHttpUpstream(
  deps: ProxyDeps,
  ctx: RequestContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  releaseBrowser: (() => void) | null,
): void {
  const { cfg, log } = deps;

  const node = deps.upstream;
  const upstream = (node.url.protocol === "https:" ? https : http).request({
    host: node.url.hostname,
    port: nodePort(node.url),
    method: req.method,
    path: req.url,
    headers: { ...buildUpstreamHeaders(ctx, req), ...node.headers },
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
    releaseBrowser?.();
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
  // Reserve before the origin check so the boot race is consistent, and keep the
  // lease for the socket's whole life: an open CDP/VNC session is real browser
  // use, and dropping the lease mid-session would release the target under it.
  const releaseBrowser = deps.browser && shouldProtectBrowser(req.url) ? deps.browser.reserveCall() : null;
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? (originHeader[0] ?? null) : (originHeader ?? null);
  if (!origin || !originAllowed(cfg, "workspace", origin)) {
    // Release the lease we just reserved: this connection never opened, so
    // holding it would keep the browser awake for a rejected request.
    releaseBrowser?.();
    // end() flushes the response before FIN; write()+destroy() could truncate it
    // and make the edge report a 502 instead of the real 403.
    endSocket(clientSocket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  // The browser may be asleep: a direct CDP/VNC connection must restore it first,
  // so the gate is awaited before the upstream socket is opened. Guards for a
  // client that leaves during that wait are attached *before* awaiting.
  let closed = false;
  let detachGuard: () => void = () => undefined;
  let upstream: net.Socket | null = null;
  let close = (why: string) => {
    if (closed) return;
    closed = true;
    detachGuard();
    releaseBrowser?.();
    log.debug("upgrade proxy closed", { url: req.url, why });
    upstream?.destroy();
    clientSocket.destroy();
  };
  detachGuard = attachSessionGuard(deps, ctx, () => close("session-revoked"));
  const onClientGone = () => close("client-gone");
  clientSocket.on("close", onClientGone);
  clientSocket.on("error", onClientGone);
  clientSocket.on("end", onClientGone);

  void (async () => {
    if (releaseBrowser && deps.browser) {
      try {
        await deps.browser.ready();
      } catch (err) {
        log.warn("browser unavailable for proxied upgrade", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!closed) {
          endSocket(
            clientSocket,
            "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        }
        close("browser-unavailable");
        return;
      }
    }
    // The client may have gone away while the browser was being rebuilt: never
    // open a ghost upstream for a socket nobody is reading.
    if (closed || clientSocket.destroyed || clientSocket.writableEnded) {
      close("client-gone-during-ready");
      return;
    }

    const node = deps.upstream;
    const upstreamSocket: net.Socket =
      node.url.protocol === "https:"
        ? tls.connect({ host: node.url.hostname, port: nodePort(node.url), servername: node.url.hostname })
        : net.connect(nodePort(node.url), node.url.hostname);
    upstream = upstreamSocket;
    let handshakeDone = false;
    const connectTimer = setTimeout(() => {
      if (handshakeDone) return;
      log.warn("sandbox upgrade handshake timeout", { url: req.url });
      upstreamSocket.destroy();
      endSocket(clientSocket, "HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }, cfg.proxyConnectTimeoutMs);
    // `close` was defined before the socket existed; rebind it so the timer and
    // the upstream socket are torn down on every path (including a session
    // revoke that landed while we were waiting for the browser).
    close = (why: string) => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      detachGuard();
      clientSocket.off("close", onClientGone);
      releaseBrowser?.();
      log.debug("upgrade proxy closed", { url: req.url, why });
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    if (closed) {
      close("client-gone-during-ready");
      return;
    }
    /**
     * Copy between sockets with backpressure handling: a long VNC/CDP session must
     * not buffer unbounded data in memory when one side is slower.
     */
    const pipeWithBackpressure = (from: Duplex, to: Duplex) => {
      const onData = (chunk: Buffer) => {
        if (to.destroyed || from.destroyed) return;
        if (to.write(chunk) === false) {
          from.pause();
          to.once("drain", () => {
            if (!from.destroyed) from.resume();
          });
        }
      };
      from.on("data", onData);
      from.on("end", () => {
        if (!to.destroyed) to.end();
      });
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
      upstreamSocket.off("data", onUpstreamData);
      // From here on both directions stream with backpressure handling.
      pipeWithBackpressure(upstreamSocket, clientSocket);
      pipeWithBackpressure(clientSocket, upstreamSocket);
      if (deps.activity) clientSocket.on("data", deps.activity);
    };

    upstreamSocket.on(node.url.protocol === "https:" ? "secureConnect" : "connect", () => {
      upstreamSocket.write(upstreamRequestLine(req, ctx, node).join("\r\n") + "\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.on("data", onUpstreamData);
      // Client bytes that arrive before the handshake completes stay buffered by
      // the paused socket and are released once the upstream is ready.
      clientSocket.pause();
      const release = () => {
        if (!upstreamSocket.destroyed) clientSocket.resume();
      };
      upstreamSocket.once("data", release);
      upstreamSocket.once("close", release);
    });

    upstreamSocket.on("error", () => close("upstream-error"));
    upstreamSocket.on("end", () => close("upstream-end"));
    clientSocket.on("error", () => close("client-error"));
    clientSocket.on("end", () => close("client-end"));
    clientSocket.on("close", () => close("client-close"));
    upstreamSocket.on("close", () => close("upstream-close"));
  })();
}

function nodePort(url: URL): number {
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}
