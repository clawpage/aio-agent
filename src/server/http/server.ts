import fs from "node:fs";
import {WORKSPACE_PREFIX,userNamespace,workspaceConfig} from "../auth/workspaceHost.js";
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

/** Control API calls served by the sandbox; a container stopped for idleness starts first. */
const SANDBOX_API = /^\/(files|documents|sandbox|models)(\/|$)|^\/browser\/(?!status$)|^\/tasks\/[^/]+\/browser/;

/** Only a page load (a person opening or reloading a workspace page) may start a stopped container. */
function isNavigation(req: import("node:http").IncomingMessage): boolean {
  return req.headers["sec-fetch-mode"] === "navigate";
}
const PARKED_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>环境已休眠</title>` +
  `<body style="font-family:system-ui;background:#111;color:#eee;padding:2rem"><h1>环境空闲已休眠</h1>` +
  `<p>刷新页面即可唤醒（约半分钟），或回到主控制台。</p></body></html>`;

function attach(req: Request, ctx: RequestContext | null): void {
  if (ctx) req.paCtx = ctx;
}

/**
 * Which account a companion-origin request belongs to. A workspace URL carries
 * `/u/<username>` (or, from older links, a member's `/u/<namespace>`): the prefix
 * is stripped before any handler runs, and a workspace session of any other
 * account is dropped (fail closed). Requests without the prefix, or with a
 * `/u/...` that names no account (a sandbox app's own path), belong to the
 * account of the workspace session itself, so every request still reaches only
 * that session's own sandbox.
 */
function resolveAppRequest(ctx:AppContext,req:import("node:http").IncomingMessage):RequestContext|null {
  const rec=resolveRequest({cfg:ctx.cfg,sessions:ctx.sessions,req});
  if(rec?.kind!=='workspace'||!ctx.runtimeForUser)return rec;
  const match=WORKSPACE_PREFIX.exec(req.url??'');
  const users=match?ctx.db.prepare("SELECT id,username,role FROM owners").all() as {id:string;username:string;role:string}[]:[];
  const account=match?users.find(u=>u.username===match[1])??users.find(u=>u.role==='member'&&userNamespace(u.id)===match[1]):undefined;
  if(!match||!account){
    rec.workspaceUserId=rec.session?.ownerId??'owner_1';
    return rec;
  }
  const rest=(req.url??'').slice(match[0].length);
  req.url=rest.startsWith('/')?rest:`/${rest}`;
  rec.workspaceUserId=account.id;
  if(rec.session?.ownerId!==account.id)rec.session=null;
  return rec;
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
    const resolved = resolveAppRequest(ctx,req);
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

  // Public share pages: the one unauthenticated path on the workspace origin, served in a CSP sandbox.
  app.use((req: Request, res: Response, next: NextFunction) => (ctx.share ? ctx.share.serve()(req, res, next) : next()));

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
    // A frame reloaded on its own (a phone returning from the background) replays its
    // spent ticket; a live workspace session of this account needs no new one.
    if (!consumed && rec.session?.kind === "workspace") {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(303, next);
      return;
    }
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
    const parent = ctx.db.prepare("SELECT owner_id FROM sessions WHERE id=? AND kind='primary'").get(consumed.sessionId) as {owner_id:string}|undefined;
    if(!parent || (rec.workspaceUserId && rec.workspaceUserId!==parent.owner_id)){res.status(403).send("Invalid parent session");return;}
    const { session, token, csrfToken } = ctx.sessions.create(parent.owner_id, "workspace", {
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

  const rootApi=createApiRouter(ctx);
  const workspaceApis=new Map<string,ReturnType<typeof createApiRouter>>();
  const tenantApis=new WeakMap<AppContext,ReturnType<typeof createApiRouter>>();
  app.use("/api", async (req:Request,res:Response,next:NextFunction)=>{
    const id=req.paCtx?.session?.ownerId;
    if(ctx.runtimeForUser && req.paCtx?.kind==='workspace' && req.paCtx.workspaceUserId && req.paCtx.workspaceUserId!=='owner_1' && /^\/workspace(\/|$)/.test(req.path)){
      const account=req.paCtx.workspaceUserId;
      let api=workspaceApis.get(account);
      if(!api){api=createApiRouter({...ctx,cfg:workspaceConfig(ctx.cfg)});workspaceApis.set(account,api);}
      api(req,res,next);return;
    }
    if(!id || !ctx.runtimeForUser || /^\/(auth|workspace)(\/|$)/.test(req.path)) {rootApi(req,res,next);return;}
    try {
      const runtime=await ctx.runtimeForUser(id);
      if(!ctx.sessions.isLive(req.paCtx!.session!.id)){res.status(401).json({error:"unauthenticated"});return;}
      let api=tenantApis.get(runtime);
      if(!api){api=createApiRouter(runtime);tenantApis.set(runtime,api);}
      if(runtime.idle && SANDBOX_API.test(req.path)){
        const release=runtime.idle.hold();res.on("close",release);
        await runtime.idle.wake();
      }
      api(req,res,next);
    } catch {res.status(503).json({error:"runtime_unavailable",message:"独立环境暂不可用，请稍后重试"});}
  });

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
    void (async()=>{
      try {
        const runtime=ctx.runtimeForUser?await ctx.runtimeForUser(rec.session!.ownerId):ctx;
        if(runtime.idle){
          // A refused request must not count as use either, or it would cancel a stop in progress.
          if(!await runtime.idle.enter(isNavigation(req))){
            res.setHeader("Cache-Control","no-store");
            if(acceptsHtml(req))res.status(503).type("html").send(PARKED_HTML);
            else res.status(503).json({error:"sandbox_parked",message:"环境空闲已休眠，刷新页面即可唤醒"});
            return;
          }
          const release=runtime.idle.hold();res.on("close",release);
        }
        if(!ctx.sessions.isLive(rec.session!.id)){res.status(401).end();return;}
        handleProxyHttp({cfg:runtime.cfg,log:runtime.log,sessions:ctx.sessions,browser:runtime.browser.proxyGate()},rec,req,res);
      } catch {res.status(503).json({error:"runtime_unavailable"});}
    })();
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
  const rec = resolveAppRequest(ctx,req);
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
  void (async()=>{
    try {
      const runtime=ctx.runtimeForUser?await ctx.runtimeForUser(rec.session!.ownerId):ctx;
      // An open socket is not use by itself (a hidden tab keeps its editor socket); only its start wakes.
      if(runtime.idle){
        if(!await runtime.idle.enter(false)){endSocket(socket,"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return;}
        runtime.idle.touch();
      }
      if(!ctx.sessions.isLive(rec.session!.id)){endSocket(socket,"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return;}
      const idle=runtime.idle;
      handleProxyUpgrade({cfg:runtime.cfg,log:runtime.log,sessions:ctx.sessions,browser:runtime.browser.proxyGate(),activity:idle?()=>idle.touch():undefined},rec,req,socket,head);
    } catch {endSocket(socket,"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");}
  })();
}
