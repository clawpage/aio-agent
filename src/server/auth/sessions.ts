import crypto from "node:crypto";
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

const ROTATION_GRACE_MS = 90_000;

interface SessionRow {
  id: string;
  owner_id: string;
  kind: string;
  token_hash: string;
  csrf_hash: string;
  prev_token_hash: string | null;
  prev_valid_until: number | null;
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
      .prepare("SELECT * FROM sessions WHERE kind = ? AND (token_hash = ? OR (prev_token_hash = ? AND prev_valid_until > ?))")
      .get(kind, tokenHash, tokenHash, now) as SessionRow | undefined;
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
   * Rotate the raw session token, keeping the previous one valid briefly.
   * Rotation always extends the expiry, so a client that renews more often than
   * the idle-renew interval never drifts past its original deadline. Expired or
   * revoked sessions cannot be rotated.
   */
  rotate(session: Session, now = Date.now()): { token: string; expiresAt: number } | null {
    const row = this.#db.prepare("SELECT token_hash, revoked_at, expires_at FROM sessions WHERE id = ?").get(session.id) as
      | { token_hash: string; revoked_at: number | null; expires_at: number }
      | undefined;
    if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
    const token = generateSecret(32);
    const expiresAt = now + this.#ttlMs;
    this.#db
      .prepare(
        `UPDATE sessions SET prev_token_hash = ?, prev_valid_until = ?, token_hash = ?, last_seen_at = ?, expires_at = ?
         WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(row.token_hash, now + ROTATION_GRACE_MS, sha256Hex(token), now, expiresAt, session.id, now);
    session.lastSeenAt = now;
    session.expiresAt = expiresAt;
    return { token, expiresAt };
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
  revokeLinked(kind: SessionKind, sessionId: string, reason = "parent-logout"): number {
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

export function newTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
