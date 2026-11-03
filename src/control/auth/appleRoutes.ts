import { Router, type Request, type Response, type NextFunction } from "express";
import type { AppContext } from "../context.js";
import { audit } from "../db.js";
import { originAllowed } from "../http/security.js";
import { RegisterError, registerGoogleWithInvite } from "./invites.js";
import { serializeCookie, sessionCookies } from "./sessions.js";
import { t } from "../i18n/index.js";
import { followLoginTimezone } from "./loginTimezone.js";
import { AppleLogin, AppleAuthError, APPLE_TTL, APPLE_CLIENT_COOKIE, type AppleFlow } from "./apple.js";

/** Sign in with Apple for the iOS app; a new Apple ID registers like a new Google account. */
export function appleRouter(context: AppContext, apple = new AppleLogin(context.db, context.cfg)): Router {
  const {db, cfg, sessions, limiter} = context;
  const router = Router();
  const cookie = (value: string, secure: boolean) => serializeCookie({name: APPLE_CLIENT_COOKIE, value, httpOnly: true,
    secure, sameSite: "Lax", path: "/api/auth/apple", maxAgeSeconds: value ? APPLE_TTL / 1000 : 0});
  const client = (req: Request) => req.paCtx!.cookies[APPLE_CLIENT_COOKIE] ?? "";
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.paCtx!.kind !== "primary") { res.status(404).json({error: "not_found"}); return; }
    if (req.method === "POST") {
      if (!originAllowed(cfg, "primary", req.paCtx!.origin)) { res.status(403).json({error: "origin_denied"}); return; }
      if (limiter.state(req.paCtx!.ip).locked) { res.status(429).json({error: "rate_limited", message: t().http.auth.tooManyAttempts}); return; }
    }
    next();
  });
  const run = (fn: (req: Request, res: Response) => void | Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve().then(() => fn(req, res)).catch(err => {
      if (err instanceof AppleAuthError) { res.status(401).json({error: "apple_expired", message: t().http.auth.appleFailed}); return; }
      next(err);
    });
  };
  const signIn = (req: Request, res: Response, userId: string, username: string) => {
    const ctx = req.paCtx!;
    const auth = sessions.create(userId, "primary", {ip: ctx.ip, userAgent: req.get("user-agent")});
    res.setHeader("Set-Cookie", [...sessionCookies("primary", auth.token, auth.csrfToken, {secure: ctx.secure, ttlMs: cfg.sessionTtlMs}), cookie("", ctx.secure)]);
    limiter.recordSuccess(ctx.ip);
    followLoginTimezone(context, userId, req.body?.timeZone);
    return username;
  };
  router.get("/pending", (req, res) => {
    const row = apple.pending(client(req));
    res.json({enabled: apple.enabled, pending: row ? {email: row.email} : null});
  });
  router.post("/start", run((req, res) => {
    if (!apple.enabled) { res.status(503).json({error: "apple_disabled", message: t().http.auth.appleDisabled}); return; }
    apple.discard(client(req));
    const flow = apple.start();
    res.setHeader("Set-Cookie", cookie(flow.client, req.paCtx!.secure));
    res.json({nonce: flow.nonce});
  }));
  router.post("/verify", run(async (req, res) => {
    let row: AppleFlow;
    try {
      row = await apple.verify(client(req), typeof req.body?.identityToken === "string" ? req.body.identityToken : "");
    } catch (err) {
      if (err instanceof AppleAuthError) { limiter.recordFailure(req.paCtx!.ip); audit(db, "apple_login_failed", undefined, req.paCtx!.ip); }
      throw err;
    }
    const user = apple.user(row);
    if (!user) { res.json({authenticated: false, pending: {email: row.email}}); return; }
    db.prepare("DELETE FROM apple_login_flows WHERE client_hash=?").run(row.client_hash);
    signIn(req, res, user.id, user.username);
    audit(db, "apple_login_ok", user.username, req.paCtx!.ip);
    context.analytics?.track("login", {userId: user.id, platform: req.get("x-client-platform"), props: {method: "apple", native: true}});
    res.json({authenticated: true, username: user.username, role: user.role});
  }));
  router.post("/register", run(async (req, res) => {
    const row = apple.pending(client(req));
    if (!row?.subject || !row.email) throw new AppleAuthError("expired");
    const code = typeof req.body?.inviteCode === "string" ? req.body.inviteCode : "";
    try {
      const user = await registerGoogleWithInvite(db, {provider: "apple", subject: row.subject, email: row.email, clientHash: row.client_hash}, {code});
      signIn(req, res, user.id, user.username);
      audit(db, "apple_register_ok", user.username, req.paCtx!.ip);
      context.analytics?.track("signup", {userId: user.id, platform: req.get("x-client-platform"), props: {method: "apple", invite: Boolean(code.trim())}});
      res.json({ok: true, username: user.username, email: user.email, role: user.role});
    } catch (err) {
      if (!(err instanceof RegisterError)) throw err;
      if (err.code === "invalid_invite" || err.code === "invite_used") limiter.recordFailure(req.paCtx!.ip);
      res.status(err.status).json({error: err.code, message: err.message});
    }
  }));
  router.post("/cancel", (req, res) => {
    apple.discard(client(req));
    res.setHeader("Set-Cookie", cookie("", req.paCtx!.secure));
    res.json({ok: true});
  });
  return router;
}
