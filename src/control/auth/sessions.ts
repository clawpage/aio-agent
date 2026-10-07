import { EventEmitter } from "node:events";
import type { Db } from "../db.js";
import { generateSecret, randomId, safeEqual, sha256Hex } from "./passwords.js";

export type SessionKind = "primary" | "workspace";

export interface Session {
  id: string;
  ownerId: string;
  kind: SessionKind;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export const COOKIE_NAMES: Record<SessionKind, { session: string; csrf: string }> = {
  primary: { session: "pa_session", csrf: "pa_csrf" },
  workspace: { session: "pa_ws_session", csrf: "pa_ws_csrf" },
};

interface SessionRow {
  id: string;
  owner_id: string;
  kind: string;
  token_hash: string;
  csrf_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export class SessionStore {
  readonly events = new EventEmitter();
  #db: Db;
  #ttlMs: number;
  #renewMs: number;

  constructor(db: Db, ttlMs: number, renewMs: number) {
    this.#db = db;
    this.#ttlMs = ttlMs;
    this.#renewMs = renewMs;
    this.events.setMaxListeners(0);
  }

  create(
    ownerId: string,
    kind: SessionKind,
    meta: { ip?: string; userAgent?: string; parentSessionId?: string } = {},
  ): {
    session: Session;
    token: string;
    csrfToken: string;
  } {
    const token = generateSecret(32);
    const csrfToken = generateSecret(24);
    const now = Date.now();
    const id = randomId("sess");
    this.#db
      .prepare(
        `INSERT INTO sessions (id, owner_id, kind, token_hash, csrf_hash, parent_session_id, created_at, last_seen_at, expires_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ownerId,
        kind,
        sha256Hex(token),
        sha256Hex(csrfToken),
        meta.parentSessionId ?? null,
        now,
        now,
        now + this.#ttlMs,
        meta.userAgent ?? null,
        meta.ip ?? null,
      );
    return { session: { id, ownerId, kind, createdAt: now, lastSeenAt: now, expiresAt: now + this.#ttlMs }, token, csrfToken };
  }

  /** Resolve a raw cookie token to a live session, applying sliding expiry. */
  resolve(kind: SessionKind, token: string | undefined): Session | null {
    if (!token) return null;
    const now = Date.now();
    const tokenHash = sha256Hex(token);
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE kind = ? AND token_hash = ?")
      .get(kind, tokenHash) as SessionRow | undefined;
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at <= now) return null;

    if (now - row.last_seen_at > this.#renewMs) {
      const expiresAt = now + this.#ttlMs;
      this.#db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(now, expiresAt, row.id);
      row.last_seen_at = now;
      row.expires_at = expiresAt;
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      kind: row.kind as SessionKind,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    };
  }

  /** Verify a CSRF token against the session's stored hash. */
  verifyCsrf(session: Session, csrfToken: string | undefined): boolean {
    if (!csrfToken) return false;
    const row = this.#db.prepare("SELECT csrf_hash FROM sessions WHERE id = ?").get(session.id) as
      | { csrf_hash: string }
      | undefined;
    if (!row) return false;
    return safeEqual(row.csrf_hash, sha256Hex(csrfToken));
  }

  /**
   * Heartbeat: keep a live session alive for a full TTL from now, without
   * changing its token. Renewal used to rotate the token, and a phone resuming
   * from the background fires several renewals at once: the racing rotations, or
   * one whose new cookie was lost with a response cut off by suspension, logged
   * the person out. Expired or revoked sessions are refused.
   */
  heartbeat(session: Session, now = Date.now()): { expiresAt: number } | null {
    const expiresAt = now + this.#ttlMs;
    const res = this.#db
      .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?")
      .run(now, expiresAt, session.id, now);
    if (res.changes === 0) return null;
    session.lastSeenAt = now;
    session.expiresAt = expiresAt;
    return { expiresAt };
  }

  revoke(sessionId: string, reason = "logout"): void {
    const now = Date.now();
    const res = this.#db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, sessionId);
    if (res.changes > 0) this.events.emit("revoked", sessionId, reason);
  }

  revokeAllForOwner(ownerId: string, reason = "logout-all"): void {
    const rows = this.#db.prepare("SELECT id FROM sessions WHERE owner_id = ? AND revoked_at IS NULL").all(ownerId) as {
      id: string;
    }[];
    for (const r of rows) this.revoke(r.id, reason);
  }

  /** A session is live only while it is neither revoked nor expired. */
  isLive(sessionId: string, now = Date.now()): boolean {
    const row = this.#db.prepare("SELECT revoked_at, expires_at FROM sessions WHERE id = ?").get(sessionId) as
      | { revoked_at: number | null; expires_at: number }
      | undefined;
    if (!row) return false;
    return row.revoked_at === null && row.expires_at > now;
  }

  /** Ids of live companion sessions derived from a primary session. */
  linkedIds(sessionId: string): string[] {
    return (
      this.#db.prepare("SELECT id FROM sessions WHERE parent_session_id = ? AND revoked_at IS NULL").all(sessionId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  /** Revoke workspace companion sessions derived from a primary session. */
  revokeLinked(sessionId: string, reason = "parent-logout"): number {
    const rows = this.#db
      .prepare("SELECT id FROM sessions WHERE parent_session_id = ? AND revoked_at IS NULL")
      .all(sessionId) as { id: string }[];
    for (const r of rows) this.revoke(r.id, reason);
    return rows.length;
  }

  /** Drop sessions whose expiry has passed, returning the affected ids. */
  collectExpiredIds(now = Date.now()): string[] {
    const rows = this.#db
      .prepare("SELECT id FROM sessions WHERE expires_at <= ? AND revoked_at IS NULL")
      .all(now) as { id: string }[];
    return rows.map((r) => r.id);
  }

  list(ownerId: string): Array<{ id: string; kind: string; createdAt: number; lastSeenAt: number; expiresAt: number; userAgent: string | null; ip: string | null }> {
    return this.#db
      .prepare(
        "SELECT id, kind, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent, ip FROM sessions WHERE owner_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC",
      )
      .all(ownerId) as any;
  }

  purgeExpired(now = Date.now()): void {
    this.#db.prepare("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(
      now,
      now - 86400_000,
    );
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieSpec {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
  path?: string;
  expiresAt?: number;
}

export function serializeCookie(c: CookieSpec): string {
  const parts = [`${c.name}=${encodeURIComponent(c.value)}`, `Path=${c.path ?? "/"}`];
  if (c.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(c.maxAgeSeconds)}`);
  if (c.expiresAt !== undefined) parts.push(`Expires=${new Date(c.expiresAt).toUTCString()}`);
  parts.push(`SameSite=${c.sameSite}`);
  if (c.httpOnly) parts.push("HttpOnly");
  if (c.secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookies(
  kind: SessionKind,
  token: string,
  csrfToken: string,
  opts: { secure: boolean; ttlMs: number },
): string[] {
  const names = COOKIE_NAMES[kind];
  const maxAgeSeconds = Math.floor(opts.ttlMs / 1000);
  return [
    serializeCookie({ name: names.session, value: token, httpOnly: true, secure: opts.secure, sameSite: "Lax", maxAgeSeconds }),
    // CSRF cookie is intentionally readable by the SPA (double-submit pattern); it is not a credential by itself.
    serializeCookie({ name: names.csrf, value: csrfToken, httpOnly: false, secure: opts.secure, sameSite: "Lax", maxAgeSeconds }),
  ];
}

export function clearSessionCookies(kind: SessionKind, secure: boolean): string[] {
  const names = COOKIE_NAMES[kind];
  return [
    serializeCookie({ name: names.session, value: "", httpOnly: true, secure, sameSite: "Lax", maxAgeSeconds: 0 }),
    serializeCookie({ name: names.csrf, value: "", httpOnly: false, secure, sameSite: "Lax", maxAgeSeconds: 0 }),
  ];
}
