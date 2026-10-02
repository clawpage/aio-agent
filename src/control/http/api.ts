import {workspacePrefix} from "../auth/workspaceHost.js";
import { isMember, publicPayload } from "../auth/policy.js";
import {readSoul,writeSoul,SoulError,DEFAULT_SOUL,SOUL_MAX_BYTES} from '../soul.js';
import { HTML_PREVIEW_CSP, htmlPreviewDocument } from "../documents/html.js";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { exitTerminal, TERMINAL_ID, TerminalRegistry } from "../terminals.js";
import { maps, MapService } from "../maps.js";
import { API_MIN, API_VERSION } from "../../common/version.js";
import { appVersion } from "../../common/build.js";
import type { AppContext } from "../context.js";
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
import { parseHttpUrl } from "../aio/client.js";
import { COOKIE_NAMES, clearSessionCookies, sessionCookies } from "../auth/sessions.js";
import { safeRedirectPath } from "../auth/tickets.js";
import { audit } from "../db.js";
import { dispatchLog, recallStats } from "../tasks/recall.js";
import { PERSON_KEY } from "../browser/tabs.js";
import { DocumentError, type DocumentService } from "../documents/service.js";
import type { BrowserStatusView } from "../browser/service.js";
import { documentKind, isRenderableKind, requireWorkspaceFilePath } from "../documents/paths.js";

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
    res.status(401).json({ error: "unauthenticated", message: "请先登录" });
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
 * It deliberately exposes only counts, a Chinese state label and a Chinese idle
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
    stateLabel: BROWSER_STATE_LABELS[status.state] ?? status.state,
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

