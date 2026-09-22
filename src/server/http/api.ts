import express, { type Request, type Response, type NextFunction, type Router } from "express";
import type { AppContext } from "../context.js";
import { TurnConflictError } from "../codex/manager.js";
import type { AgentEvent } from "../codex/manager.js";
import type { HostKind, RequestContext } from "./security.js";
import { UNSAFE_METHODS, guardUnsafe, originAllowed } from "./security.js";
import { BOOTSTRAP_USERNAME, authenticateOwner, getOwner } from "../auth/owner.js";
import { COOKIE_NAMES, clearSessionCookies, sessionCookies } from "../auth/sessions.js";
import { safeRedirectPath } from "../auth/tickets.js";
import { audit } from "../db.js";

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

export function createApiRouter(context: AppContext): Router {
  const router = express.Router();
  const { cfg, sessions, tickets, limiter, agent, codex, aio, container, hostTokens, db, log } = context;

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
      const owner = await authenticateOwner(db, password);
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
      log.info("owner logged in", { ip: ctx.ip });
      res.json({ ok: true, username: owner.username, expiresAt: session.expiresAt });
    }),
  );

  router.post(
    "/auth/logout",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const session = ctx.session!;
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
      const owner = getOwner(db);
      if (!ctx.session) {
        res.json({ authenticated: false, kind: ctx.kind, username: owner?.username ?? null });
        return;
      }
      res.json({
        authenticated: true,
        kind: ctx.kind,
        username: owner?.username ?? BOOTSTRAP_USERNAME,
        expiresAt: ctx.session.expiresAt,
        secure: ctx.secure,
      });
    }),
  );

  // ------------------------------------------------------------- status/health

  router.get(
    "/status",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (_req, res) => {
      const [agentStatus, hostAuth, sandboxState, sandboxReady] = await Promise.all([
        agent.status(),
        hostTokens.status(),
        container.inspect(),
        container.isReady(),
      ]);
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
        },
        workspaceOrigin: workspaceOrigin(ctxOf(_req), cfg),
      });
    }),
  );

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    }),
  );

  // -------------------------------------------------------- conversations

  router.get(
    "/conversations",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res) => {
      const includeArchived = req.query.archived === "1";
      res.json({ conversations: agent.listConversations(includeArchived) });
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
      const conversation = agent.createConversation({ title, model, cwd });
      res.status(201).json({ conversation });
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
      if (typeof req.body?.title === "string") agent.renameConversation(id, req.body.title);
      if (typeof req.body?.archived === "boolean") agent.archiveConversation(id, req.body.archived);
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
        const { turn, duplicate } = agent.submitTurn({
          conversationId,
          text,
          clientMessageId,
          attachments,
          model: typeof req.body?.model === "string" ? req.body.model : null,
          effort: typeof req.body?.effort === "string" ? req.body.effort : null,
          cwd: typeof req.body?.cwd === "string" ? req.body.cwd : null,
        });
        res.status(duplicate ? 200 : 202).json({ turn, duplicate });
      } catch (err) {
        if (err instanceof TurnConflictError) {
          res.status(409).json({ error: "message_id_conflict", message: err.message });
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
      res.json({ approvals: agent.listPendingRequests(conversationId) });
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
        const models = await codex.listModels();
        res.json({
          models: models.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            description: m.description,
            isDefault: m.isDefault,
            reasoningEfforts: m.supportedReasoningEfforts,
            defaultReasoningEffort: m.defaultReasoningEffort,
            inputModalities: m.inputModalities,
          })),
        });
      } catch (err) {
        res.status(503).json({ error: "models_unavailable", message: err instanceof Error ? err.message : String(err), models: [] });
      }
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
    return await fetch(`http://127.0.0.1:${cfg.sandbox.hostPort}${pathname}`, {
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
      const requestedDir =
        typeof req.body?.dir === "string" && req.body.dir.trim() ? req.body.dir.trim() : cfg.sandbox.containerWorkspaceDir;
      const dirCheck = requireAbsoluteSandboxPath(requestedDir);
      if (!dirCheck.ok) {
        res.status(400).json({ error: "bad_path", message: dirCheck.message });
        return;
      }
      const dir = dirCheck.path;
      const target = `${dir === "/" ? "" : dir}/${Date.now()}-${safeName}`;
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)]), safeName);
      form.append("path", target);
      const upstream = await fetch(`http://127.0.0.1:${cfg.sandbox.hostPort}/v1/file/upload`, {
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

  // --------------------------------------------------- workspace companion

  router.post(
    "/workspace/ticket",
    requireKind("primary"),
    requireSession,
    asyncHandler(async (req, res, ctx) => {
      const issued = tickets.issue(ctx.session!.id);
      const next = safeRedirectPath(typeof req.body?.next === "string" ? req.body.next : "/");
      const origin = workspaceOrigin(ctx, cfg);
      res.json({
        ticket: issued.ticket,
        expiresAt: issued.expiresAt,
        origin,
        url: `${origin}/_bootstrap?ticket=${encodeURIComponent(issued.ticket)}&next=${encodeURIComponent(next)}`,
      });
    }),
  );

  router.get(
    "/workspace/session",
    requireKind("workspace"),
    asyncHandler(async (_req, res, ctx) => {
      const owner = getOwner(db);
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
      sessions.revoke(ctx.session!.id, "workspace-logout");
      res.setHeader("Set-Cookie", clearSessionCookies("workspace", ctx.secure));
      res.json({ ok: true });
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
      writeEvent(res, event);
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
    writeEvent(res, event);
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
