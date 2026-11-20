import { randomBytes, randomInt } from "node:crypto";
import type { Db } from "../db.js";
import type { Logger } from "../../common/logger.js";
import { t } from "../i18n/index.js";
import { CODE_TTL_MS, MAX_ATTEMPTS, RESEND_AFTER_MS, SENDS_PER_IP_HOUR, compose, hash, same, type CodeCheck, type Mail, type Mailer, type SendResult } from "./signupCode.js";

/**
 * The code a signed-in account gives back to change its password, emailed to the
 * account's email. An account from before email (it has only the hidden
 * placeholder) first binds one: the same kind of code, emailed to the address it
 * wants. The rules are the signup code's (signupCode.ts): a salted hash only, 10
 * minutes, 5 tries, one email a minute for each account and purpose, a few an
 * hour for an IP address.
 *
 * Binding never tells whether an address already has an account: it is answered
 * "sent" too and gets a notice instead of a code, and the row holds the hash of a
 * code nobody was told.
 */

export type AccountCodePurpose = "bind" | "password";

export function accountCodeMail(from: string, to: string, purpose: AccountCodePurpose, code: string): Mail {
  const m = t().http.accountMail;
  const s = t().http.signupMail;
  return compose(from, to, m[purpose].subject(code), [m[purpose].intro, s.codeValid(CODE_TTL_MS / 60_000), m[purpose].ignore], code);
}

export function bindTakenMail(from: string, to: string): Mail {
  const m = t().http.accountMail;
  return compose(from, to, m.bindTaken.subject, [m.bindTaken.body, t().http.signupMail.ignore]);
}

export class AccountCodes {
  readonly #ipSends = new Map<string, { since: number; count: number }>();

  constructor(private readonly db: Db, private readonly mailer: Mailer, private readonly from: string, private readonly log: Logger) {}

  /** `email` is already normalized: the account's own for "password", the one it wants for "bind". */
  async send(userId: string, purpose: AccountCodePurpose, email: string, ip: string, now = Date.now()): Promise<SendResult> {
    for (const [k, v] of this.#ipSends) if (now - v.since > 3600_000) this.#ipSends.delete(k);
    const bucket = this.#ipSends.get(ip) ?? { since: now, count: 0 };
    if (bucket.count >= SENDS_PER_IP_HOUR || (this.#ipSends.size >= 5000 && !this.#ipSends.has(ip))) {
      return { ok: false, status: 429, error: "email_code_too_many", message: t().http.auth.emailCode.tooMany };
    }
    this.db.prepare("DELETE FROM account_codes WHERE sent_at < ?").run(now - 86400_000);
    const taken = purpose === "bind" && !!this.db.prepare("SELECT 1 FROM owners WHERE lower(email)=?").get(email);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    // Claims the minute in the same statement that checks it, so two quick requests send one email.
    const claimed = Number(this.db.prepare(
      `INSERT INTO account_codes (owner_id,purpose,email,code_hash,salt,sent_at,expires_at,attempts) VALUES (?,?,?,?,?,?,?,0)
       ON CONFLICT(owner_id,purpose) DO UPDATE SET email=excluded.email,code_hash=excluded.code_hash,salt=excluded.salt,sent_at=excluded.sent_at,expires_at=excluded.expires_at,attempts=0
       WHERE account_codes.sent_at <= ?`,
    ).run(userId, purpose, email, hash(salt, code), salt, now, now + CODE_TTL_MS, now - RESEND_AFTER_MS).changes) > 0;
    if (!claimed) {
      const row = this.db.prepare("SELECT sent_at FROM account_codes WHERE owner_id=? AND purpose=?").get(userId, purpose) as { sent_at: number };
      const retryAfter = Math.max(1, Math.ceil((row.sent_at + RESEND_AFTER_MS - now) / 1000));
      return { ok: false, status: 429, error: "email_code_cooldown", message: t().http.auth.emailCode.cooldown(retryAfter), retryAfter };
    }
    bucket.count++;
    this.#ipSends.set(ip, bucket);
    try {
      await this.mailer.send(taken ? bindTakenMail(this.from, email) : accountCodeMail(this.from, email, purpose, code));
    } catch (err) {
      // Not sent: the account may ask again at once.
      this.db.prepare("DELETE FROM account_codes WHERE owner_id=? AND purpose=? AND sent_at=?").run(userId, purpose, now);
      this.log.warn("account code email not sent", { purpose, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 502, error: "email_send_failed", message: t().http.auth.emailCode.sendFailed };
    }
    return { ok: true, retryAfter: RESEND_AFTER_MS / 1000 };
  }
}

/** Every check spends one of the code's tries; the code only fits the email it was sent to. */
export function verifyAccountCode(db: Db, userId: string, purpose: AccountCodePurpose, email: string, given: string, now = Date.now()): CodeCheck {
  const code = given.replace(/\s+/g, "");
  if (!code) return { ok: false, reason: "required" };
  const row = db.prepare("SELECT email,code_hash,salt,expires_at FROM account_codes WHERE owner_id=? AND purpose=?").get(userId, purpose) as
    { email: string; code_hash: string; salt: string; expires_at: number } | undefined;
  if (!row || row.email !== email) return { ok: false, reason: "invalid" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const spent = db.prepare("UPDATE account_codes SET attempts=attempts+1 WHERE owner_id=? AND purpose=? AND attempts<? RETURNING attempts").get(userId, purpose, MAX_ATTEMPTS) as { attempts: number } | undefined;
  if (!spent) return { ok: false, reason: "attempts" };
  const h = hash(row.salt, code);
  if (/^\d{6}$/.test(code) && same(h, row.code_hash)) return { ok: true, hash: h };
  return { ok: false, reason: spent.attempts >= MAX_ATTEMPTS ? "attempts" : "invalid" };
}

/** Inside the change's transaction: false when the code went in the meantime. */
export function consumeAccountCode(db: Db, userId: string, purpose: AccountCodePurpose, codeHash: string): boolean {
  return Number(db.prepare("DELETE FROM account_codes WHERE owner_id=? AND purpose=? AND code_hash=?").run(userId, purpose, codeHash).changes) > 0;
}
