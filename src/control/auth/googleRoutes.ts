import { Router, type Request, type Response, type NextFunction } from "express";
import type { AppContext } from "../context.js";
import { audit } from "../db.js";
import { originAllowed } from "../http/security.js";
import { generateSecret, sha256Hex } from "./passwords.js";
import { RegisterError, registerGoogleWithInvite } from "./invites.js";
import { serializeCookie, sessionCookies } from "./sessions.js";
import { GoogleLogin, GoogleAuthError, GOOGLE_TTL, GOOGLE_CLIENT_COOKIE, GOOGLE_BROWSER_COOKIE, type GoogleFlow } from "./google.js";

export function googleRouter(context: AppContext): Router {
  const {db, cfg, sessions, limiter} = context;
  const google = new GoogleLogin(db, cfg);
  const router = Router();
  const cookie = (name: string, value: string, secure: boolean) => serializeCookie({name, value, httpOnly: true,
    secure, sameSite: "Lax", path: "/api/auth/google", maxAgeSeconds: value ? GOOGLE_TTL / 1000 : 0});
  const client = (req: Request) => req.paCtx!.cookies[GOOGLE_CLIENT_COOKIE] ?? "";
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.paCtx!.kind !== "primary") { res.status(404).json({error: "not_found"}); return; }
    if (req.method === "POST") {
      if (!originAllowed(cfg, "primary", req.paCtx!.origin)) { res.status(403).json({error: "origin_denied"}); return; }
      if (limiter.state(req.paCtx!.ip).locked) { res.status(429).json({error: "rate_limited", message: "尝试次数过多，请稍后重试"}); return; }
    }
    next();
  });
  const run = (fn: (req: Request, res: Response) => void | Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve().then(() => fn(req, res)).catch(err => {
      if (err instanceof GoogleAuthError) { res.status(401).json({error: "google_expired", message: "Google 登录失败或已过期，请重新登录"}); return; }
      next(err);
    });
  };
  const finish = (req: Request, res: Response, row: GoogleFlow, redirect = false): void => {
    const user = google.user(row);
    if (!user) {
      if (redirect) res.redirect(303, "/login?google=invite");
      else res.json({authenticated: false, pending: {email: row.email}});
      return;
    }
    const ctx = req.paCtx!;
    const auth = sessions.create(user.id, "primary", {ip: ctx.ip, userAgent: req.get("user-agent")});
    res.setHeader("Set-Cookie", [...sessionCookies("primary", auth.token, auth.csrfToken, {secure: ctx.secure, ttlMs: cfg.sessionTtlMs}),
      cookie(GOOGLE_CLIENT_COOKIE, "", ctx.secure)]);
    db.prepare("DELETE FROM google_login_flows WHERE state_hash=?").run(row.state_hash);
    limiter.recordSuccess(ctx.ip);
    audit(db, "google_login_ok", user.username, ctx.ip);
    if (redirect) res.redirect(303, "/login");
    else res.json({authenticated: true, username: user.username, role: user.role});
  };
  router.get("/pending", (req, res) => {
    const row = google.pending(client(req));
    res.json({enabled: google.enabled, pending: row ? {email: row.email} : null});
  });
  router.post("/start", run((req, res) => {
    if (!google.enabled) { res.status(503).json({error: "google_disabled", message: "Google 登录尚未配置"}); return; }
    google.discard(client(req));
    const flow = google.start(req.body?.native === true);
    res.setHeader("Set-Cookie", cookie(GOOGLE_CLIENT_COOKIE, flow.client, req.paCtx!.secure));
    res.json({url: flow.url});
  }));
  router.get("/authorize", run((req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const browser = generateSecret(32);
    const url = google.authorize(state, browser);
    res.setHeader("Set-Cookie", cookie(GOOGLE_BROWSER_COOKIE, browser, req.paCtx!.secure));
    res.redirect(303, url);
  }));
  router.get("/callback", run(async (req, res) => {
    const str = (v: unknown) => typeof v === "string" ? v : "";
    const state = str(req.query.state);
    const row = google.flow(state);
    const browser = req.paCtx!.cookies[GOOGLE_BROWSER_COOKIE] ?? "";
    // A web login must return to the same initiating browser as well as the state cookie.
    if (!row || (!row.native && row.client_hash !== sha256Hex(client(req)))) {
      res.redirect(303, "/login?google=error"); return;
    }
    try {
      const verified = await google.callback(state, browser, str(req.query.code));
      res.setHeader("Set-Cookie", cookie(GOOGLE_BROWSER_COOKIE, "", req.paCtx!.secure));
      if (verified.native) res.redirect(303, google.handoff(verified));
      else finish(req, res, verified, true);
    } catch (err) {
      if (!(err instanceof GoogleAuthError)) throw err;
      audit(db, "google_login_failed", undefined, req.paCtx!.ip);
      res.redirect(303, row.native ? "aioagent://auth?error=failed" : "/login?google=error");
    }
  }));
  router.post("/redeem", run((req, res) => {
    const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
    finish(req, res, google.redeem(ticket, client(req)));
  }));
  router.post("/register", run(async (req, res) => {
    const row = google.pending(client(req));
    if (!row?.subject || !row.email) throw new GoogleAuthError("expired");
    const str = (v: unknown) => typeof v === "string" ? v : "";
    try {
      const user = await registerGoogleWithInvite(db, {subject: row.subject, email: row.email, clientHash: row.client_hash},
        {username: str(req.body?.username), code: str(req.body?.inviteCode)});
      const ctx = req.paCtx!;
      const auth = sessions.create(user.id, "primary", {ip: ctx.ip, userAgent: req.get("user-agent")});
      res.setHeader("Set-Cookie", [...sessionCookies("primary", auth.token, auth.csrfToken, {secure: ctx.secure, ttlMs: cfg.sessionTtlMs}),
        cookie(GOOGLE_CLIENT_COOKIE, "", ctx.secure)]);
      limiter.recordSuccess(ctx.ip);
      audit(db, "google_register_ok", user.username, ctx.ip);
      res.json({ok: true, username: user.username, role: user.role});
    } catch (err) {
      if (!(err instanceof RegisterError)) throw err;
      if (err.code === "invalid_invite" || err.code === "invite_used") limiter.recordFailure(req.paCtx!.ip);
      res.status(err.status).json({error: err.code, message: err.message});
    }
  }));
  router.post("/cancel", (req, res) => {
    google.discard(client(req));
    res.setHeader("Set-Cookie", cookie(GOOGLE_CLIENT_COOKIE, "", req.paCtx!.secure));
    res.json({ok: true});
  });
  return router;
}
