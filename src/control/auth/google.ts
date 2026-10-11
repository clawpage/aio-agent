import { createHash } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { generateSecret, safeEqual, sha256Hex } from "./passwords.js";
import type { User } from "./owner.js";

export const GOOGLE_TTL = 10 * 60_000;
export const GOOGLE_CLIENT_COOKIE = "pa_google_client";
export const GOOGLE_BROWSER_COOKIE = "pa_google_browser";
export class GoogleAuthError extends Error {}
export interface GoogleFlow {
  state_hash: string; client_hash: string; browser_hash: string | null;
  verifier: string; nonce: string; native: number; status: string; expires_at: number;
  subject: string | null; email: string | null; ticket_hash: string | null;
}

/** Authorization code + PKCE, state bound to the browser, and signed ID token + nonce. */
export class GoogleLogin {
  readonly enabled: boolean;
  readonly redirect: URL;
  private client: OAuth2Client;
  private clientId: string;
  constructor(private db: Db, cfg: Config) {
    this.redirect = new URL(cfg.googleRedirectUri);
    this.enabled = Boolean(cfg.googleClientId && cfg.googleClientSecret);
    this.clientId = cfg.googleClientId;
    if (this.enabled && (!cfg.primaryOrigins.includes(this.redirect.origin) ||
      this.redirect.pathname !== "/api/auth/google/callback" || this.redirect.search || this.redirect.hash ||
      this.redirect.username || this.redirect.password ||
      (this.redirect.protocol !== "https:" && !(this.redirect.protocol === "http:" && this.redirect.hostname === "localhost")))) {
      throw new Error("Google redirect URI must be the primary origin's /api/auth/google/callback");
    }
    this.client = new OAuth2Client({clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, redirectUri: this.redirect.href});
    this.client.transporter.defaults = {...this.client.transporter.defaults, timeout: 15_000, retry: false};
  }
  start(native: boolean): { state: string; client: string; url: string } {
    if (!this.enabled) throw new GoogleAuthError("disabled");
    this.db.prepare("DELETE FROM google_login_flows WHERE expires_at<=?").run(Date.now());
    const state = generateSecret(32), client = generateSecret(32), verifier = generateSecret(48), nonce = generateSecret(32);
    this.db.prepare("INSERT INTO google_login_flows (state_hash,client_hash,verifier,nonce,native,status,expires_at) VALUES (?,?,?,?,?,'new',?)")
      .run(sha256Hex(state), sha256Hex(client), verifier, nonce, Number(native), Date.now() + GOOGLE_TTL);
    const url = new URL("/api/auth/google/authorize", this.redirect);
    url.searchParams.set("state", state);
    return {state, client, url: url.href};
  }
  authorize(state: string, browser: string): string {
    const row = this.flow(state);
    if (!row || row.status !== "new") throw new GoogleAuthError("expired");
    const changed = this.db.prepare("UPDATE google_login_flows SET browser_hash=?,status='authorizing' WHERE state_hash=? AND status='new'")
      .run(sha256Hex(browser), row.state_hash);
    if (!changed.changes) throw new GoogleAuthError("expired");
    return this.client.generateAuthUrl({scope: ["openid", "email"], state, nonce: row.nonce,
      prompt: "select_account", code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: createHash("sha256").update(row.verifier).digest("base64url")});
  }
  async callback(state: string, browser: string, code: string): Promise<GoogleFlow> {
    const row = this.flow(state);
    if (!row || row.status !== "authorizing" || !row.browser_hash || !browser || !safeEqual(row.browser_hash, sha256Hex(browser))) {
      throw new GoogleAuthError("state");
    }
    // Claim before the network await; duplicate callbacks cannot race token exchange.
    const changed = this.db.prepare("UPDATE google_login_flows SET status='exchanging' WHERE state_hash=? AND status='authorizing'").run(row.state_hash);
    if (!changed.changes) throw new GoogleAuthError("replay");
    try {
      const {tokens} = await this.client.getToken({code, codeVerifier: row.verifier, redirect_uri: this.redirect.href});
      if (!tokens.id_token) throw new GoogleAuthError("token");
      const ticket = await this.client.verifyIdToken({idToken: tokens.id_token, audience: this.clientId});
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true ||
        typeof payload.nonce !== "string" || !safeEqual(payload.nonce, row.nonce) ||
        (payload.azp && payload.azp !== this.clientId) || row.expires_at <= Date.now()) throw new GoogleAuthError("identity");
      row.subject = payload.sub;
      row.email = payload.email;
      row.status = row.native ? "handoff" : "ready";
      const completed = this.db.prepare("UPDATE google_login_flows SET subject=?,email=?,status=?,verifier='',nonce='' WHERE state_hash=? AND status='exchanging' AND expires_at>?")
        .run(row.subject, row.email, row.status, row.state_hash, Date.now());
      if (!completed.changes) throw new GoogleAuthError("cancelled");
      return row;
    } catch {
      this.db.prepare("DELETE FROM google_login_flows WHERE state_hash=?").run(row.state_hash);
      // Never propagate provider errors: they may contain codes/tokens or client secrets.
      throw new GoogleAuthError("verification_failed");
    }
  }
  flow(state: string): GoogleFlow | null {
    return this.db.prepare("SELECT * FROM google_login_flows WHERE state_hash=? AND expires_at>?").get(sha256Hex(state), Date.now()) as GoogleFlow | undefined ?? null;
  }
  pending(client: string): GoogleFlow | null {
    if (!client) return null;
    return this.db.prepare("SELECT * FROM google_login_flows WHERE client_hash=? AND status='ready' AND expires_at>?").get(sha256Hex(client), Date.now()) as GoogleFlow | undefined ?? null;
  }
  user(row: GoogleFlow): User | null {
    return this.db.prepare("SELECT o.id,o.username,o.role FROM google_identities g JOIN owners o ON o.id=g.owner_id WHERE g.subject=?")
      .get(row.subject) as User | undefined ?? null;
  }
  handoff(row: GoogleFlow): string {
    const ticket = generateSecret(32);
    this.db.prepare("UPDATE google_login_flows SET ticket_hash=? WHERE state_hash=? AND status='handoff'").run(sha256Hex(ticket), row.state_hash);
    return `aioagent://auth?ticket=${ticket}`;
  }
  redeem(ticket: string, client: string): GoogleFlow {
    const row = this.db.prepare("SELECT * FROM google_login_flows WHERE ticket_hash=? AND client_hash=? AND status='handoff' AND expires_at>?")
      .get(sha256Hex(ticket), sha256Hex(client), Date.now()) as GoogleFlow | undefined;
    if (!ticket || !client || !row) throw new GoogleAuthError("handoff");
    const changed = this.db.prepare("UPDATE google_login_flows SET status='ready',ticket_hash=NULL WHERE state_hash=? AND status='handoff'").run(row.state_hash);
    if (!changed.changes) throw new GoogleAuthError("handoff");
    row.status = "ready";
    return row;
  }
  discard(client: string): void {
    if (client) this.db.prepare("DELETE FROM google_login_flows WHERE client_hash=?").run(sha256Hex(client));
  }
}
