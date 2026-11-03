import { createPublicKey, verify, type JsonWebKeyInput } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { generateSecret, safeEqual, sha256Hex } from "./passwords.js";
import type { User } from "./owner.js";

export const APPLE_TTL = 10 * 60_000;
export const APPLE_CLIENT_COOKIE = "pa_apple_client";
const ISSUER = "https://appleid.apple.com";
const KEYS_URL = `${ISSUER}/auth/keys`;
export class AppleAuthError extends Error {}
export interface AppleFlow { client_hash: string; nonce: string; status: string; expires_at: number; subject: string | null; email: string | null }
type Jwk = JsonWebKeyInput["key"] & { kid?: string };

/**
 * Sign in with Apple from the iOS app: the app asks the system (ASAuthorizationController)
 * with a nonce issued here, and sends back the identity token Apple signed. The token is
 * checked against Apple's published keys, this app's bundle id and the flow's nonce; the
 * flow is bound to the client cookie set when it started. No Apple tokens are kept.
 */
export class AppleLogin {
  readonly enabled: boolean;
  private keys: { at: number; list: Jwk[] } | null = null;
  constructor(private db: Db, private cfg: Config, private fetchKeys: () => Promise<Jwk[]> = defaultKeys) {
    this.enabled = Boolean(cfg.appleClientId);
  }
  start(): { client: string; nonce: string } {
    if (!this.enabled) throw new AppleAuthError("disabled");
    this.db.prepare("DELETE FROM apple_login_flows WHERE expires_at<=?").run(Date.now());
    const client = generateSecret(32), nonce = generateSecret(32);
    this.db.prepare("INSERT INTO apple_login_flows (client_hash,nonce,status,expires_at) VALUES (?,?,'new',?)")
      .run(sha256Hex(client), nonce, Date.now() + APPLE_TTL);
    return { client, nonce };
  }
  async verify(client: string, token: string): Promise<AppleFlow> {
    const row = client ? this.db.prepare("SELECT * FROM apple_login_flows WHERE client_hash=? AND expires_at>?").get(sha256Hex(client), Date.now()) as AppleFlow | undefined : undefined;
    if (!row || row.status !== "new") throw new AppleAuthError("expired");
    // Claim before the network await: a token is spent once.
    if (!this.db.prepare("UPDATE apple_login_flows SET status='verifying' WHERE client_hash=? AND status='new'").run(row.client_hash).changes) throw new AppleAuthError("replay");
    try {
      const claims = await this.claims(token);
      const verified = claims.email_verified === true || claims.email_verified === "true";
      if (claims.iss !== ISSUER || claims.aud !== this.cfg.appleClientId || typeof claims.sub !== "string" || !claims.sub ||
        typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() || typeof claims.nonce !== "string" || !safeEqual(claims.nonce, row.nonce) ||
        typeof claims.email !== "string" || !claims.email || !verified) throw new AppleAuthError("identity");
      row.subject = claims.sub;
      row.email = claims.email;
      row.status = "ready";
      const done = this.db.prepare("UPDATE apple_login_flows SET subject=?,email=?,status='ready',nonce='' WHERE client_hash=? AND status='verifying' AND expires_at>?")
        .run(row.subject, row.email, row.client_hash, Date.now());
      if (!done.changes) throw new AppleAuthError("cancelled");
      return row;
    } catch {
      this.db.prepare("DELETE FROM apple_login_flows WHERE client_hash=?").run(row.client_hash);
      throw new AppleAuthError("verification_failed");
    }
  }
  /** The token's claims, once its RS256 signature checks out against one of Apple's keys. */
  private async claims(token: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new AppleAuthError("token");
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) throw new AppleAuthError("token");
    const key = await this.key(header.kid);
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
    if (!ok) throw new AppleAuthError("signature");
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
  }
  /** Apple rotates its keys: an unknown key id refetches the list, at most once a minute. */
  private async key(kid: string): Promise<Jwk> {
    const cached = this.keys?.list.find(k => k.kid === kid);
    if (cached && Date.now() - this.keys!.at < 24 * 3600_000) return cached;
    if (!this.keys || Date.now() - this.keys.at > 60_000) this.keys = { at: Date.now(), list: await this.fetchKeys() };
    const found = this.keys.list.find(k => k.kid === kid);
    if (!found) throw new AppleAuthError("key");
    return found;
  }
  pending(client: string): AppleFlow | null {
    if (!client) return null;
    return this.db.prepare("SELECT * FROM apple_login_flows WHERE client_hash=? AND status='ready' AND expires_at>?").get(sha256Hex(client), Date.now()) as AppleFlow | undefined ?? null;
  }
  user(row: AppleFlow): User | null {
    return this.db.prepare("SELECT o.id,o.username,o.role FROM apple_identities a JOIN owners o ON o.id=a.owner_id WHERE a.subject=?")
      .get(row.subject) as User | undefined ?? null;
  }
  discard(client: string): void {
    if (client) this.db.prepare("DELETE FROM apple_login_flows WHERE client_hash=?").run(sha256Hex(client));
  }
}

async function defaultKeys(): Promise<Jwk[]> {
  const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new AppleAuthError("keys");
  return ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
}
