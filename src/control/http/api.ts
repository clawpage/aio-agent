import {workspacePrefix} from "../auth/workspaceHost.js";
import {usageReport} from '../usage.js';
import { isMember, publicPayload } from "../auth/policy.js";
import {readSoul,writeSoul,SoulError,DEFAULT_SOUL,SOUL_MAX_BYTES} from '../soul.js';
import { HTML_PREVIEW_CSP, htmlPreviewDocument } from "../documents/html.js";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { exitTerminal, TERMINAL_ID, TerminalRegistry } from "../terminals.js";
import { maps, MapService } from "../maps.js";
import { CameraError, parseLocal, type HaCameras } from "../camera.js";
import { API_MIN, API_VERSION } from "../../common/version.js";
import { TASK_FILTERS, type TaskFilter } from "../../common/taskList.js";
import { TaskCursorError } from "../tasks/service.js";
import { appVersion } from "../../common/build.js";
import { readSecretFile } from "../../common/secrets.js";
import fs from "node:fs";
import { readFirmware } from "../gadgetFirmware.js";
import { Dictation, DictationError, DICTATION_MAX_CHARS } from "../dictation.js";
import { VoiceLog, type VoiceRecord } from "../voiceLog.js";
import type { AppContext } from "../context.js";
import { DataError } from "../clawpages.js";
import { SHARE_NAME } from "../share.js";
import {
  InvalidConversationTitleError,
  normalizeConversationTitle,
  TurnConflictError,
  TurnInputUnsupportedError,
} from "../codex/manager.js";
import type { AgentEvent } from "../codex/manager.js";
import type { HostKind, RequestContext } from "./security.js";
import { UNSAFE_METHODS, guardUnsafe, originAllowed } from "./security.js";
import { BOOTSTRAP_USERNAME, authenticateUser, getUser } from "../auth/owner.js";
import { visibleEmail } from "../auth/email.js";
import { CLIENT_EVENTS } from "../../common/analytics.js";
import { RegisterError, createInvite, listInvites, registerWithInvite, registrationRequiresInvite, revokeInvite } from "../auth/invites.js";
import { googleRouter } from "../auth/googleRoutes.js";
import { followLoginTimezone } from "../auth/loginTimezone.js";
import { createSupportRequest, reviewSupportRequest, supportQueue, SupportError } from '../support.js';
import { parseHttpUrl } from "../aio/client.js";
import { COOKIE_NAMES, clearSessionCookies, sessionCookies } from "../auth/sessions.js";
import { safeRedirectPath } from "../auth/tickets.js";
import { audit } from "../db.js";
import { dispatchLog, recallStats } from "../tasks/recall.js";
import { PERSON_KEY } from "../browser/tabs.js";
import { normalizeSite, vaultLogin, VaultError, type Vault } from "../vault.js";
import { DocumentError } from "../documents/service.js";
import { isLocale, type Locale } from "../locale.js";
import { t } from "../i18n/index.js";
import type { BrowserStatusView } from "../browser/service.js";
import { documentKind, isRenderableKind, mediaType, requireWorkspaceFilePath } from "../documents/paths.js";

/** The console languages the speech server understands. */
const ASR_LOCALES: Locale[] = ["zh-CN", "zh-TW", "en"];

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      paCtx?: RequestContext;
      paRawBody?: string;
    }
  }
}

type Handler = (req: Request, res: Response, ctx: RequestContext) => Promise<void> | void;

function ctxOf(req: Request): RequestContext {
  return req.paCtx as RequestContext;
}

/** Express 5 types route params as string | string[]; normalize to a single string. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const asyncHandler =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        await fn(req, res, ctxOf(req));
      } catch (err) {
        next(err);
      }
    })();
  };

function requireKind(kind: HostKind) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = ctxOf(req);
    if (ctx.kind !== kind) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    next();
  };
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const ctx = ctxOf(req);
  if (!ctx.session) {
    res.status(401).json({ error: "unauthenticated", message: t().http.common.signInFirst });
    return;
  }
  next();
}

/** CSRF is enforced by the router-level middleware below; the companion origin
 * relies on its Origin allowlist because third-party sandbox UIs cannot send our
 * CSRF header. */

export function workspaceOrigin(ctx: RequestContext, cfg: AppContext["cfg"]): string {
  if (ctx.hostname === cfg.workspaceHost.toLowerCase()) {
    return `${ctx.secure ? "https" : "http"}://${cfg.workspaceHost}`;
  }
  if (ctx.hostname === "127.0.0.1" || ctx.hostname === "localhost" || ctx.hostname === "[::1]") {
    return `http://127.0.0.1:${cfg.port}`;
  }
  return `https://${cfg.workspaceHost}`;
}

/**
 * Public, secret-free view of the browser lifecycle for the control-plane UI.
 *
 * It deliberately exposes only counts, a state label in the request's language and an idle
 * deadline: the snapshot path, page URLs, cookies and storage values never leave
 * the server, and the raw container message is replaced by a fixed sentence
 * keyed on the stable error code.
 */
function browserStatusPayload(status: BrowserStatusView): Record<string, unknown> {
  const idleRemainingMs = status.idleDeadline === null ? null : Math.max(0, status.idleDeadline - Date.now());
  return {
    enabled: status.enabled,
    resident: status.resident,
    state: status.state,
    stateLabel: browserStateLabel(status.state),
    idleDeadline: status.idleDeadline,
    idleRemainingMs,
    idleMinutes: idleRemainingMs === null ? null : Math.ceil(idleRemainingMs / 60_000),
    since: status.since,
    epoch: status.epoch,
    leases: status.leases,
    viewers: status.viewerCount,
    holds: status.leases.holds,
    pins: status.pins ?? [],
    held: status.leases.turns + status.leases.calls + status.leases.viewers + status.leases.holds > 0,
    browserRunning: status.browserRunning,
    snapshotAt: status.snapshotAt,
    restoredSnapshotAt: status.restoredSnapshotAt ?? null,
    restorePending: status.restorePending ?? false,
    lastError: status.lastError,
    lastErrorCode: status.lastErrorCode,
    lastSnapshotWarnings: status.lastSnapshotWarnings,
    unrestoredTabCount: status.unrestoredTabCount,
  };
}

/** The state label shown in the browser panel, in the request's language; never a machine identifier. */
export function browserStateLabel(state: string): string {
  const labels: Record<string, string> = t().http.browser.states;
  return Object.hasOwn(labels, state) ? labels[state]! : state;
}

