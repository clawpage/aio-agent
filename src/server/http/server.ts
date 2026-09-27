import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AppContext } from "../context.js";
import { createApiRouter } from "./api.js";
import { endSocket, handleProxyHttp, handleProxyUpgrade } from "./proxy.js";
import { resolveRequest, type RequestContext } from "./security.js";
import { COOKIE_NAMES, sessionCookies } from "../auth/sessions.js";
import { safeRedirectPath } from "../auth/tickets.js";
import { audit } from "../db.js";

export const WEB_DIST = path.resolve(import.meta.dirname, "..", "..", "..", "dist", "web");

function attach(req: Request, ctx: RequestContext | null): void {
  if (ctx) req.paCtx = ctx;
}

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false); // we read only explicitly configured headers

  // A configured retired host is redirect-only, never a second API origin.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const legacy = ctx.cfg.legacyPrimaryHost;
    const host = (req.headers.host ?? "").toLowerCase().replace(/:443$/, "");
    if (!legacy || legacy === ctx.cfg.primaryHost || host !== legacy) { next(); return; }
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" || req.method === "HEAD") res.redirect(302, `https://${ctx.cfg.primaryHost}/`);
    else res.status(410).json({error:"moved",message:"入口已迁移，请从新域名登录"});
  });

  // Host classification happens first: an unknown Host never reaches any handler.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const resolved = resolveRequest({ cfg: ctx.cfg, sessions: ctx.sessions, req });
    if (!resolved) {
      ctx.log.warn("rejected unknown host", { host: req.headers.host ?? null, url: req.url });
      res.status(404).json({ error: "unknown_host", message: "Not Found" });
      return;
    }
    if (resolved.session && ctx.sessions.isLive(resolved.session.id) === false) {
      resolved.session = null;
    }
    attach(req, resolved);
    next();
  });

  // Minimal, unauthenticated liveness/readiness. No identities, ids or errors.
  app.get("/healthz", (_req, res) => {
    void (async () => {
      const [sandbox, hostAuth] = await Promise.all([ctx.container.isReady(), ctx.hostTokens.status()]);
      const agentStatus = await ctx.agent.status();
      // Editor/notebook/terminal readiness is part of real health, not just /health.
      const surfaces = ctx.sandboxSurfaces ?? {};
      const servicesReady = ["terminal", "codeServer", "jupyter"].every((name) => surfaces[name] === true);
      const dependenciesReady = sandbox && hostAuth.ok && servicesReady;
      const agentReady = agentStatus.sessionReady;
      res.status(200).json({
        ok: true,
        service: "personal-agent",
        uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        // Truthful, secret-free readiness split into dependencies and agent, so a
        // running container with a broken Codex session is not reported as ready.
        dependenciesReady,
        servicesReady,
        agentReady,
        ready: dependenciesReady && agentReady,
      });
    })();
  });

  /**
   * Body parsing is scoped to the control API only. The companion origin streams
   * raw request bodies straight to the sandbox, so parsing here would consume
   * them (breaking file writes, browser navigation and uploads).
   */
  const jsonParser = express.json({ limit: "32mb" });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rec = req.paCtx!;
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }
    if (rec.kind === "workspace" && !req.path.startsWith("/api/workspace")) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });

  // Companion-origin bootstrap: one-time ticket -> host-only workspace session cookie.
  app.get("/_bootstrap", (req: Request, res: Response) => {
    const rec = req.paCtx!;
    if (rec.kind !== "workspace") {
      res.status(404).send("Not Found");
      return;
    }
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
    const next = safeRedirectPath(typeof req.query.next === "string" ? req.query.next : "/");
    const consumed = ticket ? ctx.tickets.consume(ticket, { isValidSession: (id) => ctx.sessions.isLive(id) }) : null;
    if (!consumed) {
      ctx.log.warn("rejected workspace bootstrap ticket", { ip: rec.ip });
      res
        .status(403)
        .type("html")
        .send(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>需要授权</title>` +
            `<body style="font-family:system-ui;background:#111;color:#eee;padding:2rem"><h1>链接已失效</h1>` +
            `<p>该工作区入口票据已过期或已使用，请回到主控制台重新打开。</p></body></html>`,
        );
      return;
    }
    const { session, token, csrfToken } = ctx.sessions.create("owner_1", "workspace", {
      ip: rec.ip,
      userAgent: req.get("user-agent") ?? undefined,
      parentSessionId: consumed.sessionId,
    });
    res.setHeader("Set-Cookie", sessionCookies("workspace", token, csrfToken, { secure: rec.secure, ttlMs: ctx.cfg.sessionTtlMs }));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    audit(ctx.db, "workspace_bootstrap", session.id, rec.ip);
    // Redirect clears the one-time ticket from the URL and history entry.
    res.redirect(303, next);
  });

  app.use("/api", createApiRouter(ctx));

  // Everything else on the companion origin is the authenticated sandbox proxy.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rec = req.paCtx!;
    if (rec.kind !== "workspace") {
      next();
      return;
    }
    if (!rec.session) {
      if (req.method === "GET" && acceptsHtml(req)) {
        res
          .status(401)
          .type("html")
          .send(
            `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>需要登录</title>` +
              `<body style="font-family:system-ui;background:#111;color:#eee;padding:2rem"><h1>工作区需要授权</h1>` +
              `<p>请从主控制台（<a style="color:#7cc4ff" href="https://${ctx.cfg.primaryHost}">${ctx.cfg.primaryHost}</a>）打开工作区。</p></body></html>`,
          );
        return;
      }
      res.status(401).json({ error: "unauthenticated", message: "工作区需要授权" });
      return;
    }
    handleProxyHttp({ cfg: ctx.cfg, log: ctx.log, sessions: ctx.sessions, browser: ctx.browser.proxyGate() }, rec, req, res);
  });

  // Control-plane SPA.
  const hasBuild = fs.existsSync(path.join(WEB_DIST, "index.html"));
  if (hasBuild) {
    app.use(
      express.static(WEB_DIST, {
        index: false,
        setHeaders: (res) => {
          res.setHeader("X-Content-Type-Options", "nosniff");
        },
      }),
    );
  }
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rec = req.paCtx!;
    if (rec.kind !== "primary" || req.method !== "GET") {
      next();
      return;
    }
    if (req.path.startsWith("/api") || req.path === "/healthz") {
      next();
      return;
    }
    if (!hasBuild) {
      res.status(503).type("html").send("<h1>前端尚未构建</h1><p>请先运行 npm run build:web</p>");
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `frame-src 'self' https://${ctx.cfg.workspaceHost}`,
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });

  // Final fallbacks.
  app.use((req: Request, res: Response) => {
    const rec = req.paCtx!;
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(rec.kind === "primary" ? 404 : 404).json({ error: "not_found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    ctx.log.error("unhandled request error", { url: req.url, error: err.message });
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message: "服务器内部错误" });
  });

  return app;
}

function acceptsHtml(req: Request): boolean {
  return String(req.headers.accept ?? "").includes("text/html");
}

/** WebSocket / CDP upgrades are proxied to the sandbox only on the companion origin. */
export function handleUpgrade(ctx: AppContext, req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
  const rec = resolveRequest({ cfg: ctx.cfg, sessions: ctx.sessions, req });
  if (!rec || rec.kind !== "workspace") {
    endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const token = rec.cookies[COOKIE_NAMES.workspace.session];
  if (!rec.session || !token || !ctx.sessions.isLive(rec.session.id)) {
    endSocket(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  rec.session = ctx.sessions.resolve("workspace", token) ?? rec.session;
  handleProxyUpgrade({ cfg: ctx.cfg, log: ctx.log, sessions: ctx.sessions, browser: ctx.browser.proxyGate() }, rec, req, socket, head);
}
