import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.js";
import type { Logger } from "../../common/logger.js";
import { t } from "../i18n/index.js";

/**
 * The code a password registration must give back, emailed to the address it
 * registers (Google and Apple registrations come with a verified email and need
 * none). Only a salted hash of the code is kept; it lasts 10 minutes, survives 5
 * wrong tries, and goes the moment an account is made with it. An address gets
 * one email a minute, an IP address a few an hour.
 *
 * The answer never tells whether an email is registered: a registered one is
 * answered "sent" too and gets a notice that it already has an account instead
 * of a code (a hidden placeholder `<username>@clawpage.ai` gets nothing). Its row
 * holds the hash of a code nobody was told, so a guess there fails the same way.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_AFTER_MS = 60_000;
export const SENDS_PER_IP_HOUR = 10;
const RESEND_URL = "https://api.resend.com/emails";

export interface Mail { from: string; to: string; subject: string; text: string; html: string }
export interface Mailer { send(mail: Mail): Promise<void> }

/** Sends through Resend's HTTP API; the key stays in this object. */
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(mail: Mail): Promise<void> {
    const res = await this.fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    // Only Resend's error name: its message can repeat the recipient's address.
    const name = await res.json().then((b) => { const n = (b as { name?: unknown } | null)?.name; return typeof n === "string" ? n : ""; }, () => "");
    throw new Error(`resend answered ${res.status}${name ? ` ${name}` : ""}`);
  }
}

const hash = (salt: string, code: string) => createHash("sha256").update(`${salt}:${code}`).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** `Name <address>` as configured, or the product's name in the request's language before a bare address. */
export function sender(from: string): string {
  return from.includes("<") ? from : `${t().http.signupMail.sender} <${from}>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Plain text and the same words in simple HTML, in the request's language. */
function compose(from: string, to: string, subject: string, paragraphs: string[], code?: string): Mail {
  const m = t().http.signupMail;
  const text = [paragraphs[0]!, ...(code ? [code] : []), ...paragraphs.slice(1)].join("\n\n");
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${escapeHtml(s)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">`
    + `<div style="max-width:480px;margin:0 auto"><p style="margin:0 0 20px;font-size:18px;font-weight:600">${escapeHtml(m.sender)}</p>`
    + p(paragraphs[0]!)
    + (code ? `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace">${code}</p>` : "")
    + paragraphs.slice(1).map(p).join("")
    + `</div></body></html>`;
  return { from: sender(from), to, subject, text, html };
}

export function codeMail(from: string, to: string, code: string): Mail {
  const m = t().http.signupMail;
  return compose(from, to, m.codeSubject(code), [m.codeIntro, m.codeValid(CODE_TTL_MS / 60_000), m.ignore], code);
}

export function takenMail(from: string, to: string): Mail {
  const m = t().http.signupMail;
  return compose(from, to, m.takenSubject, [m.takenBody, m.takenSignIn, m.ignore]);
}

export type SendResult =
  | { ok: true; retryAfter: number }
  | { ok: false; status: number; error: string; message: string; retryAfter?: number };

export class SignupCodes {
  readonly #ipSends = new Map<string, { since: number; count: number }>();

  constructor(private readonly db: Db, private readonly mailer: Mailer, private readonly from: string, private readonly log: Logger) {}

  /** `email` is already normalized. Answers the same whether or not it has an account. */
  async send(email: string, ip: string, now = Date.now()): Promise<SendResult> {
    for (const [k, v] of this.#ipSends) if (now - v.since > 3600_000) this.#ipSends.delete(k);
    const bucket = this.#ipSends.get(ip) ?? { since: now, count: 0 };
    if (bucket.count >= SENDS_PER_IP_HOUR || (this.#ipSends.size >= 5000 && !this.#ipSends.has(ip))) {
      return { ok: false, status: 429, error: "email_code_too_many", message: t().http.auth.emailCode.tooMany };
    }
    this.db.prepare("DELETE FROM signup_codes WHERE sent_at < ?").run(now - 86400_000);
    const account = this.db.prepare("SELECT email_placeholder FROM owners WHERE lower(email)=?").get(email) as { email_placeholder: number } | undefined;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    // Claims the minute in the same statement that checks it, so two quick requests send one email.
    const claimed = Number(this.db.prepare(
      `INSERT INTO signup_codes (email,code_hash,salt,sent_at,expires_at,attempts) VALUES (?,?,?,?,?,0)
       ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,sent_at=excluded.sent_at,expires_at=excluded.expires_at,attempts=0
       WHERE signup_codes.sent_at <= ?`,
    ).run(email, hash(salt, code), salt, now, now + CODE_TTL_MS, now - RESEND_AFTER_MS).changes) > 0;
    if (!claimed) {
      const row = this.db.prepare("SELECT sent_at FROM signup_codes WHERE email=?").get(email) as { sent_at: number };
      const retryAfter = Math.max(1, Math.ceil((row.sent_at + RESEND_AFTER_MS - now) / 1000));
      return { ok: false, status: 429, error: "email_code_cooldown", message: t().http.auth.emailCode.cooldown(retryAfter), retryAfter };
    }
    bucket.count++;
    this.#ipSends.set(ip, bucket);
    const retryAfter = RESEND_AFTER_MS / 1000;
    if (account?.email_placeholder) return { ok: true, retryAfter };
    try {
      await this.mailer.send(account ? takenMail(this.from, email) : codeMail(this.from, email, code));
    } catch (err) {
      // Not sent: the address may ask again at once.
      this.db.prepare("DELETE FROM signup_codes WHERE email=? AND sent_at=?").run(email, now);
      this.log.warn("signup code email not sent", { error: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 502, error: "email_send_failed", message: t().http.auth.emailCode.sendFailed };
    }
    return { ok: true, retryAfter };
  }
}

export type CodeCheck = { ok: true; hash: string } | { ok: false; reason: "required" | "invalid" | "expired" | "attempts" };

/** Every check spends one of the code's tries, a right one too (it is used up by the registration). */
export function verifySignupCode(db: Db, email: string, given: string, now = Date.now()): CodeCheck {
  const code = given.replace(/\s+/g, "");
  if (!code) return { ok: false, reason: "required" };
  const row = db.prepare("SELECT code_hash,salt,expires_at FROM signup_codes WHERE email=?").get(email) as { code_hash: string; salt: string; expires_at: number } | undefined;
  if (!row) return { ok: false, reason: "invalid" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const spent = db.prepare("UPDATE signup_codes SET attempts=attempts+1 WHERE email=? AND attempts<? RETURNING attempts").get(email, MAX_ATTEMPTS) as { attempts: number } | undefined;
  if (!spent) return { ok: false, reason: "attempts" };
  const h = hash(row.salt, code);
  if (/^\d{6}$/.test(code) && same(h, row.code_hash)) return { ok: true, hash: h };
  return { ok: false, reason: spent.attempts >= MAX_ATTEMPTS ? "attempts" : "invalid" };
}

/** Inside the registration's transaction: false when the code went in the meantime. */
export function consumeSignupCode(db: Db, email: string, codeHash: string): boolean {
  return Number(db.prepare("DELETE FROM signup_codes WHERE email=? AND code_hash=?").run(email, codeHash).changes) > 0;
}