export function createApiRouter(context: AppContext): Router {
  const router = express.Router();
  const { cfg, sessions, tickets, limiter, agent, aio, container, hostTokens, db, log } = context;

  /**
   * Cross-origin access is granted to exactly two companion endpoints that the
   * control plane must call from a different origin: reading the companion
   * session and renewing it. Sandbox writes are never cross-origin enabled.
   */
  const companionCorsPaths = new Set(["/workspace/session", "/workspace/refresh"]);
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!companionCorsPaths.has(req.path)) {
      next();
      return;
    }
    const origin = req.get("origin");
    if (origin && cfg.primaryOrigins.some((o) => o.replace(/\/+$/, "") === origin.replace(/\/+$/, ""))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-client-platform, x-aio-locale");
      res.setHeader("Access-Control-Allow-Methods", req.path === "/workspace/refresh" ? "POST,OPTIONS" : "GET,OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  router.use((req, res, next) => {
    const ctx = ctxOf(req);
    if (!ctx.session) {
      next();
      return;
    }
    if (UNSAFE_METHODS.has(req.method)) {
      // Companion renewal is invoked from the control-plane origin; it is the one
      // explicitly allowed cross-origin write and carries no user payload.
      const isCompanionRenew =
        req.path === "/workspace/refresh" &&
        ctx.kind === "workspace" &&
        Boolean(ctx.origin) &&
        cfg.primaryOrigins.some((o) => o.replace(/\/+$/, "") === (ctx.origin ?? "").replace(/\/+$/, ""));
      if (isCompanionRenew) {
        next();
        return;
      }
      const requireCsrf = ctx.kind === "primary";
      const result = guardUnsafe(cfg, ctx, req.get("x-csrf-token") ?? undefined, sessions, { requireCsrf });
      if (!result.ok) {
        res.status(result.status).json({ error: result.code, message: result.message });
        return;
      }
    }
    next();
  });

  // Identity-scoped ledger access. Shared sandbox surfaces remain trusted-user facilities.
  router.use((req, res, next) => {
    const ctx = ctxOf(req);
    if (!ctx.session) { next(); return; }
    const user = getUser(db, ctx.session.ownerId);
    if (!user) { res.status(401).json({ error: "unauthenticated" }); return; }
    const restricted = user.role !== "owner";
    const pathname = req.path.toLowerCase().replace(/\/+$/, "");
    const ownerPaths = ["/usage", "/analytics/report", "/settings", "/models", "/capabilities", "/sandbox/context", "/documents/provision", "/gadget/history"];
    if (restricted && ownerPaths.some(p => pathname === p || pathname.startsWith(p + "/"))) {
      res.status(403).json({ error: "forbidden", message: t().http.common.ownerOnly }); return;
    }
    const match = /^\/(conversations|tasks)\/([^/]+)/i.exec(req.path);
    if (match) {
      const id = decodeURIComponent(match[2]);
      const own = match[1].toLowerCase() === "tasks" ? context.tasks.belongsTo(id, user.id) : agent.getConversation(id)?.owner_id === user.id;
      if (!own) { res.status(404).json({ error: "not_found" }); return; }
    }
    const approval = /^\/approvals\/([^/]+)\/respond/i.exec(req.path);
    if (approval) {
      const row = db.prepare("SELECT c.owner_id FROM server_requests r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=?").get(decodeURIComponent(approval[1])) as {owner_id:string}|undefined;
      if (row?.owner_id !== user.id) { res.status(404).json({ error: "not_found" }); return; }
    }
    if (restricted) {
      const json = res.json.bind(res);
      res.json = (body: unknown) => json(publicPayload(body));
      // Legacy free-form conversations are owner-only; member execution always uses tasks.
      if (pathname === "/conversations" && req.method !== "GET") {
        res.status(403).json({ error: "forbidden", message: t().http.common.useMainChat }); return;
      }
    }
    next();
  });

  // ------------------------------------------------------------------ auth
  // Public requests need a same-site Origin even without a signed-in session.
  // The bounded IP bucket is transient and does not write contact/IP data to logs.
  const publicRequests = new Map<string, { since: number; count: number }>();
  /** Record a product analytics event for the request's account (see src/control/analytics.ts). */
  const track = (req: Request, name: string, props?: Record<string, unknown>, userId?: string) =>
    context.analytics?.track(name, { userId: userId ?? ctxOf(req).session?.ownerId ?? null, platform: req.get("x-client-platform"), props });
  router.post('/support/requests', requireKind('primary'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    if (!ctx.origin || !originAllowed(cfg, ctx.kind, ctx.origin)) { res.status(403).json({error:'origin_denied'}); return; }
    if (!ctx.session) {
      const now = Date.now();
      for (const [key, value] of publicRequests) if (now - value.since > 3600000) publicRequests.delete(key);
      const bucket = publicRequests.get(ctx.ip) ?? {since: now, count: 0};
      if (bucket.count >= 4 || publicRequests.size >= 1000 && !publicRequests.has(ctx.ip)) { res.status(429).json({error:'rate_limited',message:t().http.common.tooFrequent}); return; }
      bucket.count++; publicRequests.set(ctx.ip, bucket);
    }
    try {
      const userId = ctx.session?.ownerId ?? null;
      const taskDb = req.body?.kind === 'content' && userId && context.runtimeForUser ? (await context.runtimeForUser(userId)).db : db;
      if (ctx.session && !sessions.isLive(ctx.session.id)) { res.status(401).json({error:'unauthenticated'}); return; }
      const id = createSupportRequest(db, userId, req.body ?? {}, Date.now(), taskDb);
      track(req, "support_request", { kind: req.body?.kind });
      res.status(201).json({id});
    } catch (err) {
      if (!(err instanceof SupportError)) throw err;
      res.status(err.status).json({error:err.code,message:err.message});
    }
  }));
  router.get('/settings/support', requireKind('primary'), requireSession, (_req, res) => {
    res.setHeader('Cache-Control','no-store'); res.json({requests:supportQueue(db)});
  });
  router.post('/settings/support/:id/review', requireKind('primary'), requireSession, (req, res) => {
    try { reviewSupportRequest(db, param(req,'id'), req.body?.decision); res.json({ok:true}); }
    catch (err) { if (!(err instanceof SupportError)) throw err; res.status(err.status).json({error:err.code,message:err.message}); }
  });
  router.use("/auth/google", googleRouter(context));
  // Events the console reports (src/common/analytics.ts). Signed out, only the sign-in page's view is
  // accepted, from this site and at most a few per address per hour; signed in, a few hundred per account.
  const reported = new Map<string, { since: number; count: number }>();
  router.post('/analytics', requireKind('primary'), (req, res) => {
    const ctx = ctxOf(req);
    const name = req.body?.name;
    if (!(CLIENT_EVENTS as readonly string[]).includes(name) || (!ctx.session && name !== 'auth_view')) { res.status(400).json({ error: 'bad_event' }); return; }
    if (!ctx.session && (!ctx.origin || !originAllowed(cfg, ctx.kind, ctx.origin))) { res.status(403).json({ error: 'origin_denied' }); return; }
    const now = Date.now(), key = ctx.session?.ownerId ?? `ip:${ctx.ip}`, limit = ctx.session ? 300 : 30;
    for (const [k, v] of reported) if (now - v.since > 3600000) reported.delete(k);
    const bucket = reported.get(key) ?? { since: now, count: 0 };
    if (bucket.count >= limit || (reported.size >= 5000 && !reported.has(key))) { res.status(429).json({ error: 'rate_limited' }); return; }
    bucket.count++; reported.set(key, bucket);
    track(req, name, req.body?.props);
    res.status(204).end();
  });
  router.get('/analytics/report', requireKind('primary'), requireSession, (req, res) => {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (![7,30,90].includes(days)) { res.status(400).json({error:'invalid_days',message:t().http.common.badDays}); return; }
    if (!context.analytics) { res.status(404).json({ error: 'not_found' }); return; }
    res.setHeader('Cache-Control','no-store');
    res.json(context.analytics.report(cfg, days));
  });
  router.get('/usage', requireKind('primary'), requireSession, asyncHandler(async (req, res) => {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (![7,30,90].includes(days)) { res.status(400).json({error:'invalid_days',message:t().http.common.badDays}); return; }
    res.setHeader('Cache-Control','no-store');
    res.json(usageReport(db,cfg,days));
  }));

  router.post(
    "/auth/login",
    requireKind("primary"),
    asyncHandler(async (req, res, ctx) => {
      // Login is unauthenticated, so it cannot rely on the session-bound CSRF
      // check above; validate Origin explicitly to block cross-site logins.
      if (!ctx.origin || !originAllowed(cfg, "primary", ctx.origin)) {
        res.status(403).json({ error: "origin_denied", message: t().http.common.originDenied });
        return;
      }
      const state = limiter.state(ctx.ip);
      if (state.locked) {
        res.status(429).json({
          error: "rate_limited",
          message: t().http.auth.retryIn(Math.ceil(state.retryAfterMs / 60000)),
        });
        return;
      }
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!password) {
        res.status(400).json({ error: "password_required", message: t().http.auth.passwordRequired });
        return;
      }
      // An account signs in with its email; accounts from before email also with their username.
      const given = typeof req.body?.email === "string" ? req.body.email : req.body?.username;
      const identifier = typeof given === "string" && given.trim() ? given.trim() : BOOTSTRAP_USERNAME;
      const owner = await authenticateUser(db, identifier, password);
      if (!owner) {
        const after = limiter.recordFailure(ctx.ip);
        audit(db, "login_failed", `failures=${after.failures}`, ctx.ip);
        track(req, "login_failed", { method: "password" });
        res.status(401).json({
          error: "invalid_credentials",
          message: after.locked ? t().http.auth.locked : t().http.auth.wrongPassword,
        });
        return;
      }
      limiter.recordSuccess(ctx.ip);
      const { session, token, csrfToken } = sessions.create(owner.id, "primary", {
        ip: ctx.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      res.setHeader("Set-Cookie", sessionCookies("primary", token, csrfToken, { secure: ctx.secure, ttlMs: cfg.sessionTtlMs }));
      audit(db, "login_ok", owner.username, ctx.ip);
      track(req, "login", { method: "password", with: identifier.includes("@") ? "email" : "username" }, owner.id);
      log.info("user logged in", { ip: ctx.ip });
      followLoginTimezone(context, owner.id, req.body?.timeZone);
      res.json({ ok: true, username: owner.username, role: owner.role, expiresAt: session.expiresAt });
    }),
  );

  // Self-registration is open for the first 20 accounts, then requires an invite.
  router.post(
    "/auth/register",
    requireKind("primary"),
    asyncHandler(async (req, res, ctx) => {
      // Unauthenticated like login: no session-bound CSRF, so check Origin explicitly.
      if (!ctx.origin || !originAllowed(cfg, "primary", ctx.origin)) {
        res.status(403).json({ error: "origin_denied", message: t().http.common.originDenied });
        return;
      }
      const state = limiter.state(ctx.ip);
      if (state.locked) {
        res.status(429).json({ error: "rate_limited", message: t().http.auth.retryIn(Math.ceil(state.retryAfterMs / 60000)) });
        return;
      }
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      let user;
      try {
        user = await registerWithInvite(db, { email: str(req.body?.email), password: str(req.body?.password), code: str(req.body?.inviteCode) });
      } catch (err) {
        if (!(err instanceof RegisterError)) throw err;
        // Guessing codes counts like guessing passwords.
        if (err.code === "invalid_invite" || err.code === "invite_used") {
          const after = limiter.recordFailure(ctx.ip);
          audit(db, "register_failed", `${err.code} failures=${after.failures}`, ctx.ip);
        }
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      limiter.recordSuccess(ctx.ip);
      const { session, token, csrfToken } = sessions.create(user.id, "primary", { ip: ctx.ip, userAgent: req.get("user-agent") ?? undefined });
      res.setHeader("Set-Cookie", sessionCookies("primary", token, csrfToken, { secure: ctx.secure, ttlMs: cfg.sessionTtlMs }));
      audit(db, "register_ok", user.username, ctx.ip);
      track(req, "signup", { method: "password", invite: Boolean(str(req.body?.inviteCode).trim()) }, user.id);
      log.info("user registered", { ip: ctx.ip });
      followLoginTimezone(context, user.id, req.body?.timeZone);
      res.json({ ok: true, username: user.username, email: user.email, role: user.role, expiresAt: session.expiresAt });
    }),
  );

  router.post(
    "/auth/logout",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const session = ctx.session!;
      // A signed-out window can no longer be watching the browser, so drop every
      // viewer lease it held (primary and any linked companion session) instead of
      // waiting for the TTL to expire.
      context.browser.releaseViewersForSession(session.id);
      for (const linked of sessions.linkedIds(session.id)) context.browser.releaseViewersForSession(linked);
      sessions.revoke(session.id, "logout");
      sessions.revokeLinked(session.id, "parent-logout");
      res.setHeader("Set-Cookie", clearSessionCookies("primary", ctx.secure));
      audit(db, "logout", undefined, ctx.ip);
      track(req, "logout");
      res.json({ ok: true });
    }),
  );

  router.post(
    "/auth/refresh",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      // A heartbeat: the session and both cookies live another full TTL; the token stays the same.
      const renewed = sessions.heartbeat(ctx.session!);
      if (!renewed) {
        res.setHeader("Set-Cookie", clearSessionCookies("primary", ctx.secure));
        res.status(401).json({ error: "session_expired", message: t().http.auth.sessionExpired });
        return;
      }
      const csrf = ctx.cookies[COOKIE_NAMES.primary.csrf] ?? "";
      res.setHeader("Set-Cookie", sessionCookies("primary", ctx.cookies[COOKIE_NAMES.primary.session]!, csrf, { secure: ctx.secure, ttlMs: cfg.sessionTtlMs }));
      res.json({ ok: true, expiresAt: renewed.expiresAt });
    }),
  );

  router.get(
    "/auth/session",
    asyncHandler(async (req, res, ctx) => {
      const owner = ctx.session ? getUser(db, ctx.session.ownerId) : null;
      if (!ctx.session) {
        res.json({ authenticated: false, kind: ctx.kind, username: owner?.username ?? null, inviteEmail: cfg.inviteEmail || null, registrationRequiresInvite: registrationRequiresInvite(db) });
        return;
      }
      res.json({
        authenticated: true,
        kind: ctx.kind,
        username: owner?.username ?? null,
        // The account's email; null for an account that only has the hidden placeholder.
        email: owner ? visibleEmail(db, owner.id) : null,
        role: owner?.role ?? null,
        expiresAt: ctx.session.expiresAt,
        secure: ctx.secure,
      });
    }),
  );

  // The API version this control plane serves: a UI (web or packaged) built for another one says so.
  router.get("/version", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ component: "control", version: appVersion(), api: API_VERSION, apiMin: API_MIN });
  });

  // ------------------------------------------------------------- status/health

  router.get(
    "/status",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      const [agentStatus, hostAuth, sandboxState, sandboxReady] = await Promise.all([
        agent.status(),
        cfg.memberRuntime ? Promise.resolve({ok:true,authMethod:null,email:null,planType:null,error:null,expiresAt:null}) : hostTokens.status(),
        container.inspect(),
        container.isReady(),
      ]);
      // A container stopped for idleness is asleep, not broken; the console's own heartbeat is waking it.
      // A dozing one is up (only its browser is released), so it reports nothing.
      const idle = context.idle && context.idle.state !== "running" && context.idle.state !== "dozing" ? context.idle.state : null;
      if (isMember(db, ctxOf(_req).session!.ownerId)) {
        res.json({ agent: { sessionReady: agentStatus.sessionReady, lastError: agentStatus.sessionReady ? null : t().http.common.connecting },
          // A member learns that the start failed, not why.
          hostAuth: { ok: hostAuth.ok }, sandbox: { running: sandboxState.running, healthy: sandboxReady, setupError: context.sandboxSetupError ? t().http.common.connecting : null, surfaces: context.sandboxSurfaces, idle },
          workspaceOrigin: workspaceOrigin(ctxOf(_req), cfg) });
        return;
      }
      // Refresh surfaces on demand so the dashboard is not stuck on stale data;
      // a stopped (idle) container has none, and probing it only waits for timeouts.
      if (sandboxState.running) {
        try {
          context.sandboxSurfaces = await container.surfaces();
        } catch {
          /* keep the previous snapshot */
        }
      }
      res.json({
        agent: agentStatus,
        hostAuth: { ok: hostAuth.ok, authMethod: hostAuth.authMethod, email: hostAuth.email, planType: hostAuth.planType, error: hostAuth.error, expiresAt: hostAuth.expiresAt },
        sandbox: {
          name: container.name,
          running: sandboxState.running,
          healthy: sandboxReady,
          image: sandboxState.image,
          managed: sandboxState.managedLabel === "1",
          setupError: context.sandboxSetupError,
          surfaces: context.sandboxSurfaces,
          idle,
        },
        workspaceOrigin: workspaceOrigin(ctxOf(_req), cfg),
      });
    }),
  );

  /**
   * The console is on a screen (sent every 20 s while it is). Only a beat that
   * says someone touched it lately (`attended`) counts toward keeping the
   * sandbox: together with sandbox use it decides when an idle container is
   * stopped, and a stopped one starts warming up the moment its owner comes
   * back. Older consoles send no flag, so a tab left open for days on one no
   * longer holds the container.
   */
  router.post(
    "/presence",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      if (req.body?.attended === true) context.idle?.foreground();
      // The device's own push subscription, when it has one: only that device stays quiet while on screen.
      context.push?.presence(ctxOf(req).session!.ownerId, req.body?.endpoint);
      res.json({ ok: true });
    }),
  );

  /**
   * Voice input: the composer's recording (16-bit mono WAV, base64) goes to the
   * speech server at cfg.asrUrl (the one the voice gadget uses); only the text comes back,
   * polished by the same model as the gadget's dictation. The speech server
   * (X-ASR) hears Mandarin and English but not Spanish, so the
   * console offers the microphone only in the languages listed here.
   */
  const dictation = new Dictation(cfg, log);
  const voiceLog = new VoiceLog(cfg.voiceLog.dir, cfg.voiceLog.users, cfg.voiceLog.days, log);
  // The accounts the knowledge base is offered to (KbGateway): only their transcripts get its names.
  const kbReader = (user: { username: string; role: string } | null | undefined) =>
    Boolean(user && (user.role === "owner" || cfg.kbMcp.members.includes(user.username)));
  router.get("/asr", requireKind("primary"), requireSession, (_req, res) => {
    res.json({ enabled: Boolean(cfg.asrUrl), locales: ASR_LOCALES });
  });
  router.post("/asr", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!cfg.asrUrl) { res.status(404).json({ error: "not_configured", message: t().http.voice.notConfigured }); return; }
    const audio = Buffer.from(typeof req.body?.audioBase64 === "string" ? req.body.audioBase64 : "", "base64");
    if (audio.byteLength < 44 || audio.toString("ascii", 0, 4) !== "RIFF") { res.status(400).json({ error: "bad_audio", message: t().http.voice.badAudio }); return; }
    // The speech server takes about a minute of 16 kHz audio.
    if (audio.byteLength > 2 * 1024 * 1024) { res.status(413).json({ error: "too_long", message: t().http.voice.tooLong }); return; }
    const user = getUser(db, ctxOf(req).session!.ownerId);
    const mic = req.body?.microphone;
    const name = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : "");
    const microphone = mic && typeof mic === "object" ? {
      used: name(mic.used),
      inputs: Array.isArray(mic.inputs) ? mic.inputs.slice(0, 12).map(name) : [],
      rate: typeof mic.rate === "number" && Number.isFinite(mic.rate) ? mic.rate : null,
    } : null;
    const record: Omit<VoiceRecord, "audio"> = { user: user?.username ?? "?", platform: req.get("x-client-platform") ?? null, microphone, asr: null, polish: null, error: null };
    try {
      let started = Date.now();
      const upstream = await fetch(cfg.asrUrl, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(audio), signal: AbortSignal.timeout(30_000) });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      const json = (await upstream.json()) as { text?: unknown; raw?: unknown; model?: unknown; words?: unknown };
      const heard = typeof json.text === "string" ? json.text.trim() : "";
      record.asr = { url: cfg.asrUrl, model: typeof json.model === "string" ? json.model : null, ms: Date.now() - started, text: heard, raw: typeof json.raw === "string" ? json.raw : null };
      started = Date.now();
      // The speech server's vocabulary, which it may still have misheard (an older server sends none).
      const terms = Array.isArray(json.words) ? json.words.filter((w): w is string => typeof w === "string").slice(0, 200) : [];
      const out = heard ? await dictation.polish(heard, { names: kbReader(user), terms }) : { text: "", polished: false };
      if (heard) record.polish = { model: cfg.polishModel, effort: cfg.polishEffort, ms: Date.now() - started, ...out };
      res.json(out);
      track(req, "voice_input", { ok: true, seconds: Math.round((audio.byteLength - 44) / 32000) });
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      track(req, "voice_input", { ok: false });
      log.warn("asr failed", { error: record.error });
      res.status(502).json({ error: "asr_unavailable", message: t().http.voice.unavailable });
    }
    voiceLog.record({ ...record, audio });
  }));

  /** Phone notifications (Web Push): the key to subscribe with, and this account's devices. */
  router.get("/push", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(context.push ? { supported: true, publicKey: context.push.publicKey, devices: context.push.count(ctxOf(req).session!.ownerId) } : { supported: false });
  }));
  router.post("/push/subscribe", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.push) { res.status(404).json({ error: "push_unavailable", message: t().http.push.unavailable }); return; }
    try {
      context.push.subscribe(ctxOf(req).session!.ownerId, req.body?.subscription ?? {}, req.get("user-agent") ?? "");
      track(req, "push_subscribe");
      res.json({ ok: true, devices: context.push.count(ctxOf(req).session!.ownerId) });
    } catch (err) { res.status(400).json({ error: "bad_subscription", message: err instanceof Error ? err.message : t().http.push.badSubscription }); }
  }));
  router.post("/push/unsubscribe", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
    if (context.push && endpoint) context.push.unsubscribe(ctxOf(req).session!.ownerId, endpoint);
    track(req, "push_unsubscribe");
    res.json({ ok: true });
  }));
  router.post("/push/test", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.push) { res.status(404).json({ error: "push_unavailable", message: t().http.push.unavailable }); return; }
    const sent = await context.push.notify(ctxOf(req).session!.ownerId, { title: t().http.push.testTitle, body: t().http.push.testBody, tag: "test" }, { force: true });
    res.json({ sent });
  }));

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    }),
  );

  // -------------------------------------------------------- conversations

  // One read of the tab record shows, per task, whether it has tabs, is waiting for
  // the person in the browser, or is being driven by the person right now.
  // A task feed must not wait on a slow sandbox: past two seconds it shows tasks without browser state.
  // Execution conversations that called the phone tools: their task cards show the phone.
  const phoneConversations = new Set<string>();
  const usedPhone = (conversationId: string): boolean => {
    if (!context.phone?.enabled) return false;
    if (phoneConversations.has(conversationId)) return true;
    const hit = db.prepare(`SELECT 1 FROM events WHERE conversation_id=? AND type='item/started' AND payload LIKE '%"server":"aio_phone"%' LIMIT 1`).get(conversationId);
    if (hit) phoneConversations.add(conversationId);
    return Boolean(hit);
  };
  const browserState = async (userId: string) => {
    const tabs = context.tabs ? await Promise.race([context.tabs.list().catch(() => []), new Promise<[]>((r) => setTimeout(() => r([]), 2000).unref())]) : [];
    const byKey = new Map<string, typeof tabs>();
    for (const tab of tabs) byKey.set(tab.key, [...(byKey.get(tab.key) ?? []), tab]);
    const asking = [...byKey].filter(([, own]) => own.some((t) => t.request && t.holder === "ai")).map(([key]) => key);
    const decorate = <T extends { mergedInto?: string | null; conversationId: string }>(found: T) => {
      const phoned = !found.mergedInto && usedPhone(found.conversationId) ? { ...found, phone: true } : found;
      // The page it works in on the AI's Chrome on the user's Mac, if any (UserBrowserGateway).
      const userBrowser = phoned.mergedInto ? null : context.userBrowser?.view(userId, phoned.conversationId);
      const task = userBrowser ? { ...phoned, userBrowser } : phoned;
      const own = task.mergedInto ? undefined : byKey.get(task.conversationId);
      if (!own?.length) {
        // Its tab is closed now: the page it last showed stays on the card, to be opened again.
        const last = task.mergedInto ? null : context.tabs?.lastPage?.(task.conversationId);
        return last ? { ...task, browser: { tabs: 0, request: null, human: false, last } } : task;
      }
      const requested = own.find((t) => t.request && t.holder === "ai");
      return { ...task, browser: { tabs: own.length, request: requested?.request?.reason ?? null, human: own.some((t) => t.holder === "human") } };
    };
    return { asking, decorate };
  };

  router.get("/main", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    const limit = Number(req.query.limit ?? 20);
    const page = context.tasks.list(Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, ctxOf(req).session!.ownerId, Number.isSafeInteger(limit) && limit >= 1 && limit <= 20 ? limit : 20);
    // An account with nothing yet (a new one, above all) answers without asking the sandbox about tabs.
    const tasks = page.tasks.length ? page.tasks.map((await browserState(ctxOf(req).session!.ownerId)).decorate) : page.tasks;
    // A poll names the version it holds; an unchanged feed answers in a few bytes instead of the whole page.
    const body = { mode: "tasks", ...page, tasks };
    const version = createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 22);
    res.setHeader("Cache-Control", "no-store");
    res.json(req.query.v === version ? { mode: "tasks", unchanged: true, version } : { ...body, version });
  }));
  // The files page: the main session's messages that hold files, one page at a time.
  router.get("/main/files", requireKind("primary"), requireSession, (req, res) => {
    const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    res.setHeader("Cache-Control", "no-store");
    res.json(context.tasks.files(ctxOf(req).session!.ownerId, Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER));
  });
  // Clawpages: the account's published pages and their data, managed from the console as the owner.
  const clawpages = (req: Request, res: Response, run: (userId: string, page: string, share: NonNullable<AppContext["share"]>) => unknown) => {
    const share = context.share;
    const page = String(req.params.page ?? "");
    if (!share?.data) { res.status(404).json({ error: "not_found", message: "Clawpages are not enabled" }); return; }
    if (!SHARE_NAME.test(page)) { res.status(400).json({ error: "bad_request", message: "Invalid page name" }); return; }
    res.setHeader("Cache-Control", "no-store");
    try {
      const out = run(ctxOf(req).session!.ownerId, page, share);
      if (out === undefined) res.status(204).end(); else res.json(out);
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
      res.status(err.status).json({ error: err.code, message: err.message });
    }
  };
  const owner = { owner: true };
  router.get("/clawpages", requireKind("primary"), requireSession, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ pages: context.share?.data ? context.share.list(ctxOf(req).session!.ownerId) : [] });
  });
  // An owner link: the page with a token in its fragment that lets this account's owner read and write every table, for a while.
  router.post("/clawpages/:page/open", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    if (!share.exists(userId, page)) throw new DataError(404, "PAGE_NOT_FOUND", "The page does not exist");
    track(req, "clawpage_open", {});
    return { url: `${share.pageUrl(userId, page)}#cp=${encodeURIComponent(share.data!.ownerToken(userId, page))}` };
  }));
  // A page's cover: only a picture (checked by its bytes), kept long when the address names its version.
  router.get("/clawpages/:page/cover", requireKind("primary"), requireSession, (req, res) => {
    const page = String(req.params.page ?? "");
    const cover = SHARE_NAME.test(page) ? context.share?.cover(ctxOf(req).session!.ownerId, page) : null;
    if (!cover) { res.status(404).setHeader("Cache-Control", "no-store"); res.json({ error: "not_found", message: "No cover" }); return; }
    res.set({
      "Content-Type": cover.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": req.query.v === String(cover.at) ? "private, max-age=31536000, immutable" : "private, no-cache",
    });
    res.send(cover.data);
  });
  router.delete("/clawpages/:page", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    if (!share.remove(userId, page)) throw new DataError(404, "PAGE_NOT_FOUND", "The page does not exist");
    return undefined;
  }));
  // Collaborators: other people's agents the owner lets maintain a page; a new one's token is shown once, in its invitation.
  router.get("/clawpages/:page/collaborators", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    if (!share.exists(userId, page)) throw new DataError(404, "PAGE_NOT_FOUND", "The page does not exist");
    return { collaborators: share.data!.collaborators(userId, page) };
  }));
  router.post("/clawpages/:page/collaborators", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    track(req, "clawpage_invite", {});
    return share.invite(userId, page, req.body?.label);
  }));
  router.delete("/clawpages/:page/collaborators/:id", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    if (!share.data!.removeCollaborator(userId, page, String(req.params.id))) throw new DataError(404, "COLLABORATOR_NOT_FOUND", "No such collaborator");
    return undefined;
  }));
  // Earlier versions: what publishes replaced, and making one of them the live page again (files only; the data stays).
  router.get("/clawpages/:page/versions", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    const versions = share.versions(userId, page);
    if (!versions) throw new DataError(404, "PAGE_NOT_FOUND", "The page does not exist");
    return { versions };
  }));
  router.post("/clawpages/:page/versions/:at/restore", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    const restored = share.restore(userId, page, String(req.params.at));
    track(req, "clawpage_restore", {});
    return restored;
  }));
  router.get("/clawpages/:page/tables/:table", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) =>
    share.data!.list(userId, page, String(req.params.table), owner, { limit: req.query.limit, after: req.query.after })));
  router.get("/clawpages/:page/tables/:table/export", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    const table = String(req.params.table);
    res.setHeader("Content-Disposition", `attachment; filename="${page}-${table}.json"`);
    return share.data!.exportTable(userId, page, table);
  }));
  router.patch("/clawpages/:page/tables/:table", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) =>
    share.data!.setPermission(userId, page, String(req.params.table), req.body?.permission)));
  router.delete("/clawpages/:page/tables/:table", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    if (!share.data!.dropTable(userId, page, String(req.params.table))) throw new DataError(404, "TABLE_NOT_FOUND", "The table does not exist");
    return undefined;
  }));
  router.delete("/clawpages/:page/tables/:table/records/:key", requireKind("primary"), requireSession, (req, res) => clawpages(req, res, (userId, page, share) => {
    if (!share.data!.remove(userId, page, String(req.params.table), String(req.params.key), owner)) throw new DataError(404, "RECORD_NOT_FOUND", "The record does not exist");
    return undefined;
  }));
  // Signing in to a clawpage (a page or mini app any account published): the page sends its visitor here (`.auth/sign-in`);
  // the person is asked once per page whether it may know who they are and use their AI, then goes back with a visitor
  // token in the page address's fragment, which only that page receives. Asked again silently, it only answers.
  const ssoPage = (req: Request): { userId: string; page: string; title: string; url: string } | null => {
    const share = context.share;
    const owner = typeof req.query.owner === "string" ? req.query.owner : typeof req.body?.owner === "string" ? req.body.owner : "";
    const page = typeof req.query.page === "string" ? req.query.page : typeof req.body?.page === "string" ? req.body.page : "";
    const userId = share?.data && /^[A-Za-z0-9_-]{2,40}$/.test(owner) ? share.userIdOf(owner) : null;
    const facts = userId ? share!.page(userId, page) : null;
    return facts ? { userId: userId!, page, title: facts.title, url: facts.url } : null;
  };
  const visitorOf = (userId: string): { id: string; name: string; email: string | null } => ({ id: userId, name: getUser(db, userId)?.username ?? userId, email: visibleEmail(db, userId) });
  router.get("/clawpage-sso/authorize", requireKind("primary"), (req, res) => {
    const target = ssoPage(req);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!target) { res.status(404).json({ error: "PAGE_NOT_FOUND", message: "The page does not exist" }); return; }
    const share = context.share!;
    const session = ctxOf(req).session;
    if (session && share.data!.granted(target.userId, target.page, session.ownerId)) {
      const visitor = visitorOf(session.ownerId);
      share.data!.grant(target.userId, target.page, visitor);
      res.redirect(303, share.returnUrl(target.userId, target.page, req.query.return, share.data!.visitorToken(target.userId, target.page, visitor)));
      return;
    }
    if (req.query.silent === "1") { res.redirect(303, share.returnUrl(target.userId, target.page, req.query.return, "none")); return; }
    const params = new URLSearchParams({ owner: String(req.query.owner), page: target.page, return: typeof req.query.return === "string" ? req.query.return : "" });
    res.redirect(303, `/clawpage-sso?${params}`);
  });
  // What the sign-in page shows: the page, and (signed in) who would be signed in to it.
  router.get("/clawpage-sso/page", requireKind("primary"), (req, res) => {
    const target = ssoPage(req);
    res.setHeader("Cache-Control", "no-store");
    if (!target) { res.status(404).json({ error: "PAGE_NOT_FOUND", message: "The page does not exist" }); return; }
    const session = ctxOf(req).session;
    const share = context.share!;
    res.json({ title: target.title, owner: share.usernameOf(target.userId), url: target.url, cancelUrl: share.returnUrl(target.userId, target.page, req.query.return, "denied"),
      account: session ? visitorOf(session.ownerId) : null });
  });
  router.post("/clawpage-sso/grant", requireKind("primary"), requireSession, (req, res) => {
    const target = ssoPage(req);
    res.setHeader("Cache-Control", "no-store");
    if (!target) { res.status(404).json({ error: "PAGE_NOT_FOUND", message: "The page does not exist" }); return; }
    const share = context.share!;
    const visitor = visitorOf(ctxOf(req).session!.ownerId);
    share.data!.grant(target.userId, target.page, visitor);
    track(req, "clawpage_sign_in", {});
    res.json({ url: share.returnUrl(target.userId, target.page, req.body?.return, share.data!.visitorToken(target.userId, target.page, visitor)) });
  });
  // The task list: counts by status, then one filtered page at a time (keyset cursor).
  router.get("/tasks", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const filter = String(req.query.filter ?? "all") as TaskFilter;
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;
    if (!TASK_FILTERS.includes(filter) || query.length > 200) {
      res.status(400).json({ error: "bad_request", message: t().http.tasks.badFilter });
      return;
    }
    const { asking, decorate } = await browserState(ctxOf(req).session!.ownerId);
    try {
      const page = context.tasks.page({ userId: ctxOf(req).session!.ownerId, filter, query, cursor, limit: Number(req.query.limit ?? 30) || 30, asking });
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...page, tasks: page.tasks.map(decorate) });
    } catch (err) {
      if (!(err instanceof TaskCursorError)) throw err;
      res.status(400).json({ error: "bad_request", message: err.message });
    }
  }));
  // The console language decides what language the account's agents write for people in.
  router.put("/account/locale", requireKind("primary"), requireSession, (req, res) => {
    const locale = req.body?.locale;
    if (!isLocale(locale)) { res.status(400).json({ error: "bad_request", message: t().http.common.unsupportedLocale }); return; }
    // A console reporting the language it opened in is not a person switching languages.
    if (req.body?.sync === true) { res.json({ ok: true, applied: context.tasks.syncLocale(locale) }); return; }
    context.tasks.setLocale(locale);
    track(req, "locale_change", { locale });
    res.json({ ok: true });
  });
  router.post("/tasks", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    try {
      const b = req.body ?? {};
      if (typeof b.text !== "string" || typeof b.clientMessageId !== "string") throw new Error(t().http.tasks.badMessage);
      const attachments = Array.isArray(b.attachments) ? b.attachments.map((a: {path?:unknown;kind?:unknown;name?:unknown}) => {
        if (!a || typeof a.path !== "string") throw new Error(t().http.tasks.badAttachment);
        const checked = requireWorkspaceFilePath(a.path, cfg.sandbox.containerWorkspaceDir);
        if (!checked.ok) throw new Error(checked.message);
        return { path: checked.path, kind: a.kind === "image" ? "image" as const : "file" as const, name: typeof a.name === "string" ? a.name : "" };
      }) : [];
      const result = context.tasks.submit({ userId: ctxOf(req).session!.ownerId, text: b.text, clientMessageId: b.clientMessageId, attachments, relatedTaskId: typeof b.relatedTaskId === "string" ? b.relatedTaskId : null, locale: typeof b.locale === "string" ? b.locale : null });
      if (!result.duplicate) track(req, "task_submit", { attachments: attachments.length, images: attachments.filter((a: { kind: string }) => a.kind === "image").length, reference: typeof b.relatedTaskId === "string" });
      res.status(result.duplicate ? 200 : 202).json(result);
    } catch (err) {
      res.status(err instanceof TurnConflictError ? 409 : 400).json({ error: "task_submit_failed", message: err instanceof Error ? err.message : t().http.tasks.submitFailed });
    }
  }));
  // ---------------------------------------------------------------- gadget
  // The voice gadget (the desk device) speaks for one account with a bearer token
  // from cfg.gadgetTokenPath instead of a login; no cookies, so no CSRF to check.
  // `AIO_GADGET_USER=<username>` in the same file names that account (its own
  // runtime, tasks and sandbox); without it the gadget speaks for the owner.
  /** The account the gadget speaks for: the one AIO_GADGET_USER names, else the owner. */
  const gadgetUser = (): { id: string; username: string; role: string } | undefined => {
    const named = readSecretFile(cfg.gadgetTokenPath, "AIO_GADGET_USER");
    if (named.ok) return db.prepare("SELECT id,username,role FROM owners WHERE username=?").get(named.value) as { id: string; username: string; role: string } | undefined;
    const owner = getUser(db, cfg.runtimeUserId ?? "owner_1");
    return owner?.role === "owner" ? owner : undefined;
  };
  /** The account the request's gadget token speaks for, or null after answering 401. */
  const gadgetCaller = (req: Request, res: Response): { id: string; username: string; role: string } | null => {
    const secret = readSecretFile(cfg.gadgetTokenPath, "AIO_GADGET_TOKEN");
    const given = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    const digest = (s: string) => createHash("sha256").update(s).digest();
    const user = gadgetUser();
    if (!secret.ok || !given || !timingSafeEqual(digest(secret.value), digest(given)) || !user) {
      res.status(401).json({ error: "unauthenticated" });
      return null;
    }
    return user;
  };
  const gadgetAccount = async (req: Request, res: Response): Promise<{ userId: string; tasks: AppContext["tasks"] } | null> => {
    const user = gadgetCaller(req, res);
    if (!user) return null;
    if (user.role === "owner") return { userId: user.id, tasks: context.tasks };
    try {
      if (!context.runtimeForUser) throw new Error("no member runtimes");
      return { userId: user.id, tasks: (await context.runtimeForUser(user.id)).tasks };
    } catch {
      res.status(503).json({ error: "runtime_unavailable", message: t().http.common.runtimeUnavailable });
      return null;
    }
  };
  // The owner reads the gadget account's conversation here (owner-only, read-only).
  // `account` is null unless the gadget speaks for a member: the owner's own
  // gadget messages are already in the owner's main session.
  router.get("/gadget/history", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const user = gadgetUser();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 0, 0), 200);
    const before = typeof req.query.before === "string" && /^\d+$/.test(req.query.before) ? Number(req.query.before) : null;
    if (!user || user.role === "owner" || !context.runtimeForUser) { res.json({ account: null, messages: [], more: false }); return; }
    try {
      const runtime = await context.runtimeForUser(user.id);
      res.json({ account: user.username, ...runtime.tasks.gadgetHistory(user.id, before, limit) });
    } catch {
      res.status(503).json({ error: "runtime_unavailable", message: t().http.common.runtimeUnavailableFor(user.username) });
    }
  }));
  // The gadget's usage page: the JSON at cfg.gadgetUsageUrl (Usage HUD's snapshot on the host), passed through as is.
  router.get("/gadget/usage", requireKind("primary"), asyncHandler(async (req, res) => {
    if (!gadgetCaller(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    if (!cfg.gadgetUsageUrl) { res.status(404).json({ error: "not_configured" }); return; }
    try {
      const upstream = await fetch(cfg.gadgetUsageUrl, { signal: AbortSignal.timeout(5_000) });
      const text = await upstream.text();
      if (!upstream.ok || text.length > 64 * 1024) throw new Error(`upstream ${upstream.status}`);
      res.json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "usage_unavailable", message: t().http.tasks.gadgetUsageUnavailable });
    }
  }));
  // Firmware updates over Wi-Fi: what is offered, then the image itself.
  router.get("/gadget/firmware", requireKind("primary"), (req, res) => {
    const caller = gadgetCaller(req, res);
    if (!caller) return;
    res.setHeader("Cache-Control", "no-store");
    const firmware = readFirmware(cfg.gadgetFirmwareDir);
    // The gadget says what it runs (`?running=<app ELF SHA-256>`): with no cable, the log is where to see it.
    const running = typeof req.query.running === "string" && /^[a-f0-9]{64}$/.test(req.query.running) ? req.query.running : null;
    // And its battery meter (percent, mV, seconds since unplugged, where it started, per mille of that with the screen off).
    const int = (name: string) => (typeof req.query[name] === "string" && /^-?\d{1,9}$/.test(req.query[name] as string) ? Number(req.query[name]) : undefined);
    const battery = int("pct") === undefined ? null : {
      pct: int("pct"), mv: int("mv"), onBattery: int("on_battery") === 1, secs: int("secs"),
      fromPct: int("from_pct"), fromMv: int("from_mv"), screenOffPm: int("screen_off_pm"),
      // Where the time went: resting, really in light sleep, a core at full speed, and the power locks held longest.
      restingPm: int("resting_pm"), sleptPm: int("slept_pm"), sleeps: int("sleeps"), busyPm: int("busy_pm"),
      awake: typeof req.query.awake === "string" ? req.query.awake.replace(/[^\w .,%-]/g, "").slice(0, 64) : undefined,
    };
    // Free PSRAM now and its low-water mark since boot, in KB: long recordings are the big allocations.
    const memory = int("psram_kb") === undefined ? null : { psramKb: int("psram_kb"), psramMinKb: int("psram_min_kb") };
    log.info("gadget firmware check", { account: caller.username, running: running?.slice(0, 12) ?? null, offered: firmware?.elfSha256.slice(0, 12) ?? null, battery, memory });
    if (!firmware) { res.status(404).json({ error: "no_firmware" }); return; }
    const { file: _file, ...info } = firmware;
    res.json(info);
  });
  router.get("/gadget/firmware.bin", requireKind("primary"), (req, res) => {
    if (!gadgetCaller(req, res)) return;
    const firmware = readFirmware(cfg.gadgetFirmwareDir);
    if (!firmware) { res.status(404).json({ error: "no_firmware" }); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(firmware.size), "Cache-Control": "no-store" });
    const stream = fs.createReadStream(firmware.file).on("error", () => res.destroy());
    res.on("close", () => stream.destroy()); // an aborted download would otherwise keep the fd open
    stream.pipe(res);
  });
  // The dictation page: what the gadget heard, polished and typed at the cursor on the host Mac.
  router.post("/gadget/dictation", requireKind("primary"), asyncHandler(async (req, res) => {
    const caller = gadgetCaller(req, res);
    if (!caller) return;
    if (!dictation.enabled) { res.status(404).json({ error: "not_configured" }); return; }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > DICTATION_MAX_CHARS) { res.status(400).json({ error: "bad_request" }); return; }
    // The gadget's side of the timing (seconds recorded, ms to upload and transcribe them, its previous send's round trip) and its free PSRAM.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);
    const gadget = { audioS: num(req.body?.audioS), asrMs: num(req.body?.asrMs), prevSendMs: num(req.body?.prevSendMs),
      psramKb: num(req.body?.psramKb), psramMinKb: num(req.body?.psramMinKb) };
    const started = Date.now();
    const out = await dictation.polish(text, { names: kbReader(caller) });
    const polishMs = Date.now() - started;
    try {
      await dictation.type(out.text);
    } catch (err) {
      const code = err instanceof DictationError ? err.code : "bridge_unavailable";
      log.warn("gadget dictation not typed", { account: caller.username, code });
      res.status(code === "not_trusted" ? 409 : code === "not_configured" ? 404 : 502).json({ error: code, text: out.text });
      return;
    }
    log.info("gadget dictation typed", { account: caller.username, chars: out.text.length, polished: out.polished, polishMs, typeMs: Date.now() - started - polishMs, ...gadget });
    res.json({ text: out.text, polished: out.polished });
  }));
  router.post("/gadget/messages", requireKind("primary"), asyncHandler(async (req, res) => {
    const account = await gadgetAccount(req, res);
    if (!account) return;
    try {
      const b = req.body ?? {};
      if (typeof b.text !== "string" || typeof b.clientMessageId !== "string") throw new Error(t().http.tasks.badMessage);
      const row = account.tasks.submitGadget({ userId: account.userId, text: b.text, clientMessageId: b.clientMessageId });
      res.status(202).json(account.tasks.gadgetReply(row.id, account.userId));
    } catch (err) {
      res.status(err instanceof TurnConflictError ? 409 : 400).json({ error: "gadget_submit_failed", message: err instanceof Error ? err.message : t().http.tasks.sendFailed });
    }
  }));
  // `?wait=N` (at most 25 s) holds the answer back until the message is done or N
  // seconds pass, so the gadget hears of the answer at once without polling fast.
  router.get("/gadget/messages/:id", requireKind("primary"), asyncHandler(async (req, res) => {
    const account = await gadgetAccount(req, res);
    if (!account) return;
    const read = () => account.tasks.gadgetReply(param(req, "id"), account.userId);
    let reply = read();
    const until = Date.now() + Math.min(Math.max(Number(req.query.wait) || 0, 0), 25) * 1000;
    while (reply && !reply.done && Date.now() < until && !res.writableEnded && !req.socket.destroyed) {
      await new Promise(resolve => setTimeout(resolve, 200));
      reply = read();
    }
    res.setHeader("Cache-Control", "no-store");
    if (!reply) { res.status(404).json({ error: "not_found" }); return; }
    res.json(reply);
  }));
  router.post("/tasks/:id/stop", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    try { await context.tasks.stop(param(req, "id")); track(req, "task_stop"); res.json({ ok: true }); }
    catch (err) { res.status(409).json({ error: "stop_failed", message: err instanceof Error ? err.message : t().http.tasks.stopFailed }); }
  }));
  router.post("/tasks/:id/archive", requireKind("primary"), requireSession, (req, res) => {
    const id = param(req, "id");
    if (!context.tasks.belongsTo(id, ctxOf(req).session!.ownerId)) { res.status(404).json({ error: "not_found" }); return; }
    try { context.tasks.archive(id); track(req, "task_archive"); res.json({ ok: true }); }
    catch (err) { res.status(409).json({ error: "archive_refused", message: err instanceof Error ? err.message : t().http.tasks.archiveFailed }); }
  });
  router.post("/tasks/:id/retry-planning", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    try { context.tasks.retryPlanning(param(req, "id")); track(req, "task_retry"); res.json({ ok: true }); }
    catch (err) { res.status(409).json({ error: "retry_refused", message: err instanceof Error ? err.message : t().http.tasks.retryRefused }); }
  }));

  // Scheduled and recurring tasks: created by asking in the main session, managed here.
  // A schedule that is not the account's is not found, whatever the service would say about it.
  const ownSchedule = (req: Request): boolean => context.tasks.listSchedules(ctxOf(req).session!.ownerId).some((s) => s.id === param(req, "id"));
  router.get("/schedules", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ schedules: context.tasks.listSchedules(ctxOf(req).session!.ownerId) });
  }));
  // Edit a schedule from the page: any of title, instruction, schedule (the whole new rule), needsBrowser.
  router.patch("/schedules/:id", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!ownSchedule(req)) { res.status(404).json({ error: "schedule_refused", message: t().http.tasks.scheduleNotFound }); return; }
    const changed = context.tasks.updateScheduleFor(ctxOf(req).session!.ownerId, { id: param(req, "id"), title: body.title, instruction: body.instruction, schedule: body.schedule, needsBrowser: body.needsBrowser });
    if (changed.ok) { track(req, "schedule_edit"); res.json({ message: changed.message, schedule: changed.schedule }); return; }
    res.status(409).json({ error: "schedule_refused", message: changed.error });
  }));
  router.post("/schedules/:id/:action", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const action = param(req, "action");
    const userId = ctxOf(req).session!.ownerId;
    if (!ownSchedule(req)) { res.status(404).json({ error: "schedule_refused", message: t().http.tasks.scheduleNotFound }); return; }
    try {
      if (action === "run") { res.json(context.tasks.runScheduleNow(param(req, "id"), userId)); track(req, "schedule_action", { action }); return; }
      if (action !== "pause" && action !== "resume" && action !== "cancel") { res.status(404).json({ error: "not_found" }); return; }
      res.json(context.tasks.changeSchedule(param(req, "id"), userId, action));
      track(req, "schedule_action", { action });
    } catch (err) {
      res.status(409).json({ error: "schedule_refused", message: err instanceof Error ? err.message : t().http.tasks.actionFailed });
    }
  }));

  // A task's browser tabs: what its agent is doing there, and the person taking over or handing back.
  const taskBrowserKey = (req: Request): string | null => {
    const id = param(req, "id");
    return context.tasks.belongsTo(id, ctxOf(req).session!.ownerId) ? context.tasks.browserKey(id) : null;
  };
  // One of the account's tasks, for a console address that names it (`/u/<name>/tasks/<id>`).
  router.get("/tasks/:id", requireKind("primary"), requireSession, (req, res) => {
    const id = param(req, "id");
    const row = context.tasks.belongsTo(id, ctxOf(req).session!.ownerId) ? context.tasks.get(id) : null;
    if (!row) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ task: context.tasks.view(row) });
  });
  router.get("/tasks/:id/browser", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    if (!key) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ tabs: context.tabs ? await context.tabs.list(key) : [] });
  }));
  router.get("/tasks/:id/browser/screenshot", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    const shot = key && context.tabs ? await context.tabs.screenshot(key, String(req.query.tab ?? "")) : null;
    if (!shot) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.type(shot.mimeType).send(Buffer.from(shot.data, "base64"));
  }));
  // The page a task's browser last showed, after its tab was closed: its picture, and opening it again.
  router.get("/tasks/:id/browser/last-shot", requireKind("primary"), requireSession, (req, res) => {
    const key = taskBrowserKey(req);
    const shot = key ? context.tabs?.lastShot?.(key) : null;
    if (!shot) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.type("image/jpeg").send(shot);
  });
  router.post("/tasks/:id/browser/reopen", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    const last = key ? context.tabs?.lastPage?.(key) : null;
    if (!key || !last || !context.tabs?.reopen) { res.status(404).json({ error: "not_found", message: t().http.browser.noReopen }); return; }
    // Only the page the task itself was on: the address is never taken from the request.
    const out = await context.tabs.reopen(key, last.url, last.title);
    res.status(out.status).json(out.body);
  }));
  // A phone cannot raise its keyboard inside the remote browser view, so its native
  // input bar types into the tab the person took over through here.
  const heldTab = (req: Request): { tab?: string } => (typeof req.body?.tab === "string" && req.body.tab ? { tab: req.body.tab } : {});
  const personInput = (req: Request): { text?: string; key?: string } | null => {
    const text = typeof req.body?.text === "string" ? req.body.text : undefined;
    const key = typeof req.body?.key === "string" ? req.body.key : undefined;
    return text || key ? { ...(text ? { text } : {}), ...(key ? { key } : {}) } : null;
  };
  router.post("/browser/input", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    const input = personInput(req);
    if (!input) { res.status(400).json({ error: "empty_input" }); return; }
    const out = await context.tabs.input(input);
    res.status(out.status).json(out.body);
  }));
  // The person's own tabs (links opened from a reply): only ever the "person" key.
  const personTab = (req: Request): string => String((req.method === "GET" ? req.query.tab : req.body?.tab) ?? "");
  router.get("/browser/person/screenshot", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const shot = context.tabs ? await context.tabs.screenshot(PERSON_KEY, personTab(req)) : null;
    if (!shot) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.type(shot.mimeType).send(Buffer.from(shot.data, "base64"));
  }));
  router.post("/browser/person/input", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    const input = personInput(req);
    if (!input) { res.status(400).json({ error: "empty_input" }); return; }
    const out = await context.tabs.input({ ...input, task: PERSON_KEY, tab: personTab(req) });
    res.status(out.status).json(out.body);
  }));
  router.post("/browser/person/pointer", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    const action = req.body?.action;
    if (action !== "click" && action !== "scroll" && action !== "back" && action !== "focus") { res.status(400).json({ error: "bad_action" }); return; }
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const out = await context.tabs.pointer({ task: PERSON_KEY, tab: personTab(req), action, x: num(req.body?.x), y: num(req.body?.y), dy: num(req.body?.dy) });
    res.status(out.status).json(out.body);
  }));
  // The person's overview of every page open in their browser: which, a preview of each, and switching to one.
  router.get("/browser/overview", requireKind("primary"), requireSession, asyncHandler(async (_req, res) => {
    const pages = context.tabs?.overview ? await context.tabs.overview() : null;
    if (!pages) { res.status(503).json({ error: "unavailable", message: t().http.browser.unavailable }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ pages });
  }));
  router.get("/browser/overview/shot", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const shot = context.tabs?.overviewShot ? await context.tabs.overviewShot(String(req.query.target ?? "")) : null;
    if (!shot) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.type(shot.mimeType).send(Buffer.from(shot.data, "base64"));
  }));
  router.post("/browser/overview/front", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.tabs?.front) { res.status(404).json({ error: "not_found" }); return; }
    const out = await context.tabs.front(String((req.body as { target?: unknown } | undefined)?.target ?? ""));
    res.status(out.status).json(out.body);
  }));
  router.post("/browser/person/close", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    const out = await context.tabs.close(personTab(req));
    res.status(out.status).json(out.body);
  }));
  router.post("/tasks/:id/browser/input", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const task = taskBrowserKey(req);
    if (!task || !context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    const input = personInput(req);
    if (!input) { res.status(400).json({ error: "empty_input" }); return; }
    const out = await context.tabs.input({ ...input, task, ...heldTab(req) });
    res.status(out.status).json(out.body);
  }));
  router.post("/tasks/:id/browser/pointer", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const task = taskBrowserKey(req);
    if (!task || !context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    const action = req.body?.action;
    if (action !== "click" && action !== "scroll" && action !== "back" && action !== "focus") { res.status(400).json({ error: "bad_action" }); return; }
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const out = await context.tabs.pointer({ task, ...heldTab(req), action, x: num(req.body?.x), y: num(req.body?.y), dy: num(req.body?.dy) });
    res.status(out.status).json(out.body);
  }));
  router.post("/tasks/:id/browser/control", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    const action = req.body?.action;
    if (!key || !context.tabs) { res.status(404).json({ error: "not_found" }); return; }
    if (action !== "take" && action !== "release") { res.status(400).json({ error: "bad_action" }); return; }
    let tab = await context.tabs.control(key, String(req.body?.tab ?? ""), action);
    // The card may still show a tab the agent has since replaced, or memory closed. Handing back
    // means every tab of this task the person holds, so the agent never waits on one that is gone.
    if (!tab && action === "release") {
      const own = await context.tabs.list(key);
      for (const held of own.filter((t) => t.holder === "human")) tab = (await context.tabs.control(key, held.id, "release")) ?? tab;
      tab ??= own.find((t) => t.request) ?? own[0] ?? null;
    }
    if (!tab) { res.status(404).json({ error: "tab_not_found", message: t().http.browser.tabGone }); return; }
    track(req, action === "take" ? "browser_takeover" : "browser_handback");
    res.json({ tab });
  }));
  // A task's page on the AI's Chrome on the user's Mac (UserBrowserGateway): its picture, and the person taking it over or handing it back.
  router.get("/tasks/:id/user-browser/screenshot", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    const shot = key && context.userBrowser ? await context.userBrowser.screenshot(ctxOf(req).session!.ownerId, key) : null;
    if (!shot) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.type(shot.type).send(shot.body);
  }));
  router.post("/tasks/:id/user-browser/control", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    const action = req.body?.action;
    if (action !== "take" && action !== "release") { res.status(400).json({ error: "bad_action" }); return; }
    const view = key && context.userBrowser ? await context.userBrowser.control(ctxOf(req).session!.ownerId, key, action) : null;
    if (!view) { res.status(404).json({ error: "not_found" }); return; }
    track(req, action === "take" ? "user_browser_takeover" : "user_browser_handback");
    res.json({ userBrowser: view });
  }));
  // The workspace's Mac browser: every page of the AI's Chrome on the account's Mac, and pages the person opens there themselves.
  router.get("/user-browser/pages", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.userBrowser) { res.json({ state: "unlinked", pages: [] }); return; }
    const { state, pages } = await context.userBrowser.macPages(ctxOf(req).session!.ownerId);
    const taskOf = db.prepare(`SELECT id, title FROM tasks WHERE COALESCE(execution_conversation_id, conversation_id)=? ORDER BY created_at DESC LIMIT 1`);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      state,
      pages: pages.map(({ taskKey, ...page }) => {
        const task = taskKey ? (taskOf.get(taskKey) as { id: string; title: string } | undefined) : undefined;
        return { ...page, task: task ? { id: task.id, title: task.title } : null };
      }),
    });
  }));
  router.post("/user-browser/pages", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000) { res.status(400).json({ error: "bad_url", message: t().http.browser.badUrl }); return; }
    if (!context.userBrowser) { res.status(404).json({ error: "not_found" }); return; }
    try {
      res.json({ page: await context.userBrowser.openMacPage(ctxOf(req).session!.ownerId, url) });
    } catch (err) {
      res.status(502).json({ error: "unavailable", message: err instanceof Error ? err.message : String(err) });
    }
  }));
  router.delete("/user-browser/pages/:id", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const id = Number(param(req, "id"));
    if (!context.userBrowser || !Number.isInteger(id) || id <= 0) { res.status(404).json({ error: "not_found" }); return; }
    try {
      if (!(await context.userBrowser.closeMacPage(ctxOf(req).session!.ownerId, id))) { res.status(409).json({ error: "in_use", message: t().http.browser.pageInUse }); return; }
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: "unavailable", message: err instanceof Error ? err.message : String(err) });
    }
  }));
  // The person answers a task's sign-in request from the vault: a saved account, or one typed here
  // (saved unless they say not to). The account goes into the page; the response only says what happened.
  router.post("/tasks/:id/browser/login", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const key = taskBrowserKey(req);
    const tab = key && context.tabs ? (await context.tabs.list(key)).find((t) => t.id === String(req.body?.tab ?? "")) : undefined;
    if (!tab || ctxOf(req).session!.ownerId !== (cfg.runtimeUserId ?? "owner_1")) { res.status(404).json({ error: "tab_not_found", message: t().http.browser.tabGone }); return; }
    res.setHeader("Cache-Control", "no-store");
    try {
      const out = await vaultLogin(context, tab, { entryId: req.body?.entryId, username: req.body?.username, password: req.body?.password, save: req.body?.save, method: req.body?.method });
      if (out.ok) res.json({ result: out.result, ...(out.error ? { error: out.error } : {}) });
      else res.status(out.status).json({ error: out.error, message: out.message });
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      res.status(err.status).json({ error: err.code, message: err.message });
    }
  }));

  // ------------------------------------------------------------ password vault
  // The account's saved sign-ins. A password is returned by one call only, to the signed-in person who asks for it.
  // Only the account this runtime belongs to: a request that reached another account's runtime gets nothing.
  const vault = (req: Request, res: Response): Vault | null => {
    res.setHeader("Cache-Control", "no-store");
    const own = context.vault && ctxOf(req).session!.ownerId === (cfg.runtimeUserId ?? "owner_1") ? context.vault : null;
    if (!own) res.status(404).json({ error: "not_found" });
    return own;
  };
  const vaultFailure = (res: Response, err: unknown): void => {
    if (!(err instanceof VaultError)) throw err;
    res.status(err.status).json({ error: err.code, message: err.message });
  };
  router.get("/vault", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const v = vault(req, res);
    if (!v) return;
    const site = typeof req.query.site === "string" ? normalizeSite(req.query.site) : null;
    // The kept sign-in steps carry selectors and placeholders only, never a value.
    res.json({ entries: site ? v.matching(site) : v.list(), scripts: site ? [] : v.scripts().map(({ site: s, successes, failures, lastNote, updatedAt, steps }) => ({ site: s, successes, failures, lastNote, updatedAt, steps: steps.length })) });
  }));
  router.post("/vault", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const v = vault(req, res);
    if (!v) return;
    try {
      res.status(201).json({ entry: v.create({ site: req.body?.site, username: req.body?.username, password: req.body?.password, method: req.body?.method }) });
      track(req, "vault_save", { method: req.body?.method === "google" ? "google" : "password" });
    } catch (err) { vaultFailure(res, err); }
  }));
  router.put("/vault/:id", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const v = vault(req, res);
    if (!v) return;
    try {
      const entry = v.update(param(req, "id"), { site: req.body?.site, username: req.body?.username, password: req.body?.password, method: req.body?.method });
      if (entry) res.json({ entry });
      else res.status(404).json({ error: "not_found", message: t().http.vault.noEntry });
    } catch (err) { vaultFailure(res, err); }
  }));
  router.delete("/vault/:id", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const v = vault(req, res);
    if (!v) return;
    if (v.remove(param(req, "id"))) res.json({ ok: true });
    else res.status(404).json({ error: "not_found", message: t().http.vault.noEntry });
  }));
  router.delete("/vault/scripts/:site", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const v = vault(req, res);
    if (!v) return;
    if (v.forgetScript(param(req, "site"))) res.json({ ok: true });
    else res.status(404).json({ error: "not_found", message: t().http.vault.noScript });
  }));
  router.post("/vault/:id/reveal", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const v = vault(req, res);
    if (!v) return;
    const password = v.secret(param(req, "id"));
    if (password === null) res.status(404).json({ error: "not_found", message: t().http.vault.noSecret });
    else res.json({ password });
  }));

  router.get(
    "/conversations",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const includeArchived = req.query.archived === "1";
      res.json({ conversations: agent.listConversations(includeArchived).filter(c => c.owner_id === ctxOf(req).session!.ownerId) });
    }),
  );

  router.post(
    "/conversations",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const title = typeof req.body?.title === "string" ? req.body.title : "";
      const model = typeof req.body?.model === "string" ? req.body.model : null;
      const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
      const { conversation, reused } = agent.getOrCreateConversation({ title, model, cwd });
      res.status(reused ? 200 : 201).json({ conversation, reused });
    }),
  );

  router.get(
    "/conversations/:id",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const conversation = agent.getConversation(param(req, "id"));
      if (!conversation) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        conversation,
        turns: agent.listTurns(conversation.id),
        approvals: agent.listPendingRequests(conversation.id),
      });
    }),
  );

  router.patch(
    "/conversations/:id",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const id = param(req, "id");
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (context.tasks.ownsConversation(id)) {
        res.status(409).json({ error: "managed_task", message: t().http.tasks.managedTask });
        return;
      }
      if ("title" in body) {
        if (typeof body.title !== "string") {
          res.status(400).json({ error: "invalid_title", message: t().http.tasks.titleNotString });
          return;
        }
        // Validate before any mutation, so a rejected title never renames the
        // conversation or marks it as manually titled.
        let title: string;
        try {
          title = normalizeConversationTitle(body.title);
        } catch (err) {
          if (!(err instanceof InvalidConversationTitleError)) throw err;
          res.status(400).json({ error: "invalid_title", message: err.message });
          return;
        }
        const renamed = agent.renameConversation(id, title);
        if (renamed.conflict) {
          res.status(409).json({
            error: "conversation_conflict",
            message: t().http.tasks.renameConflict,
          });
          return;
        }
      }
      if (typeof body.archived === "boolean") {
        if (body.archived) {
          agent.archiveConversation(id, true);
        } else {
          const restored = agent.restoreConversation(id);
          if (restored.conflict) {
            res.status(409).json({
              error: "conversation_conflict",
              message: t().http.tasks.restoreConflict,
            });
            return;
          }
        }
      }
      const conversation = agent.getConversation(id);
      if (!conversation) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ conversation });
    }),
  );

  router.get(
    "/conversations/:id/turns",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      res.json({ turns: agent.listTurns(param(req, "id")) });
    }),
  );

  router.get(
    "/conversations/:id/events",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const conversationId = param(req, "id");
      if (!agent.getConversation(conversationId)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // An EventSource reconnects with its original URL; the header it adds says what it already has.
      const sinceParam = req.get("last-event-id") ?? req.query.since;
      const since = Number.parseInt(String(sinceParam ?? "0"), 10);
      if (req.query.format === "json" && req.query.tail !== undefined) {
        // A task's process opens at its latest turns and reads older ones as the person scrolls up.
        const tail = Number.parseInt(String(req.query.tail), 10);
        const before = Number.parseInt(String(req.query.before ?? ""), 10);
        res.json(agent.listEventsTail(conversationId, Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, Math.min(Math.max(Number.isFinite(tail) ? tail : 200, 1), 1000)));
        return;
      }
      if (req.query.format === "json") {
        res.json({ events: agent.listEvents(conversationId, Number.isFinite(since) ? since : 0) });
        return;
      }
      streamEvents(context, req, res, ctx, conversationId, Number.isFinite(since) ? since : 0);
    }),
  );

  router.post(
    "/conversations/:id/turns",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const conversationId = param(req, "id");
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (context.tasks.ownsConversation(conversationId)) {
        res.status(409).json({ error: "managed_task", message: t().http.tasks.relatedInMain });
        return;
      }
      const clientMessageId =
        typeof req.body?.clientMessageId === "string" && req.body.clientMessageId ? req.body.clientMessageId : `cm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const attachments = Array.isArray(req.body?.attachments)
        ? (req.body.attachments as Array<{ path?: string; kind?: string; name?: string }>)
            .filter((a) => typeof a?.path === "string")
            .map((a) => ({ path: a.path as string, kind: a.kind === "image" ? ("image" as const) : ("file" as const), name: a.name ?? "" }))
        : [];
      if (!text.trim() && attachments.length === 0) {
        res.status(400).json({ error: "empty_message", message: t().http.tasks.emptyMessage });
        return;
      }
      try {
        // Model and effort are intentionally NOT read from the request: the saved
        // unified config is the single source of truth for later messages, so an
        // older client still sending them cannot bypass the config page.
        const { turn, duplicate } = agent.submitTurn({
          conversationId,
          text,
          clientMessageId,
          attachments,
          cwd: typeof req.body?.cwd === "string" ? req.body.cwd : null,
        });
        res.status(duplicate ? 200 : 202).json({ turn, duplicate });
      } catch (err) {
        if (err instanceof TurnConflictError) {
          res.status(409).json({ error: "message_id_conflict", message: err.message });
          return;
        }
        // A submission the selected model cannot run is a client error, not a
        // server failure: report it plainly with the model's own constraint.
        if (err instanceof TurnInputUnsupportedError) {
          res.status(400).json({ error: "input_unsupported", message: err.message });
          return;
        }
        res.status(400).json({ error: "submit_failed", message: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  router.post(
    "/conversations/:id/interrupt",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const result = await agent.interrupt(param(req, "id"));
      res.status(result.ok ? 200 : 409).json(result);
    }),
  );

  // ------------------------------------------------------------- approvals

  router.get(
    "/approvals",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
      res.json({ approvals: agent.listPendingRequests(conversationId).filter(r => agent.getConversation(r.conversation_id)?.owner_id === ctxOf(req).session!.ownerId) });
    }),
  );

  router.post(
    "/approvals/:requestId/respond",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const decision = typeof req.body?.decision === "string" ? req.body.decision : "";
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
        res.status(400).json({ error: "bad_decision", message: t().http.tasks.badDecision });
        return;
      }
      const result = agent.respondToRequest(param(req, "requestId"), decision, req.body?.extra);
      res.status(result.ok ? 200 : 409).json(result);
    }),
  );

  // ----------------------------------------------------------------- models

  router.get(
    "/models",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      try {
        // Through the manager: it marks this product's configured default model,
        // which is not the CLI's own default.
        const models = await agent.listModels();
        res.json({
          models: models.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            description: m.description,
            isDefault: m.isDefault,
            reasoningEfforts: m.supportedReasoningEfforts,
            defaultReasoningEffort: m.defaultReasoningEffort,
            inputModalities: m.inputModalities,
            modelProvider: m.modelProvider ?? null,
          })),
        });
      } catch (err) {
        res.status(503).json({ error: "models_unavailable", message: err instanceof Error ? err.message : String(err), models: [] });
      }
    }),
  );

  // Owner-only source text, independent of model catalog availability.
  router.get('/settings/soul',requireKind('primary'),requireSession,asyncHandler(async(_req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.json({...readSoul(cfg),defaultContent:DEFAULT_SOUL,maxBytes:SOUL_MAX_BYTES});
  }));
  router.put('/settings/soul',requireKind('primary'),requireSession,asyncHandler(async(req,res)=>{
    try {
      const result=writeSoul(cfg,req.body?.content,req.body?.revision);
      audit(db,'soul_updated',result.revision,ctxOf(req).ip);
      res.setHeader('Cache-Control','no-store');res.json({ok:true,...result});
    } catch(err) {if(err instanceof SoulError){res.status(err.status).json({error:'invalid_soul',message:err.message});return;}throw err;}
  }));

  // ---------------------------------------------------------------- settings

  /**
   * Unified owner settings applied to every later message. Reading them back is
   * what makes the choice durable across devices and reloads; the response also
   * carries the configured default so the UI can render an explicit "default".
   */
  // How well the dispatcher finds past tasks (owner only, like all of /settings).
  router.get("/settings/recall", requireKind("primary"), requireSession, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    res.setHeader("Cache-Control", "no-store");
    res.json({ stats: recallStats(db, ctxOf(req).session!.ownerId, days) });
  });

  // Invite codes for self-registration (owner only, like all of /settings).
  router.get("/settings/invites", requireKind("primary"), requireSession, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ invites: listInvites(db) });
  });
  router.post("/settings/invites", requireKind("primary"), requireSession, (req, res) => {
    const invite = createInvite(db, typeof req.body?.note === "string" ? req.body.note : "");
    audit(db, "invite_created", undefined, ctxOf(req).ip);
    res.json({ invite });
  });
  router.delete("/settings/invites/:code", requireKind("primary"), requireSession, (req, res) => {
    if (!revokeInvite(db, String(req.params.code))) { res.status(409).json({ error: "not_revocable", message: t().http.auth.inviteNotRevocable }); return; }
    audit(db, "invite_revoked", undefined, ctxOf(req).ip);
    res.json({ ok: true });
  });

  // Owner debug: how one message was dispatched, step by step (owner only, like all of /settings).
  router.get("/settings/dispatch-log/:taskId", requireKind("primary"), requireSession, (req, res) => {
    const ownerId = ctxOf(req).session!.ownerId;
    const task = db.prepare("SELECT id,title,input_text,status FROM tasks WHERE id=?").get(String(req.params.taskId)) as { id: string; title: string; input_text: string; status: string } | undefined;
    res.setHeader("Cache-Control", "no-store");
    if (!task || !context.tasks.belongsTo(task.id, ownerId)) { res.status(404).json({ error: "not_found", message: t().http.tasks.notFound }); return; }
    res.json({ task: { id: task.id, title: task.title, text: task.input_text, status: task.status }, entries: dispatchLog(db, ownerId, task.id) });
  });

  router.get(
    "/settings",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      const settings = agent.agentSettings();
      let models: Array<{
        id: string;
        displayName: string;
        supportedReasoningEfforts: string[];
        defaultReasoningEffort: string | null;
        inputModalities: string[];
        modelProvider: string | null;
      }> = [];
      try {
        models = (await agent.listModels()).map((m) => ({
          id: m.id,
          displayName: m.displayName,
          supportedReasoningEfforts: m.supportedReasoningEfforts,
          defaultReasoningEffort: m.defaultReasoningEffort,
          inputModalities: m.inputModalities,
          modelProvider: m.modelProvider ?? null,
        }));
      } catch {
        // A settings read must still answer with the stored choice when the model
        // catalog is temporarily unavailable; validation happens on save.
        models = [];
      }
      // `savedModelAvailable` is null when the catalog is unknown: the UI must not
      // claim a stored model is unusable just because Codex is not up yet.
      const savedModelAvailable =
        models.length === 0 ? null : settings.model === null || models.some((m) => m.id === settings.model);
      res.json({ settings, defaultModel: cfg.agent.defaultModel, models, savedModelAvailable });
    }),
  );

  /**
   * Save the unified settings. A partial body is merged with the stored value so
   * a caller may update just the model; a malformed or unknown field is refused
   * (never silently coerced) and the stored choice is left untouched on failure.
   */
  router.put(
    "/settings",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const body: unknown = req.body ?? {};
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ error: "invalid_settings", message: t().http.settings.notObject });
        return;
      }
      const record = body as Record<string, unknown>;
      if (!("model" in record) && !("effort" in record)) {
        res.status(400).json({ error: "invalid_settings", message: t().http.settings.nothingToSave });
        return;
      }
      let models: Array<{ id: string; displayName: string; supportedReasoningEfforts: string[]; defaultReasoningEffort: string | null }>;
      try {
        models = await agent.listModels();
      } catch (err) {
        res.status(503).json({ error: "models_unavailable", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (models.length === 0) {
        res.status(503).json({ error: "models_unavailable", message: t().http.settings.modelsUnavailable });
        return;
      }
      const stored = agent.agentSettings();
      // Merge a partial body over the stored value, then validate the whole thing.
      const candidate = {
        model: "model" in record ? record.model : stored.model,
        effort: "effort" in record ? record.effort : stored.effort,
      };
      const result = agent.saveAgentSettings(candidate, models);
      if (!result.ok) {
        res.status(400).json({ error: "invalid_settings", message: result.message });
        return;
      }
      audit(db, "agent_settings_updated", JSON.stringify(result.settings), ctxOf(req).ip);
      res.json({ ok: true, settings: result.settings });
    }),
  );

  // ----------------------------------------------------------- phone

  // The account's own phone: whether it has one (host USB for the owner, or a linked Mac) and whether it is connected.
  // The screen itself is a WebSocket (PhoneGateway).
  router.get(
    "/phone",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const userId = ctxOf(req).session!.ownerId;
      if (!context.phone?.available(userId)) { res.json({ available: false, device: null }); return; }
      const status = await context.phone.status(userId);
      res.json({ available: true, reachable: status !== null, device: status?.device ?? null });
    }),
  );
  // The screen now, for a task card that used the phone.
  router.get(
    "/phone/screenshot",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const shot = await context.phone?.screenshot(ctxOf(req).session!.ownerId);
      if (!shot) { res.status(404).json({ error: "phone_unavailable", message: t().http.phone.notConnected }); return; }
      res.setHeader("Cache-Control", "no-store");
      res.type(shot.type).send(shot.body);
    }),
  );

  // Macs this account linked to offer their phones (the app's bridge dials in with the token, DeviceLinks).
  // The token is returned once, to the console that asked for it, which hands it to the app.
  router.get("/device-links", requireKind("primary"), requireSession, (req, res) => {
    res.json({ links: context.deviceLinks?.list(ctxOf(req).session!.ownerId) ?? [] });
  });
  router.post("/device-links", requireKind("primary"), requireSession, (req, res) => {
    if (!context.deviceLinks) { res.status(404).json({ error: "not_found" }); return; }
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const { link, token } = context.deviceLinks.create(ctxOf(req).session!.ownerId, name);
    audit(db, "device_link_created", link.id, ctxOf(req).ip);
    res.setHeader("Cache-Control", "no-store");
    res.json({ link, token });
  });
  router.delete("/device-links/:id", requireKind("primary"), requireSession, (req, res) => {
    const removed = context.deviceLinks?.revoke(ctxOf(req).session!.ownerId, String(req.params.id)) ?? false;
    if (removed) audit(db, "device_link_revoked", String(req.params.id), ctxOf(req).ip);
    res.status(removed ? 200 : 404).json({ ok: removed });
  });

  // ----------------------------------------------------------- capabilities

  router.get(
    "/capabilities",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      const [inventory, mcpServers, skills, jupyter, code] = await Promise.all([
        aio.buildInventory(),
        aio.mcpServers(),
        aio.skills(),
        aio.jupyterInfo(),
        aio.codeInfo(),
      ]);
      res.json({
        inventory,
        mcpServers,
        skills,
        jupyter: summarize(jupyter),
        code: summarize(code),
        workspaceOrigin: workspaceOrigin(ctxOf(_req), cfg),
      });
    }),
  );

  // ------------------------------------------------------- sandbox helpers

  const sandboxFetch = async (pathname: string, init: RequestInit = {}, timeoutMs = 60_000) => {
    return await container.fetch(pathname, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Run a command in the sandbox and wait (bounded) for a final result. Never
   * reports success while the process is still running or when the exit code is
   * non-zero.
   */
  const runSandboxCommand = async (command: string, timeoutMs = cfg.sandbox.fileOpTimeoutMs): Promise<ShellOutcome> => {
    const res = await sandboxFetch("/v1/shell/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, exec_dir: "/home/gem" }),
    });
    const payload = (await res.json()) as { data?: { session_id?: string } };
    const sessionId = String(payload?.data?.session_id ?? "");
    let outcome = interpretShellResult(payload);
    const deadline = Date.now() + timeoutMs;
    while (!outcome.ok && outcome.status === "running" && sessionId && Date.now() < deadline) {
      await sleep(400);
      const view = await sandboxFetch("/v1/shell/view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const viewJson = (await view.json()) as { success?: boolean; data?: Record<string, unknown> };
      if (viewJson.success && viewJson.data) outcome = interpretShellResult({ success: true, data: viewJson.data });
      else break;
    }
    return outcome;
  };

  /** Confirm the sandbox's view of a path: exists + isDirectory, or absent. */
  const statSandboxPath = async (target: string): Promise<{ exists: boolean; isDirectory: boolean }> => {
    const res = await sandboxFetch("/v1/file/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    const json = (await res.json()) as { success?: boolean; data?: Record<string, unknown> | null };
    if (!json.success || !json.data) return { exists: false, isDirectory: false };
    return { exists: true, isDirectory: true };
  };

  /** File manager: all paths are sandbox paths, validated as absolute. */
  router.get(
    "/files/list",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = requireAbsoluteSandboxPath(String(req.query.path ?? cfg.sandbox.containerWorkspaceDir));
      if (!checked.ok) {
        res.status(400).json({ error: "bad_path", message: checked.message });
        return;
      }
      const upstream = await sandboxFetch("/v1/file/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: checked.path }),
      });
      const json = (await upstream.json()) as { success?: boolean; data?: unknown; message?: string };
      const opError = fileOperationError(json.data);
      if (!json.success || opError) {
        res.status(502).json({ error: "list_failed", message: opError ?? json.message ?? t().http.files.listFailed });
        return;
      }
      res.json(json.data);
    }),
  );

  router.get(
    "/files/read",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = requireAbsoluteSandboxPath(String(req.query.path ?? ""));
      if (!checked.ok) {
        res.status(400).json({ error: "bad_path", message: checked.message });
        return;
      }
      const upstream = await sandboxFetch("/v1/file/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: checked.path }),
      });
      const json = (await upstream.json()) as { success?: boolean; data?: { content?: string }; message?: string };
      const opError = fileOperationError(json.data);
      if (!json.success || opError) {
        res.status(502).json({ error: "read_failed", message: opError ?? json.message ?? t().http.files.readFailed });
        return;
      }
      res.json({ path: checked.path, content: json.data?.content ?? "" });
    }),
  );

  router.post(
    "/files/write",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = requireAbsoluteSandboxPath(String(req.body?.path ?? ""));
      if (!checked.ok) {
        res.status(400).json({ error: "bad_path", message: checked.message });
        return;
      }
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      const upstream = await sandboxFetch("/v1/file/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: checked.path, content }),
      });
      const json = (await upstream.json()) as { success?: boolean; data?: unknown; message?: string };
      const opError = fileOperationError(json.data);
      if (!json.success || opError) {
        res.status(502).json({ error: "write_failed", message: opError ?? json.message ?? t().http.files.writeFailed });
        return;
      }
      res.json({ ok: true, path: checked.path });
    }),
  );

  router.post(
    "/files/delete",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = requireAbsoluteSandboxPath(String(req.body?.path ?? ""));
      if (!checked.ok) {
        res.status(400).json({ error: "bad_path", message: checked.message });
        return;
      }
      if (checked.path === "/" || checked.path === cfg.sandbox.containerWorkspaceDir) {
        res.status(400).json({ error: "bad_path", message: t().http.files.rootDelete });
        return;
      }
      // The pinned image has no unlink endpoint, so deletion runs inside the sandbox shell.
      const outcome = await runSandboxCommand(`rm -rf -- ${shellQuote(checked.path)}`);
      if (!outcome.ok) {
        res.status(502).json({ error: "delete_failed", message: outcome.message ?? t().http.files.deleteFailed, detail: outcome.output.slice(0, 500) });
        return;
      }
      const stillThere = await statSandboxPath(checked.path);
      if (stillThere.exists) {
        res.status(502).json({ error: "delete_unverified", message: t().http.files.deleteUnverified });
        return;
      }
      res.json({ ok: true, path: checked.path });
    }),
  );

  router.post(
    "/files/mkdir",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = requireAbsoluteSandboxPath(String(req.body?.path ?? ""));
      if (!checked.ok) {
        res.status(400).json({ error: "bad_path", message: checked.message });
        return;
      }
      const outcome = await runSandboxCommand(`mkdir -p -- ${shellQuote(checked.path)}`);
      if (!outcome.ok) {
        res.status(502).json({ error: "mkdir_failed", message: outcome.message ?? t().http.files.mkdirFailed, detail: outcome.output.slice(0, 500) });
        return;
      }
      const stat = await statSandboxPath(checked.path);
      if (!stat.exists || !stat.isDirectory) {
        res.status(502).json({ error: "mkdir_unverified", message: t().http.files.mkdirUnverified });
        return;
      }
      res.json({ ok: true, path: checked.path });
    }),
  );

  router.get(
    "/files/download",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = requireAbsoluteSandboxPath(String(req.query.path ?? ""));
      if (!checked.ok) {
        res.status(400).json({ error: "bad_path", message: checked.message });
        return;
      }
      // Streamed like /documents/media: a large file is not held in memory, and a client that leaves stops the read.
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.on("close", cancel);
      try {
        const upstream = await container.fetch(`/v1/file/download?path=${encodeURIComponent(checked.path)}`,
          { method: "GET", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]) });
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          res.status(502).json({ error: "download_failed", message: t().http.files.downloadFailed });
          return;
        }
        res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
        for (const key of ["content-disposition", "content-length"]) {
          const value = upstream.headers.get(key); if (value) res.setHeader(key, value);
        }
        await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res);
      } catch (err) {
        if (res.headersSent || controller.signal.aborted) { res.destroy(); return; }
        throw err;
      } finally { res.off("close", cancel); }
    }),
  );

  // -------------------------------------------------- documents (sandbox tools)

  /**
   * Every document path is validated twice: lexically here (absolute, inside the
   * workspace root, no traversal/control characters/`-` segments) and again
   * inside the container via `realpath`, so a symlink that points outside the
   * workspace is refused even when the lexical path looked valid.
   */
  const checkedDocumentPath = (input: string): string => {
    const checked = requireWorkspaceFilePath(input, cfg.sandbox.containerWorkspaceDir);
    if (!checked.ok) throw new DocumentError("outside_workspace", checked.message, 400);
    return checked.path;
  };

  const documentHandler =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof DocumentError) {
          res.status(err.status).json({ error: err.code, message: err.message });
          return;
        }
        log.error("document endpoint failed", { url: req.url, error: err instanceof Error ? err.message : String(err) });
        res.status(502).json({ error: "document_failed", message: t().http.files.documentsUnavailable });
      }
    };

  router.get(
    "/documents/readiness",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const force = String(req.query.refresh ?? "") === "1";
      res.setHeader("Cache-Control", "no-store");
      res.json(await context.documents.readiness(force));
    }),
  );

  /** Explicit operator action: install/verify the sandbox document toolchain. */
  router.post(
    "/documents/provision",
    requireKind("primary"),
    requireSession,
    documentHandler(async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const result = await context.documents.provision();
      res.status(result.ok ? 200 : 502).json(result);
    }),
  );

  /** Metadata for the preview dialog: kind, page count, size, truncation. */
  router.get(
    "/documents/info",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      const kind = documentKind(target);
      const stat = await context.documents.stat(target);
      if (!stat.exists) {
        res.status(404).json({ error: "not_found", message: t().http.files.notFound });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        path: target,
        kind,
        size: stat.size,
        renderable: isRenderableKind(kind),
        textPreviewable: kind === "text",
      });
    }),
  );

  /**
   * Render a workspace document to page rasters inside the sandbox. The reply
   * carries metadata only: page images are fetched one at a time from
   * `/documents/page`, so a large preview never has to be held in one response.
   */
  router.get(
    "/documents/render",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      const result = await context.documents.render(target);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        path: target,
        kind: result.kind,
        pageCount: result.pageCount,
        totalPages: result.totalPages,
        truncated: result.truncated,
        size: result.size,
      });
    }),
  );

  /**
   * One rasterised page. Deliberately the only document bytes the browser ever
   * receives: an authenticated PNG with `nosniff`/`no-store`, never the original
   * Office/PDF bytes (those are only ever served as an attachment download).
   */
  router.get(
    "/documents/page",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      const index = Number.parseInt(String(req.query.page ?? "1"), 10);
      const page = await context.documents.page(target, index);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", "inline");
      res.end(page.bytes);
    }),
  );

  /**
   * Convert a workspace document to a NEW file inside the sandbox. The original
   * is never modified; the target format is validated against a fixed allowlist
   * and the command shape is built server-side.
   */
  router.post(
    "/documents/convert",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.body?.path ?? ""));
      const format = String(req.body?.format ?? "");
      const result = await context.documents.convert(target, format);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    }),
  );

  /**
   * One workspace image served inline, with a sniffed image content type.
   *
   * Deliberately separate from `/files/download` (octet-stream + attachment,
   * unusable in an `<img>`): only a file whose kind is `image` *and* whose bytes
   * carry a real image magic number is returned, always `inline` with
   * `nosniff`/`no-store`. Nothing here can be used to fetch a non-image or a
   * host file.
   */
  router.get(
    "/documents/image",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      // `known`: the version of a copy the console already keeps; unchanged answers 304, no bytes.
      const known = typeof req.query.known === "string" ? req.query.known : undefined;
      const image = await context.documents.image(target, known);
      res.setHeader("Cache-Control", "no-store");
      if ("notModified" in image) {
        res.setHeader("ETag", image.etag);
        res.status(304).end();
        return;
      }
      if (image.etag) res.setHeader("ETag", image.etag);
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // An SVG opened on its own (not through an <img>) still runs no script and
      // loads nothing: an opaque, scriptless origin.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox");
      res.setHeader("Content-Disposition", "inline");
      res.end(image.bytes);
    }),
  );

  // A web picture in a message (a product photo): the console's CSP admits only
  // this origin, so the account's sandbox fetches it and only image bytes return.
  router.get("/documents/web-image", requireKind("primary"), requireSession,
    documentHandler(async (req, res) => {
      const image = await context.documents.webImage(String(req.query.url ?? ""));
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("Content-Disposition", "inline");
      res.end(image.bytes);
    }),
  );

  // Audio and video for the console's players (`/documents/video` is the older name, kept for open pages).
  router.get(["/documents/media", "/documents/video"], requireKind("primary"), requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.on("close", cancel);
      try {
        const upstream = await context.documents.media(target, req.headers.range, req.method === "HEAD",
          AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]));
        res.status(upstream.status);
        res.setHeader("Content-Type", mediaType(target) ?? "application/octet-stream");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Accept-Ranges", "bytes");
        for (const key of ["content-length", "content-range"]) {
          const value = upstream.headers.get(key); if (value) res.setHeader(key, value);
        }
        if (upstream.body && req.method !== "HEAD") {
          await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res);
        } else { await upstream.body?.cancel(); res.end(); }
      } catch (err) {
        if (res.headersSent || controller.signal.aborted) { res.destroy(); return; }
        throw err;
      } finally { res.off("close", cancel); }
    }),
  );

  // Never serve agent HTML with the console origin's privileges. Both the
  // response and the embedding frame enforce an opaque sandbox origin.
  router.get("/documents/html", requireKind("workspace"), requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      if (!/\.html?$/i.test(target)) {
        res.status(400).json({error:"unsupported",message:t().http.files.htmlOnly}); return;
      }
      const result = await context.documents.text(target);
      if (result.truncated) {
        res.status(413).json({error:"too_large",message:t().http.files.pageTooLarge}); return;
      }
      res.setHeader("Content-Security-Policy", `${HTML_PREVIEW_CSP}; frame-ancestors ${cfg.primaryOrigins.join(" ")}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      res.end(htmlPreviewDocument(result.text));
    }),
  );

  /** Small text files shown inline; binary or oversized content is refused. */
  router.get(
    "/documents/text",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      const result = await context.documents.text(target);
      res.setHeader("Cache-Control", "no-store");
      res.json({ path: target, ...result });
    }),
  );

  /**
   * Generic sandbox API explorer. Restricted to the sandbox's own API surface so
   * it cannot be used as an arbitrary host-side request tool.
   */
  router.post(
    "/sandbox/request",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const method = String(req.body?.method ?? "GET").toUpperCase();
      const pathname = String(req.body?.path ?? "");
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        res.status(400).json({ error: "bad_method", message: t().http.sandbox.badMethod });
        return;
      }
      if (!/^\/(v1|mcp|cdp|json)(\/|$|\?)/.test(pathname)) {
        res.status(400).json({ error: "bad_path", message: t().http.sandbox.badPath });
        return;
      }
      const upstream = await sandboxFetch(pathname, {
        method,
        headers: req.body?.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: req.body?.body !== undefined ? JSON.stringify(req.body.body) : undefined,
      });
      const text = await upstream.text();
      res.status(upstream.status).json({
        status: upstream.status,
        contentType: upstream.headers.get("content-type"),
        body: text.length > 200_000 ? `${text.slice(0, 200_000)}\n${t().http.sandbox.truncated}` : text,
      });
    }),
  );

  router.get(
    "/sandbox/terminal-url",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      const upstream = await sandboxFetch("/v1/shell/terminal-url");
      const json = (await upstream.json()) as { success?: boolean; data?: string };
      res.json({ ok: Boolean(json.success), url: json.data ?? null });
    }),
  );

  maps.useGoogle(cfg.googleMapsKey);
  /** Which map the cards draw: one Google static image, or OpenStreetMap tiles. */
  router.get("/map", requireKind("primary"), requireSession, (_req, res) => {
    res.json({ provider: maps.provider });
  });
  /** A Google static map for a map card, proxied like the tiles (see MapService). */
  router.get("/map/static", requireKind("primary"), requireSession,
    asyncHandler(async (req, res) => {
      if (maps.provider !== "google") { res.status(404).json({error:"not_configured"}); return; }
      const request = MapService.staticRequest(req.query);
      if (!request) { res.status(400).json({error:"bad_map"}); return; }
      const image = await maps.staticMap(request).catch(() => null);
      if (!image) { res.status(502).json({error:"map_unavailable"}); return; }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(image);
    }),
  );
  /** Map tiles for map cards in messages, proxied so the console stays same-origin (see MapService). */
  router.get("/map/tiles/:z/:x/:y", requireKind("primary"), requireSession,
    asyncHandler(async (req, res) => {
      const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => (/^\d{1,7}$/.test(String(v)) ? Number(v) : -1)) as [number, number, number];
      if (!MapService.validTile(z, x, y)) { res.status(400).json({error:"bad_tile"}); return; }
      const tile = await maps.tile(z, x, y).catch(() => null);
      if (!tile) { res.status(502).json({error:"tile_unavailable"}); return; }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=604800");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(tile);
    }),
  );
  /** Where an address is, for a map card that came without coordinates. */
  router.get("/map/geocode", requireKind("primary"), requireSession,
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q || q.length > 200) { res.status(400).json({error:"bad_query",message:t().http.maps.badQuery}); return; }
      try {
        res.setHeader("Cache-Control", "private, max-age=86400");
        res.json({place: await maps.geocode(q)});
      } catch {
        res.status(502).json({error:"geocode_unavailable",message:t().http.maps.geocodeFailed});
      }
    }),
  );

  // ----------------------------------------------------------- cameras
  // Camera cards in messages (HaCameras): live video, pan/tilt and recordings,
  // proxied same-origin and only for the accounts granted Home Assistant.
  const camerasFor = (req: Request, res: Response): HaCameras | null => {
    const ctx = ctxOf(req);
    const user = ctx.session ? getUser(db, ctx.session.ownerId) : null;
    if (!context.cameras || !user || !cfg.haMcp.accounts.includes(user.username)) {
      res.status(404).json({ error: "camera_unavailable", message: t().http.cameras.notEnabled });
      return null;
    }
    return context.cameras;
  };
  const cameraEntity = (req: Request, res: Response): string | null => {
    const entity = param(req, "entity");
    if (/^camera\.[a-z0-9_]+$/.test(entity)) return entity;
    res.status(400).json({ error: "bad_camera" });
    return null;
  };
  const cameraHandler = (fn: (req: Request, res: Response, cameras: HaCameras, entity: string) => Promise<void>) =>
    asyncHandler(async (req, res) => {
      const cameras = camerasFor(req, res);
      const entity = cameras && (req.params.token ? "" : cameraEntity(req, res));
      if (!cameras || entity === null) return;
      try {
        await fn(req, res, cameras, entity);
      } catch (err) {
        if (!(err instanceof CameraError)) throw err;
        if (res.headersSent) { res.destroy(); return; }
        const notFound = err.message === "not_found";
        res.status(notFound ? 404 : 502).json({ error: notFound ? "not_found" : "camera_error", message: notFound ? t().http.cameras.recordingGone : err.message });
      }
    });
  const cameraTime = (raw: unknown): number | null => (typeof raw === "string" && /^\d{12,14}$/.test(raw) ? Number(raw) : parseLocal(raw));
  router.get("/cameras/hls/:token/*file", requireKind("primary"), requireSession,
    cameraHandler(async (req, res, cameras) => {
      const file = (req.params as { file?: string[] }).file ?? [];
      await cameras.proxyHls(param(req, "token"), file.join("/"), req.url.split("?")[1] ?? "", res);
    }),
  );
  router.get("/cameras/:entity", requireKind("primary"), requireSession,
    cameraHandler(async (_req, res, cameras, entity) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ camera: await cameras.camera(entity), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    }),
  );
  router.get("/cameras/:entity/snapshot", requireKind("primary"), requireSession,
    cameraHandler(async (_req, res, cameras, entity) => {
      const shot = await cameras.snapshot(entity, 1280);
      res.setHeader("Content-Type", shot.contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(shot.bytes);
    }),
  );
  router.get("/cameras/:entity/live", requireKind("primary"), requireSession,
    cameraHandler(async (_req, res, cameras, entity) => {
      const token = await cameras.liveToken(entity);
      res.setHeader("Cache-Control", "no-store");
      res.json({ url: `/api/cameras/hls/${token}/master_playlist.m3u8` });
    }),
  );
  router.post("/cameras/:entity/ptz", requireKind("primary"), requireSession,
    cameraHandler(async (req, res, cameras, entity) => {
      const body = (req.body ?? {}) as { direction?: unknown; steps?: unknown; preset?: unknown };
      res.json({ ok: true, done: await cameras.ptz(entity, { direction: body.direction, steps: body.steps, preset: body.preset }) });
    }),
  );
  router.get("/cameras/:entity/playback", requireKind("primary"), requireSession,
    cameraHandler(async (req, res, cameras, entity) => {
      const at = cameraTime(req.query.at);
      if (at === null) { res.status(400).json({ error: "bad_time", message: t().http.cameras.badTime }); return; }
      const { piece, offset, next } = await cameras.locate(entity, at);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        url: `/api/cameras/${entity}/recordings/${encodeURIComponent(piece.file)}`,
        offset, start: piece.start, end: piece.end,
        // The next piece plays on when it follows straight after this one.
        next: next && next.start - piece.end < 60_000 ? next.start : null,
      });
    }),
  );
  router.get("/cameras/:entity/frame", requireKind("primary"), requireSession,
    cameraHandler(async (req, res, cameras, entity) => {
      const at = cameraTime(req.query.at);
      if (at === null) { res.status(400).json({ error: "bad_time" }); return; }
      const bytes = await cameras.frame(entity, at);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(bytes);
    }),
  );
  router.get("/cameras/:entity/recordings/:file", requireKind("primary"), requireSession,
    cameraHandler(async (req, res, cameras, entity) => {
      await cameras.proxyPiece(entity, param(req, "file"), req.get("range") ?? undefined, res);
    }),
  );

  // Interactive terminals only: see TerminalRegistry for why the sandbox's own list is not used.
  const terminals = new TerminalRegistry(db);
  router.get("/sandbox/shell-sessions", requireKind("primary"), requireSession,
    asyncHandler(async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const state = await container.inspect();
        const sessions = terminals.list(state.startedAt, state.running).map((t) => ({
          id: t.id, status: "ready", workingDir: cfg.sandbox.containerWorkspaceDir, lastUsedAt: new Date(t.createdAt).toISOString(),
        }));
        res.json({sessions});
      } catch {
        res.status(502).json({error:"sessions_unavailable",message:t().http.sandbox.terminalsUnavailable});
      }
    }),
  );

  router.post("/sandbox/shell-sessions", requireKind("primary"), requireSession,
    asyncHandler(async (_req, res) => {
      // The terminal page attaches only to sessions made here, not to /v1/shell/sessions/create ones.
      const upstream = await sandboxFetch("/v1/shell/terminal-url", {}, 15_000);
      const result = await upstream.json().catch(() => null) as {success?:boolean;data?:unknown}|null;
      let id: string | null = null;
      try { id = typeof result?.data === "string" ? new URL(result.data).searchParams.get("session_id") : null; } catch { id = null; }
      if (!upstream.ok || !result?.success || !id || !TERMINAL_ID.test(id)) { res.status(502).json({message:t().http.sandbox.terminalCreateFailed}); return; }
      terminals.add(id);
      res.status(201).json({id});
    }),
  );
  router.delete("/sandbox/shell-sessions/:id", requireKind("primary"), requireSession,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!TERMINAL_ID.test(id)) { res.status(400).json({message:t().http.sandbox.badTerminal}); return; }
      if (!terminals.has(id)) { res.status(404).json({message:t().http.sandbox.terminalGone}); return; }
      try {
        await exitTerminal(container.upstream(), id);
      } catch {
        res.status(502).json({message:t().http.sandbox.terminalCloseFailed}); return;
      }
      terminals.remove(id);
      res.json({ok:true});
    }),
  );

  /**
   * Upload a file into the sandbox through the control plane. The browser never
   * gets a direct sandbox credential; the server relays to the sandbox API.
   */
  router.post(
    "/sandbox/upload",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const contentBase64 = typeof req.body?.contentBase64 === "string" ? req.body.contentBase64 : "";
      if (!name || !contentBase64) {
        res.status(400).json({ error: "bad_request", message: t().http.files.uploadMissing });
        return;
      }
      const buffer = Buffer.from(contentBase64, "base64");
      if (buffer.byteLength > 25 * 1024 * 1024) {
        res.status(413).json({ error: "too_large", message: t().http.files.uploadTooLarge });
        return;
      }
      const safeName = name.replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_").slice(-120) || "upload.bin";
      // Raw attachments land in a fixed workspace directory instead of the
      // workspace root. An explicit `dir` is still honoured for generic callers.
      const explicitDir = typeof req.body?.dir === "string" && req.body.dir.trim() ? req.body.dir.trim() : null;
      const requestedDir = explicitDir ?? `${cfg.sandbox.containerWorkspaceDir}/uploads`;
      const dirCheck = requireAbsoluteSandboxPath(requestedDir);
      if (!dirCheck.ok) {
        res.status(400).json({ error: "bad_path", message: dirCheck.message });
        return;
      }
      const dir = dirCheck.path;
      // Only the fixed default uploads directory is created automatically. An
      // explicit `dir` keeps the previous contract: the caller's directory must
      // already exist, and the API never creates an arbitrary sandbox path.
      if (!explicitDir) {
        const mkdir = await runSandboxCommand(`mkdir -p -- ${shellQuote(dir)}`);
        if (!mkdir.ok) {
          res.status(502).json({ error: "mkdir_failed", message: mkdir.message ?? t().http.files.uploadDirFailed, detail: mkdir.output.slice(0, 500) });
          return;
        }
        const dirStat = await statSandboxPath(dir);
        if (!dirStat.exists || !dirStat.isDirectory) {
          res.status(502).json({ error: "mkdir_unverified", message: t().http.files.uploadDirUnverified });
          return;
        }
      }
      // A short random segment prevents two same-millisecond uploads with the same
      // name from overwriting each other.
      const target = `${dir === "/" ? "" : dir}/${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)]), safeName);
      form.append("path", target);
      const upstream = await container.fetch("/v1/file/upload", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await upstream.json()) as { success?: boolean; message?: string };
      if (!upstream.ok || json.success === false) {
        res.status(502).json({ error: "upload_failed", message: json.message ?? t().http.files.uploadFailed });
        return;
      }
      const kind = /^image\//.test(String(req.body?.mime ?? "")) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(safeName) ? "image" : "file";
      res.json({ path: target, name: safeName, kind, size: buffer.byteLength });
    }),
  );

  router.get(
    "/sandbox/context",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      res.json({ context: await aio.sandboxContext() });
    }),
  );

  /**
   * Open a link in a new tab of the sandbox's real Chromium. Narrow by design:
   * the body only carries a URL, the URL must be http/https without credentials,
   * and this endpoint can never drive any other sandbox API or a host browser.
   */
  router.post(
    "/browser/tabs",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const checked = parseHttpUrl(typeof req.body?.url === "string" ? req.body.url : "");
      if (!checked.ok) {
        res.status(400).json({ error: "bad_url", message: checked.message });
        return;
      }
      // An idle browser may have been released: bring it back before opening anything.
      // Failures answer 503 with the reason (a 502 is replaced by the edge's own page).
      try {
        await context.browser.wake();
      } catch (err) {
        res.status(503).json({ error: "browser_wake_failed", message: err instanceof Error ? err.message : t().http.browser.wakeFailedRetry });
        return;
      }
      // A link the person opens gets a tab of their own, operated from the console
      // like a taken-over task tab; without the tab server it is a plain browser tab.
      if (context.tabs) {
        const opened = await context.tabs.open(checked.url);
        if (opened.status === 200 && opened.body.tab) { res.json({ ok: true, message: t().http.browser.opened, data: null, tab: opened.body.tab }); return; }
      }
      const result = await aio.createBrowserTab(checked.url);
      if (!result.ok) {
        res.status(503).json({ error: "browser_tab_failed", message: t().http.browser.openFailed(result.message) });
        return;
      }
      res.json({ ok: true, message: result.message, data: result.data ?? null });
    }),
  );

  /**
   * Open a workspace HTML page in a tab of the person's own in the sandbox
   * Chromium, shown in the console like an opened link. A page too large for
   * the inline preview, or one that loads its own images, styles and scripts,
   * renders there in full. The file stays inside the sandbox: only its resolved
   * path inside the workspace becomes a file:// address there.
   */
  router.post(
    "/browser/files",
    requireKind("primary"),
    requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.body?.path ?? ""));
      if (!/\.(html?|xhtml)$/i.test(target)) {
        res.status(415).json({ error: "unsupported", message: t().http.browser.htmlOnly });
        return;
      }
      const stat = await context.documents.stat(target);
      if (!stat.exists || !stat.isFile) {
        res.status(404).json({ error: "not_found", message: t().http.files.notFound });
        return;
      }
      if (!context.tabs) {
        res.status(503).json({ error: "browser_unavailable", message: t().http.browser.sandboxBrowserUnavailable });
        return;
      }
      try {
        await context.browser.wake();
      } catch (err) {
        res.status(503).json({ error: "browser_wake_failed", message: err instanceof Error ? err.message : t().http.browser.wakeFailedRetry });
        return;
      }
      const opened = await context.tabs.open(pathToFileURL(stat.realPath).href);
      if (opened.status !== 200 || !opened.body.tab) {
        res.status(503).json({ error: "browser_tab_failed", message: t().http.browser.openPageFailed });
        return;
      }
      res.json({ ok: true, tab: opened.body.tab });
    }),
  );

  // --------------------------------------------------- workspace companion

  router.post(
    "/workspace/ticket",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const issued = tickets.issue(ctx.session!.id);
      // A member's workspace lives under its own path prefix on the shared companion origin.
      const prefix = context.runtimeForUser ? workspacePrefix(getUser(db, ctx.session!.ownerId)!.username) : "";
      const next = prefix + safeRedirectPath(typeof req.body?.next === "string" ? req.body.next : "/");
      const origin = workspaceOrigin(ctx, cfg);
      res.json({
        ticket: issued.ticket,
        expiresAt: issued.expiresAt,
        origin,
        url: `${origin}${prefix}/_bootstrap?ticket=${encodeURIComponent(issued.ticket)}&next=${encodeURIComponent(next)}`,
      });
    }),
  );

  router.get(
    "/workspace/session",
    requireKind("workspace"),
    asyncHandler(async (_req, res, ctx) => {
      const owner = ctx.session ? getUser(db, ctx.session.ownerId) : null;
      res.json({
        authenticated: Boolean(ctx.session),
        kind: "workspace",
        username: owner?.username ?? null,
        expiresAt: ctx.session?.expiresAt ?? null,
      });
    }),
  );

  router.post(
    "/workspace/refresh",
    requireKind("workspace"),
    requireSession,
    asyncHandler(async (_req, res, ctx) => {
      const fromAllowedOrigin =
        Boolean(ctx.origin) &&
        (originAllowed(cfg, "workspace", ctx.origin) || originAllowed(cfg, "primary", ctx.origin));
      if (!fromAllowedOrigin) {
        res.status(403).json({ error: "origin_denied", message: t().http.common.originDenied });
        return;
      }
      const renewed = sessions.heartbeat(ctx.session!);
      if (!renewed) {
        res.setHeader("Set-Cookie", clearSessionCookies("workspace", ctx.secure));
        res.status(401).json({ error: "session_expired", message: t().http.session.workspaceExpired });
        return;
      }
      const csrf = ctx.cookies[COOKIE_NAMES.workspace.csrf] ?? "";
      res.setHeader("Set-Cookie", sessionCookies("workspace", ctx.cookies[COOKIE_NAMES.workspace.session]!, csrf, { secure: ctx.secure, ttlMs: cfg.sessionTtlMs }));
      res.json({ ok: true, expiresAt: renewed.expiresAt });
    }),
  );

  router.post(
    "/workspace/logout",
    requireKind("workspace"),
    requireSession,
    asyncHandler(async (_req, res, ctx) => {
      context.browser.releaseViewersForSession(ctx.session!.id);
      sessions.revoke(ctx.session!.id, "workspace-logout");
      res.setHeader("Set-Cookie", clearSessionCookies("workspace", ctx.secure));
      res.json({ ok: true });
    }),
  );

  // ------------------------------------------------- browser lifecycle API

  /**
   * Read-only browser lifecycle status. Deliberately in-memory and never waking:
   * a status poll must not keep the browser alive or extend its idle deadline, so
   * the UI can show a countdown that is still allowed to reach zero.
   */
  router.get(
    "/browser/status",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      res.json({ status: browserStatusPayload(context.browser.status()) });
    }),
  );

  /**
   * A visible browser/desktop panel heartbeats here. The lease is bound to the
   * session, so a logout can drop it, and to a per-window generation, so a
   * heartbeat that was already in flight when the panel hid cannot resurrect a
   * cancelled lease.
   */
  router.post(
    "/browser/viewer/heartbeat",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      if (!id || id.length > 128) {
        res.status(400).json({ error: "bad_viewer_id", message: t().http.browser.badViewer });
        return;
      }
      const generation = Number.isFinite(Number(req.body?.generation)) ? Math.trunc(Number(req.body.generation)) : 0;
      const lease = context.browser.touchViewer(id, ctx.session!.id, generation);
      if (!lease) {
        // The panel's incarnation was already released; it must remount rather
        // than assume it still holds the browser awake.
        res.status(409).json({ error: "stale_viewer", message: t().http.browser.staleViewer });
        return;
      }
      res.json({ ok: true, generation: lease.generation, status: browserStatusPayload(context.browser.status()) });
    }),
  );

  /** Explicit release when a panel hides, closes or switches away. */
  router.post(
    "/browser/viewer/release",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      // The generation is optional for backward compatibility, but when present a
      // late release from an old incarnation can no longer drop a newer panel.
      const generation = Number.isFinite(Number(req.body?.generation))
        ? Math.trunc(Number(req.body.generation))
        : undefined;
      if (id) context.browser.releaseViewer(id, generation, ctx.session!.id);
      res.json({ ok: true, status: browserStatusPayload(context.browser.status()) });
    }),
  );

  /** Keep-alive pin: protects the browser for work the control plane cannot see. */
  router.post(
    "/browser/pin",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      // `ui: true` (or no note at all) is the browser panel's own keep-awake
      // switch: it is identified by a fixed note, idempotent, and rebuildable
      // from `status().pins`, so a reload can always release it. A caller that
      // passes its own note (a script, an operator) keeps today's behaviour.
      const ttlMs = Number(req.body?.ttlMs);
      const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.trunc(ttlMs) : undefined;
      const raw = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      const pin = req.body?.ui === true
        ? context.browser.pinUiKeepAlive()
        : context.browser.pin((raw || t().http.browser.manualPin).slice(0, 120), Math.min(ttl ?? cfg.browser.keepAliveMs, cfg.browser.keepAliveMs));
      res.json({
        ok: true,
        pin: { id: pin.id, note: pin.note, expiresAt: Number.isFinite(pin.expiresAt) ? pin.expiresAt : null },
        status: browserStatusPayload(context.browser.status()),
      });
    }),
  );

  router.post(
    "/browser/pin/release",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      if (id) context.browser.unpin(id);
      // A panel that lost its pin id (reload, second window) releases by the fixed
      // UI note instead; a note-carrying request never touches other pins.
      if (req.body?.ui === true) context.browser.unpinUiKeepAlive();
      res.json({ ok: true, status: browserStatusPayload(context.browser.status()) });
    }),
  );

  /** Explicit wake/retry, used when an automatic restore failed. */
  router.post(
    "/browser/wake",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      try {
        await context.browser.wake();
        res.json({ ok: true, status: browserStatusPayload(context.browser.status()) });
      } catch (err) {
        // The lifecycle always throws a fixed, secret-free sentence, but the
        // code is what the UI keys its retry text on.
        const message = err instanceof Error ? err.message : t().http.browser.wakeFailed;
        res.status(502).json({ error: "browser_wake_failed", message, status: browserStatusPayload(context.browser.status()) });
      }
    }),
  );

  /**
   * Cross-origin access from the control plane only. Explicit allowlist, never a
   * wildcard, and credentials are permitted so the browser can upload into the
   * companion origin when it is same-site.
   */
  return router;
}

/** SSE stream of persisted conversation events with replay and revocation handling. */
function streamEvents(
  context: AppContext,
  req: Request,
  res: Response,
  ctx: RequestContext,
  conversationId: string,
  since: number,
): void {
  const { agent, sessions, log } = context;
  // Written later from timers and other requests' events, so the request's language is taken now.
  const m = t().http.session;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const member = isMember(context.db, ctx.session!.ownerId);
  let lastId = since;
  // Replay the full backlog in pages so long histories reconnect completely.
  const REPLAY_PAGE = 2000;
  const MAX_REPLAY = 50_000;
  let replayed = 0;
  for (;;) {
    const page = agent.listEvents(conversationId, lastId, REPLAY_PAGE);
    if (!page.length) break;
    for (const event of page) {
      writeEvent(res, member ? publicPayload(event) : event);
      lastId = event.id;
      replayed++;
    }
    if (page.length < REPLAY_PAGE || replayed >= MAX_REPLAY) break;
  }
  res.write(`event: replay.complete\ndata: ${JSON.stringify({ lastEventId: lastId, replayed })}\n\n`);

  const listener = (event: AgentEvent) => {
    if (event.conversationId !== conversationId) return;
    if (event.id <= lastId) return;
    lastId = event.id;
    writeEvent(res, member ? publicPayload(event) : event);
  };
  agent.events.on("event", listener);

  const heartbeat = setInterval(() => {
    if (!ctx.session || !sessions.isLive(ctx.session.id)) {
      res.write(`event: session.revoked\ndata: ${JSON.stringify({ message: m.expired })}\n\n`);
      cleanup();
      res.end();
      return;
    }
    res.write(`: ping ${Date.now()}\n\n`);
  }, 20_000);

  const onRevoked = (sessionId: string) => {
    if (sessionId !== ctx.session?.id) return;
    res.write(`event: session.revoked\ndata: ${JSON.stringify({ message: m.revoked })}\n\n`);
    cleanup();
    res.end();
  };
  sessions.events.on("revoked", onRevoked);

  function cleanup(): void {
    clearInterval(heartbeat);
    agent.events.off("event", listener);
    sessions.events.off("revoked", onRevoked);
  }

  res.on("close", () => {
    cleanup();
    log.debug("SSE client disconnected", { conversationId });
  });
}

function writeEvent(res: Response, event: AgentEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify({ id: event.id, type: event.type, turnId: event.turnId, createdAt: event.createdAt, payload: event.payload })}\n\n`);
}