/** Chinese state labels shown in the browser panel; never machine identifiers. */
export const BROWSER_STATE_LABELS: Record<string, string> = {
  awake: "浏览器已就绪",
  idle: "浏览器空闲中，即将释放",
  snapshotting: "正在保存浏览器状态",
  asleep: "浏览器已释放，等待按需恢复",
  restoring: "正在恢复浏览器",
  error: "浏览器状态异常",
};

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
      res.setHeader("Access-Control-Allow-Headers", "content-type");
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
    const ownerPaths = ["/settings", "/models", "/capabilities", "/sandbox/context", "/documents/provision"];
    if (restricted && ownerPaths.some(p => pathname === p || pathname.startsWith(p + "/"))) {
      res.status(403).json({ error: "forbidden", message: "此操作仅限所有者" }); return;
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
        res.status(403).json({ error: "forbidden", message: "请通过主会话提交任务" }); return;
      }
    }
    next();
  });

  // ------------------------------------------------------------------ auth

  router.post(
    "/auth/login",
    requireKind("primary"),
    asyncHandler(async (req, res, ctx) => {
      // Login is unauthenticated, so it cannot rely on the session-bound CSRF
      // check above; validate Origin explicitly to block cross-site logins.
      if (!ctx.origin || !originAllowed(cfg, "primary", ctx.origin)) {
        res.status(403).json({ error: "origin_denied", message: "来源站点不被允许" });
        return;
      }
      const state = limiter.state(ctx.ip);
      if (state.locked) {
        res.status(429).json({
          error: "rate_limited",
          message: `尝试次数过多，请在 ${Math.ceil(state.retryAfterMs / 60000)} 分钟后重试`,
        });
        return;
      }
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!password) {
        res.status(400).json({ error: "password_required", message: "请输入密码" });
        return;
      }
      const username = typeof req.body?.username === "string" ? req.body.username.trim() : BOOTSTRAP_USERNAME;
      const owner = await authenticateUser(db, username, password);
      if (!owner) {
        const after = limiter.recordFailure(ctx.ip);
        audit(db, "login_failed", `failures=${after.failures}`, ctx.ip);
        res.status(401).json({
          error: "invalid_credentials",
          message: after.locked ? "密码错误次数过多，账号已临时锁定" : "密码错误",
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
      log.info("user logged in", { ip: ctx.ip });
      res.json({ ok: true, username: owner.username, role: owner.role, expiresAt: session.expiresAt });
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
      sessions.revokeLinked("primary", session.id, "parent-logout");
      res.setHeader("Set-Cookie", clearSessionCookies("primary", ctx.secure));
      audit(db, "logout", undefined, ctx.ip);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/auth/refresh",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const rotated = sessions.rotate(ctx.session!);
      if (!rotated) {
        res.setHeader("Set-Cookie", clearSessionCookies("primary", ctx.secure));
        res.status(401).json({ error: "session_expired", message: "会话已过期，请重新登录" });
        return;
      }
      const csrf = ctx.cookies[COOKIE_NAMES.primary.csrf] ?? "";
      res.setHeader("Set-Cookie", [
        ...sessionCookies("primary", rotated.token, csrf, { secure: ctx.secure, ttlMs: cfg.sessionTtlMs }).slice(0, 1),
        // keep the existing CSRF cookie value
        `${COOKIE_NAMES.primary.csrf}=${encodeURIComponent(csrf)}; Path=/; SameSite=Lax; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}${ctx.secure ? "; Secure" : ""}`,
      ]);
      res.json({ ok: true, expiresAt: rotated.expiresAt });
    }),
  );

  router.get(
    "/auth/session",
    asyncHandler(async (req, res, ctx) => {
      const owner = ctx.session ? getUser(db, ctx.session.ownerId) : null;
      if (!ctx.session) {
        res.json({ authenticated: false, kind: ctx.kind, username: owner?.username ?? null });
        return;
      }
      res.json({
        authenticated: true,
        kind: ctx.kind,
        username: owner?.username ?? null,
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
      const idle = context.idle && context.idle.state !== "running" ? context.idle.state : null;
      if (isMember(db, ctxOf(_req).session!.ownerId)) {
        res.json({ agent: { sessionReady: agentStatus.sessionReady, lastError: agentStatus.sessionReady ? null : "服务正在连接" },
          hostAuth: { ok: hostAuth.ok }, sandbox: { running: sandboxState.running, healthy: sandboxReady, surfaces: context.sandboxSurfaces, idle },
          workspaceOrigin: workspaceOrigin(ctxOf(_req), cfg) });
        return;
      }
      // Refresh surfaces on demand so the dashboard is not stuck on stale data.
      try {
        context.sandboxSurfaces = await container.surfaces();
      } catch {
        /* keep the previous snapshot */
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
   * The console is visible on a screen (sent every 20 s while it is). Together
   * with sandbox use this decides when an idle container is stopped, and a
   * stopped one starts warming up the moment its owner comes back.
   */
  router.post(
    "/presence",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      context.idle?.foreground();
      context.push?.presence(ctxOf(req).session!.ownerId);
      res.json({ ok: true });
    }),
  );

  /** Phone notifications (Web Push): the key to subscribe with, and this account's devices. */
  router.get("/push", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(context.push ? { supported: true, publicKey: context.push.publicKey, devices: context.push.count(ctxOf(req).session!.ownerId) } : { supported: false });
  }));
  router.post("/push/subscribe", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.push) { res.status(404).json({ error: "push_unavailable", message: "通知暂不可用" }); return; }
    try {
      context.push.subscribe(ctxOf(req).session!.ownerId, req.body?.subscription ?? {}, req.get("user-agent") ?? "");
      res.json({ ok: true, devices: context.push.count(ctxOf(req).session!.ownerId) });
    } catch (err) { res.status(400).json({ error: "bad_subscription", message: err instanceof Error ? err.message : "订阅无效" }); }
  }));
  router.post("/push/unsubscribe", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
    if (context.push && endpoint) context.push.unsubscribe(ctxOf(req).session!.ownerId, endpoint);
    res.json({ ok: true });
  }));
  router.post("/push/test", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    if (!context.push) { res.status(404).json({ error: "push_unavailable", message: "通知暂不可用" }); return; }
    const sent = await context.push.notify(ctxOf(req).session!.ownerId, { title: "一站通知已开启", body: "任务完成、需要你补充或确认时，会在这里提醒你。", tag: "test" }, { force: true });
    res.json({ sent });
  }));

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    }),
  );

  // -------------------------------------------------------- conversations

  router.get("/main", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    const page = context.tasks.list(Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, ctxOf(req).session!.ownerId);
    // One read of the tab record shows, per task, whether it has tabs, is waiting for
    // the person in the browser, or is being driven by the person right now.
    // The feed must not wait on a slow sandbox: past two seconds it shows tasks without browser state.
    const tabs = context.tabs ? await Promise.race([context.tabs.list().catch(() => []), new Promise<[]>((r) => setTimeout(() => r([]), 2000).unref())]) : [];
    const byKey = new Map<string, typeof tabs>();
    for (const tab of tabs) byKey.set(tab.key, [...(byKey.get(tab.key) ?? []), tab]);
    const tasks = page.tasks.map((task) => {
      const own = task.mergedInto ? undefined : byKey.get(task.conversationId);
      if (!own?.length) return task;
      const requested = own.find((t) => t.request && t.holder === "ai");
      return { ...task, browser: { tabs: own.length, request: requested?.request?.reason ?? null, human: own.some((t) => t.holder === "human") } };
    });
    res.json({ mode: "tasks", ...page, tasks });
  }));
  router.post("/tasks", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    try {
      const b = req.body ?? {};
      if (typeof b.text !== "string" || typeof b.clientMessageId !== "string") throw new Error("消息格式不正确");
      const attachments = Array.isArray(b.attachments) ? b.attachments.map((a: {path?:unknown;kind?:unknown;name?:unknown}) => {
        if (!a || typeof a.path !== "string") throw new Error("附件路径无效");
        const checked = requireWorkspaceFilePath(a.path, cfg.sandbox.containerWorkspaceDir);
        if (!checked.ok) throw new Error(checked.message);
        return { path: checked.path, kind: a.kind === "image" ? "image" as const : "file" as const, name: typeof a.name === "string" ? a.name : "" };
      }) : [];
      const result = context.tasks.submit({ userId: ctxOf(req).session!.ownerId, text: b.text, clientMessageId: b.clientMessageId, attachments, relatedTaskId: typeof b.relatedTaskId === "string" ? b.relatedTaskId : null });
      res.status(result.duplicate ? 200 : 202).json(result);
    } catch (err) {
      res.status(err instanceof TurnConflictError ? 409 : 400).json({ error: "task_submit_failed", message: err instanceof Error ? err.message : "任务提交失败" });
    }
  }));
  router.post("/tasks/:id/stop", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    try { await context.tasks.stop(param(req, "id")); res.json({ ok: true }); }
    catch (err) { res.status(409).json({ error: "stop_failed", message: err instanceof Error ? err.message : "停止失败" }); }
  }));
  router.post("/tasks/:id/retry-planning", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    try { context.tasks.retryPlanning(param(req, "id")); res.json({ ok: true }); }
    catch (err) { res.status(409).json({ error: "retry_refused", message: err instanceof Error ? err.message : "无法重试" }); }
  }));

  // Scheduled and recurring tasks: created by asking in the main session, managed here.
  router.get("/schedules", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ schedules: context.tasks.listSchedules(ctxOf(req).session!.ownerId) });
  }));
  router.post("/schedules/:id/:action", requireKind("primary"), requireSession, asyncHandler(async (req, res) => {
    const action = param(req, "action");
    const userId = ctxOf(req).session!.ownerId;
    try {
      if (action === "run") { res.json(context.tasks.runScheduleNow(param(req, "id"), userId)); return; }
      if (action !== "pause" && action !== "resume" && action !== "cancel") { res.status(404).json({ error: "not_found" }); return; }
      res.json(context.tasks.changeSchedule(param(req, "id"), userId, action));
    } catch (err) {
      const message = err instanceof Error ? err.message : "操作失败";
      res.status(message === "定时任务不存在" ? 404 : 409).json({ error: "schedule_refused", message });
    }
  }));

  // A task's browser tabs: what its agent is doing there, and the person taking over or handing back.
  const taskBrowserKey = (req: Request): string | null => {
    const id = param(req, "id");
    return context.tasks.belongsTo(id, ctxOf(req).session!.ownerId) ? context.tasks.browserKey(id) : null;
  };
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
    const tab = await context.tabs.control(key, String(req.body?.tab ?? ""), action);
    if (!tab) { res.status(404).json({ error: "tab_not_found", message: "这个标签页已经关闭或不属于该任务" }); return; }
    res.json({ tab });
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
        res.status(409).json({ error: "managed_task", message: "子任务由主会话管理" });
        return;
      }
      if ("title" in body) {
        if (typeof body.title !== "string") {
          res.status(400).json({ error: "invalid_title", message: "标题必须是字符串" });
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
            message: "已有一个活跃的空白默认会话，请先给它命名或归档，再使用这个标题",
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
              message: "已有一个活跃的空白默认会话，请先使用、重命名或归档它，再恢复这一个",
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
      const sinceParam = req.query.since ?? req.get("last-event-id");
      const since = Number.parseInt(String(sinceParam ?? "0"), 10);
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
        res.status(409).json({ error: "managed_task", message: "请在主会话提交关联任务" });
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
        res.status(400).json({ error: "empty_message", message: "消息不能为空" });
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
        res.status(400).json({ error: "bad_decision", message: "无效的处理决定" });
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
    res.json({ stats: recallStats(db, ctxOf(req).session!.ownerId, days, context.tasks.recall.cap()) });
  });

  // Owner debug: how one message was dispatched, step by step (owner only, like all of /settings).
  router.get("/settings/dispatch-log/:taskId", requireKind("primary"), requireSession, (req, res) => {
    const ownerId = ctxOf(req).session!.ownerId;
    const task = db.prepare("SELECT id,title,input_text,status FROM tasks WHERE id=?").get(String(req.params.taskId)) as { id: string; title: string; input_text: string; status: string } | undefined;
    res.setHeader("Cache-Control", "no-store");
    if (!task || !context.tasks.belongsTo(task.id, ownerId)) { res.status(404).json({ error: "not_found", message: "任务不存在" }); return; }
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
        res.status(400).json({ error: "invalid_settings", message: "设置必须是一个对象" });
        return;
      }
      const record = body as Record<string, unknown>;
      if (!("model" in record) && !("effort" in record)) {
        res.status(400).json({ error: "invalid_settings", message: "缺少要保存的设置" });
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
        res.status(503).json({ error: "models_unavailable", message: "暂时无法获取模型列表，请稍后重试" });
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
        res.status(502).json({ error: "list_failed", message: opError ?? json.message ?? "列目录失败" });
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
        res.status(502).json({ error: "read_failed", message: opError ?? json.message ?? "读取失败" });
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
        res.status(502).json({ error: "write_failed", message: opError ?? json.message ?? "写入失败" });
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
        res.status(400).json({ error: "bad_path", message: "不允许删除工作区根目录" });
        return;
      }
      // The pinned image has no unlink endpoint, so deletion runs inside the sandbox shell.
      const outcome = await runSandboxCommand(`rm -rf -- ${shellQuote(checked.path)}`);
      if (!outcome.ok) {
        res.status(502).json({ error: "delete_failed", message: outcome.message ?? "删除失败", detail: outcome.output.slice(0, 500) });
        return;
      }
      const stillThere = await statSandboxPath(checked.path);
      if (stillThere.exists) {
        res.status(502).json({ error: "delete_unverified", message: "命令已执行，但沙箱中该路径仍然存在" });
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
        res.status(502).json({ error: "mkdir_failed", message: outcome.message ?? "创建目录失败", detail: outcome.output.slice(0, 500) });
        return;
      }
      const stat = await statSandboxPath(checked.path);
      if (!stat.exists || !stat.isDirectory) {
        res.status(502).json({ error: "mkdir_unverified", message: "命令已执行，但沙箱中未确认该目录存在" });
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
      const upstream = await sandboxFetch(
        `/v1/file/download?path=${encodeURIComponent(checked.path)}`,
        { method: "GET" },
        120_000,
      );
      if (!upstream.ok || !upstream.body) {
        res.status(502).json({ error: "download_failed", message: "下载失败" });
        return;
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
      const disposition = upstream.headers.get("content-disposition");
      if (disposition) res.setHeader("Content-Disposition", disposition);
      res.end(Buffer.from(await upstream.arrayBuffer()));
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
        res.status(502).json({ error: "document_failed", message: "文档服务暂时不可用" });
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
        res.status(404).json({ error: "not_found", message: "文件不存在或已被移动" });
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
      const image = await context.documents.image(target);
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // An SVG opened on its own (not through an <img>) still runs no script and
      // loads nothing: an opaque, scriptless origin.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", "inline");
      res.end(image.bytes);
    }),
  );

  router.get("/documents/video", requireKind("primary"), requireSession,
    documentHandler(async (req, res) => {
      const target = checkedDocumentPath(String(req.query.path ?? ""));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.on("close", cancel);
      try {
        const upstream = await context.documents.video(target, req.headers.range, req.method === "HEAD",
          AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]));
        res.status(upstream.status);
        res.setHeader("Content-Type", "video/mp4");
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
        res.status(400).json({error:"unsupported",message:"仅支持 HTML 页面"}); return;
      }
      const result = await context.documents.text(target);
      if (result.truncated) {
        res.status(413).json({error:"too_large",message:"页面过大，请下载完整文件查看"}); return;
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
        res.status(400).json({ error: "bad_method", message: "不支持的请求方法" });
        return;
      }
      if (!/^\/(v1|mcp|cdp|json)(\/|$|\?)/.test(pathname)) {
        res.status(400).json({ error: "bad_path", message: "仅允许访问沙箱自身的 /v1、/mcp、/cdp 接口" });
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
        body: text.length > 200_000 ? `${text.slice(0, 200_000)}\n…(已截断)` : text,
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
      if (!q || q.length > 200) { res.status(400).json({error:"bad_query",message:"缺少有效的地址"}); return; }
      try {
        res.setHeader("Cache-Control", "private, max-age=86400");
        res.json({place: await maps.geocode(q)});
      } catch {
        res.status(502).json({error:"geocode_unavailable",message:"暂时无法定位这个地址"});
      }
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
        res.status(502).json({error:"sessions_unavailable",message:"暂时无法读取终端会话，请重试"});
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
      if (!upstream.ok || !result?.success || !id || !TERMINAL_ID.test(id)) { res.status(502).json({message:"创建终端失败，请重试"}); return; }
      terminals.add(id);
      res.status(201).json({id});
    }),
  );
  router.delete("/sandbox/shell-sessions/:id", requireKind("primary"), requireSession,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!TERMINAL_ID.test(id)) { res.status(400).json({message:"无效的终端会话 ID"}); return; }
      if (!terminals.has(id)) { res.status(404).json({message:"终端不存在或已结束"}); return; }
      try {
        await exitTerminal(container.upstream(), id);
      } catch {
        res.status(502).json({message:"关闭终端失败，会话可能仍在运行，请刷新后核对"}); return;
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
        res.status(400).json({ error: "bad_request", message: "缺少文件名或内容" });
        return;
      }
      const buffer = Buffer.from(contentBase64, "base64");
      if (buffer.byteLength > 25 * 1024 * 1024) {
        res.status(413).json({ error: "too_large", message: "文件不能超过 25MB" });
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
          res.status(502).json({ error: "mkdir_failed", message: mkdir.message ?? "创建附件目录失败", detail: mkdir.output.slice(0, 500) });
          return;
        }
        const dirStat = await statSandboxPath(dir);
        if (!dirStat.exists || !dirStat.isDirectory) {
          res.status(502).json({ error: "mkdir_unverified", message: "命令已执行，但沙箱中未确认附件目录存在" });
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
        res.status(502).json({ error: "upload_failed", message: json.message ?? "上传失败" });
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
        res.status(503).json({ error: "browser_wake_failed", message: err instanceof Error ? err.message : "浏览器恢复失败，请稍后重试" });
        return;
      }
      // A link the person opens gets a tab of their own, operated from the console
      // like a taken-over task tab; without the tab server it is a plain browser tab.
      if (context.tabs) {
        const opened = await context.tabs.open(checked.url);
        if (opened.status === 200 && opened.body.tab) { res.json({ ok: true, message: "已打开", data: null, tab: opened.body.tab }); return; }
      }
      const result = await aio.createBrowserTab(checked.url);
      if (!result.ok) {
        res.status(503).json({ error: "browser_tab_failed", message: `打开链接失败：${result.message}` });
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
        res.status(415).json({ error: "unsupported", message: "只有 HTML 页面可以在浏览器里打开" });
        return;
      }
      const stat = await context.documents.stat(target);
      if (!stat.exists || !stat.isFile) {
        res.status(404).json({ error: "not_found", message: "文件不存在或已被移动" });
        return;
      }
      if (!context.tabs) {
        res.status(503).json({ error: "browser_unavailable", message: "沙箱浏览器暂不可用" });
        return;
      }
      try {
        await context.browser.wake();
      } catch (err) {
        res.status(503).json({ error: "browser_wake_failed", message: err instanceof Error ? err.message : "浏览器恢复失败，请稍后重试" });
        return;
      }
      const opened = await context.tabs.open(pathToFileURL(stat.realPath).href);
      if (opened.status !== 200 || !opened.body.tab) {
        res.status(503).json({ error: "browser_tab_failed", message: "在浏览器里打开页面失败，请稍后重试" });
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
        res.status(403).json({ error: "origin_denied", message: "来源站点不被允许" });
        return;
      }
      const rotated = sessions.rotate(ctx.session!);
      if (!rotated) {
        res.setHeader("Set-Cookie", clearSessionCookies("workspace", ctx.secure));
        res.status(401).json({ error: "session_expired", message: "工作区会话已过期" });
        return;
      }
      const csrf = ctx.cookies[COOKIE_NAMES.workspace.csrf] ?? "";
      res.setHeader("Set-Cookie", [
        ...sessionCookies("workspace", rotated.token, csrf, { secure: ctx.secure, ttlMs: cfg.sessionTtlMs }).slice(0, 1),
        `${COOKIE_NAMES.workspace.csrf}=${encodeURIComponent(csrf)}; Path=/; SameSite=Lax; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}${ctx.secure ? "; Secure" : ""}`,
      ]);
      res.json({ ok: true, expiresAt: rotated.expiresAt });
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
        res.status(400).json({ error: "bad_viewer_id", message: "缺少有效的观看标识" });
        return;
      }
      const generation = Number.isFinite(Number(req.body?.generation)) ? Math.trunc(Number(req.body.generation)) : 0;
      const lease = context.browser.touchViewer(id, ctx.session!.id, generation);
      if (!lease) {
        // The panel's incarnation was already released; it must remount rather
        // than assume it still holds the browser awake.
        res.status(409).json({ error: "stale_viewer", message: "该面板的观看授权已失效，请重新打开浏览器面板" });
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
        : context.browser.pin((raw || "手动保留").slice(0, 120), ttl);
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
        const message = err instanceof Error ? err.message : "浏览器恢复失败";
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
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  let lastId = since;
  // Replay the full backlog in pages so long histories reconnect completely.
  const REPLAY_PAGE = 2000;
  const MAX_REPLAY = 50_000;
  let replayed = 0;
  for (;;) {
    const page = agent.listEvents(conversationId, lastId, REPLAY_PAGE);
    if (!page.length) break;
    for (const event of page) {
      writeEvent(res, isMember(context.db, ctx.session!.ownerId) ? publicPayload(event) : event);
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
    writeEvent(res, isMember(context.db, ctx.session!.ownerId) ? publicPayload(event) : event);
  };
  agent.events.on("event", listener);

  const heartbeat = setInterval(() => {
    if (!ctx.session || !sessions.isLive(ctx.session.id)) {
      res.write(`event: session.revoked\ndata: ${JSON.stringify({ message: "会话已过期" })}\n\n`);
      cleanup();
      res.end();
      return;
    }
    res.write(`: ping ${Date.now()}\n\n`);
  }, 20_000);

  const onRevoked = (sessionId: string) => {
    if (sessionId !== ctx.session?.id) return;
    res.write(`event: session.revoked\ndata: ${JSON.stringify({ message: "会话已注销" })}\n\n`);
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
    return { ok: false, status: "rejected", exitCode: null, output: "", message: root.message ?? "沙箱拒绝了该命令" };
  }
  const data = root.data ?? {};
  const status = String(data.status ?? "unknown");
  const rawExit = data.exit_code;
  const exitCode = typeof rawExit === "number" ? rawExit : null;
  const output = typeof data.output === "string" ? data.output : "";
  if (status === "running") {
    return { ok: false, status, exitCode, output, message: "命令仍在运行，无法确认执行结果" };
  }
  if (status !== "completed") {
    return { ok: false, status, exitCode, output, message: `命令状态异常（${status}）` };
  }
  if (exitCode !== 0) {
    return { ok: false, status, exitCode, output, message: `命令退出码 ${exitCode ?? "未知"}` };
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
  if (!value) return { ok: false, message: "缺少路径" };
  if (!value.startsWith("/")) return { ok: false, message: "路径必须是沙箱内的绝对路径" };
  if (value.includes("\u0000") || value.includes("\n")) return { ok: false, message: "路径包含非法字符" };
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
