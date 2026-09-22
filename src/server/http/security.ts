import type { IncomingMessage } from "node:http";
import type { Config } from "../config.js";
import type { Session, SessionKind, SessionStore } from "../auth/sessions.js";
import { COOKIE_NAMES, parseCookies } from "../auth/sessions.js";

export type HostKind = "primary" | "workspace";

export interface RequestContext {
  kind: HostKind;
  host: string;
  hostname: string;
  secure: boolean;
  origin: string | null;
  session: Session | null;
  cookies: Record<string, string>;
  ip: string;
}

function stripPort(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const idx = h.lastIndexOf(":");
  return idx > 0 ? h.slice(0, idx) : h;
}

export function hostnameOf(host: string | undefined): string {
  return stripPort((host ?? "").trim().toLowerCase());
}

export function normalizeHost(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Decide which logical site a request belongs to, or null for an unknown Host.
 * Local development uses `localhost` for the primary site and `127.0.0.1` for the
 * companion workspace site so that host-only cookies stay separate.
 */
export function classifyHost(cfg: Config, hostHeader: string | undefined): HostKind | null {
  const host = normalizeHost(hostHeader);
  if (!host) return null;
  if (!cfg.allowedHosts.includes(host)) return null;
  const hostname = hostnameOf(host);
  if (hostname === cfg.workspaceHost.toLowerCase()) return "workspace";
  if (hostname === cfg.primaryHost.toLowerCase()) return "primary";
  if (isLoopback(hostname)) {
    // 127.0.0.1 is the development companion origin; localhost is the control plane.
    return hostname === "127.0.0.1" ? "workspace" : "primary";
  }
  return null;
}

export function isSecureRequest(cfg: Config, req: IncomingMessage): boolean {
  const proto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto === "https") return true;
  if (proto === "http") return isSecureFallback(cfg, req);
  return isSecureFallback(cfg, req);
}

/**
 * Loopback plain HTTP is the only non-TLS case we tolerate, and only when the
 * operator has not disabled the local-test escape hatch.
 */
function isSecureFallback(cfg: Config, req: IncomingMessage): boolean {
  const hostname = hostnameOf(normalizeHost(req.headers.host));
  if (isLoopback(hostname)) return !cfg.allowInsecureLoopbackCookies;
  return true;
}

export function originAllowed(cfg: Config, kind: HostKind, origin: string | null): boolean {
  if (!origin) return false;
  const list = kind === "primary" ? cfg.primaryOrigins : cfg.workspaceOrigins;
  const normalized = origin.replace(/\/+$/, "").toLowerCase();
  return list.some((o) => o.replace(/\/+$/, "").toLowerCase() === normalized);
}

export interface ResolveOptions {
  cfg: Config;
  sessions: SessionStore;
  req: IncomingMessage;
}

/**
 * Build the per-request security context. Returns null when the Host is unknown
 * or when the forwarded host disagrees with the Host header (header smuggling).
 */
export function resolveRequest(opts: ResolveOptions): RequestContext | null {
  const { cfg, sessions, req } = opts;
  const hostHeader = normalizeHost(req.headers.host);
  const kind = classifyHost(cfg, hostHeader);
  if (!kind) return null;

  const forwardedHost = req.headers["x-forwarded-host"];
  if (forwardedHost) {
    const raw = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    const fh = normalizeHost(raw);
    if (fh && fh !== hostHeader) return null;
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAMES[kind].session];
  const session = sessions.resolve(kind, token);
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? (originHeader[0] ?? null) : (originHeader ?? null);

  return {
    kind,
    host: hostHeader,
    hostname: hostnameOf(hostHeader),
    secure: isSecureRequest(cfg, req),
    origin,
    session,
    cookies,
    ip: clientIp(req, cfg.trustCfConnectingIp),
  };
}

export function clientIp(req: IncomingMessage, trustCfConnectingIp = false): string {
  // Behind the dedicated Cloudflare tunnel the edge overwrites CF-Connecting-IP.
  // Outside that mode we deliberately ignore all forwarded headers, which a
  // direct client could spoof to escape login rate limiting.
  if (trustCfConnectingIp) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) {
      const first = String(Array.isArray(cf) ? cf[0] : cf).split(",")[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface GuardResult {
  ok: boolean;
  status: number;
  code: string;
  message: string;
}

/**
 * Origin guard for state-changing requests.
 *
 * `csrfToken` is required (double-submit) on the control plane, where our own SPA
 * always sends the header. On the companion AIO origin we rely on the
 * SameSite=Lax host-only session cookie plus this Origin allowlist, because
 * third-party AIO web UIs cannot be expected to emit our CSRF header.
 */
export function guardUnsafe(
  cfg: Config,
  ctx: RequestContext,
  csrfToken: string | undefined,
  sessions: SessionStore,
  opts: { requireCsrf: boolean },
): GuardResult {
  if (!ctx.origin) {
    return { ok: false, status: 403, code: "origin_missing", message: "缺少 Origin 头，已拒绝该请求" };
  }
  if (!originAllowed(cfg, ctx.kind, ctx.origin)) {
    return { ok: false, status: 403, code: "origin_denied", message: "来源站点不被允许" };
  }
  if (opts.requireCsrf) {
    if (!ctx.session || !sessions.verifyCsrf(ctx.session, csrfToken)) {
      return { ok: false, status: 403, code: "csrf_invalid", message: "CSRF 校验失败，请刷新页面重试" };
    }
  }
  return { ok: true, status: 200, code: "ok", message: "ok" };
}