/** Outcome of a sandbox shell command, including the case where it never finished. */
export interface ShellOutcome {
  ok: boolean;
  status: string;
  exitCode: number | null;
  output: string;
  message?: string;
}

/**
 * Interpret a `/v1/shell/exec` payload. A `success: true` envelope only means the
 * request was accepted: the command itself may have failed or still be running.
 */
export function interpretShellResult(payload: unknown): ShellOutcome {
  const root = (payload ?? {}) as { success?: boolean; message?: string; data?: Record<string, unknown> | null };
  if (root.success === false) {
    return { ok: false, status: "rejected", exitCode: null, output: "", message: root.message ?? t().http.files.commandRejected };
  }
  const data = root.data ?? {};
  const status = String(data.status ?? "unknown");
  const rawExit = data.exit_code;
  const exitCode = typeof rawExit === "number" ? rawExit : null;
  const output = typeof data.output === "string" ? data.output : "";
  if (status === "running") {
    return { ok: false, status, exitCode, output, message: t().http.files.commandRunning };
  }
  if (status !== "completed") {
    return { ok: false, status, exitCode, output, message: t().http.files.commandStatus(status) };
  }
  if (exitCode !== 0) {
    return { ok: false, status, exitCode, output, message: t().http.files.commandExit(exitCode) };
  }
  return { ok: true, status, exitCode, output };
}

/** Detect the structured FileOperationError that file endpoints may return in `data`. */
export function fileOperationError(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { error_type?: unknown; message?: unknown };
  if (typeof record.error_type === "string" && record.error_type) {
    return typeof record.message === "string" && record.message ? record.message : record.error_type;
  }
  return null;
}

/** Sandbox paths must be absolute container paths; the host filesystem is never touched. */
export function requireAbsoluteSandboxPath(input: string): { ok: true; path: string } | { ok: false; message: string } {
  const value = input.trim();
  if (!value) return { ok: false, message: t().http.files.missingPath };
  if (!value.startsWith("/")) return { ok: false, message: t().http.files.relativePath };
  if (value.includes("\u0000") || value.includes("\n")) return { ok: false, message: t().http.files.badChars };
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return { ok: true, path: `/${parts.join("/")}` };
}

/** Single-quote a path for the sandbox shell so it cannot break out of the argv. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function summarize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  if (json.length <= 4000) return value;
  return { truncated: true, length: json.length, preview: json.slice(0, 4000) };
}

export { asyncHandler, requireKind, requireSession, ctxOf, audit };
