import type { Db } from "../db.js";
import { generateSecret, randomId, sha256Hex } from "./passwords.js";

export interface IssuedTicket {
  ticket: string;
  expiresAt: number;
}

export class TicketStore {
  #db: Db;
  #ttlMs: number;

  constructor(db: Db, ttlMs: number) {
    this.#db = db;
    this.#ttlMs = ttlMs;
  }

  issue(sessionId: string): IssuedTicket {
    const ticket = generateSecret(32);
    const now = Date.now();
    const expiresAt = now + this.#ttlMs;
    this.#db
      .prepare("INSERT INTO workspace_tickets (id, token_hash, session_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomId("tkt"), sha256Hex(ticket), sessionId, expiresAt, now);
    return { ticket, expiresAt };
  }

  /**
   * Consume a ticket exactly once. Expired, already-used, or tickets whose
   * originating primary session is no longer live (revoked/expired) return null.
   */
  consume(ticket: string, opts: { isValidSession: (sessionId: string) => boolean; now?: number }): { sessionId: string } | null {
    const now = opts.now ?? Date.now();
    const hash = sha256Hex(ticket);
    const row = this.#db.prepare("SELECT id, session_id, expires_at, used_at FROM workspace_tickets WHERE token_hash = ?").get(hash) as
      | { id: string; session_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.used_at !== null || row.expires_at <= now) return null;
    if (!opts.isValidSession(row.session_id)) return null;
    const res = this.#db
      .prepare("UPDATE workspace_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .run(now, row.id);
    if (res.changes !== 1) return null;
    return { sessionId: row.session_id };
  }

  purge(now = Date.now()): void {
    this.#db.prepare("DELETE FROM workspace_tickets WHERE expires_at < ?").run(now - 3600_000);
  }
}

/**
 * Restrict post-bootstrap redirects to same-site absolute paths.
 * Rejects protocol-relative, backslash, encoded-slash and control-character tricks.
 */
export function safeRedirectPath(candidate: string | undefined, fallback = "/"): string {
  if (!candidate) return fallback;
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return fallback;
  }
  if (!decoded.startsWith("/")) return fallback;
  if (decoded.startsWith("//")) return fallback;
  if (decoded.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  return decoded;
}
