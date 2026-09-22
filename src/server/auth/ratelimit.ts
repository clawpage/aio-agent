import type { Db } from "../db.js";

export interface LockState {
  locked: boolean;
  retryAfterMs: number;
  failures: number;
}

export class LoginRateLimiter {
  #db: Db;
  #maxFailures: number;
  #windowMs: number;
  #lockoutMs: number;

  constructor(db: Db, opts: { maxFailures: number; windowMs: number; lockoutMs: number }) {
    this.#db = db;
    this.#maxFailures = opts.maxFailures;
    this.#windowMs = opts.windowMs;
    this.#lockoutMs = opts.lockoutMs;
  }

  state(ip: string, now = Date.now()): LockState {
    const row = this.#db.prepare("SELECT failures, first_at, locked_until FROM login_failures WHERE ip = ?").get(ip) as
      | { failures: number; first_at: number; locked_until: number | null }
      | undefined;
    if (!row) return { locked: false, retryAfterMs: 0, failures: 0 };
    if (row.locked_until && row.locked_until > now) {
      return { locked: true, retryAfterMs: row.locked_until - now, failures: row.failures };
    }
    if (now - row.first_at > this.#windowMs) return { locked: false, retryAfterMs: 0, failures: 0 };
    return { locked: false, retryAfterMs: 0, failures: row.failures };
  }

  recordFailure(ip: string, now = Date.now()): LockState {
    const row = this.#db.prepare("SELECT failures, first_at, locked_until FROM login_failures WHERE ip = ?").get(ip) as
      | { failures: number; first_at: number; locked_until: number | null }
      | undefined;
    let failures = 1;
    let firstAt = now;
    if (row && now - row.first_at <= this.#windowMs) {
      failures = row.failures + 1;
      firstAt = row.first_at;
    }
    const lockedUntil = failures >= this.#maxFailures ? now + this.#lockoutMs : null;
    this.#db
      .prepare(
        `INSERT INTO login_failures (ip, failures, first_at, locked_until) VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at, locked_until = excluded.locked_until`,
      )
      .run(ip, failures, firstAt, lockedUntil);
    return {
      locked: lockedUntil !== null,
      retryAfterMs: lockedUntil ? lockedUntil - now : 0,
      failures,
    };
  }

  recordSuccess(ip: string): void {
    this.#db.prepare("DELETE FROM login_failures WHERE ip = ?").run(ip);
  }
}
