import { randomInt } from "node:crypto";
import type { Db } from "../db.js";
import { BOOTSTRAP_USERNAME } from "./owner.js";

/**
 * Accounts are identified by email. The username stays as the account's address
 * (`/u/<username>`) and its name in configuration; a new account's is made from
 * its email, so nobody has to choose one.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL = 254;

/** Emails are stored lowercase so one address is one account whatever the case it is typed in. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

/** Whether some account already has this email (a placeholder counts, in any case). */
export function emailTaken(db: Db, email: string): boolean {
  return !!db.prepare("SELECT 1 FROM owners WHERE lower(email)=?").get(email.toLowerCase());
}

/** Names no account may take: the owner's and the spare sandbox's. */
const RESERVED = new Set([BOOTSTRAP_USERNAME, "spare"]);
const SUFFIX = "abcdefghijkmnpqrstuvwxyz23456789";

/** A free lowercase username from the email's local part (`Jane.Doe+x@...` → `jane-doe-x`, or `jane-doe-x-k3fp` when taken). */
export function usernameFromEmail(db: Db, email: string): string {
  let base = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (base.length < 2) base = "user";
  const free = (name: string) => !RESERVED.has(name) && !db.prepare("SELECT 1 FROM owners WHERE lower(username)=?").get(name);
  if (free(base)) return base;
  for (;;) {
    let tail = "";
    for (let i = 0; i < 4; i++) tail += SUFFIX[randomInt(SUFFIX.length)];
    if (free(`${base}-${tail}`)) return `${base}-${tail}`;
  }
}

/** The email the person sees for their account: null for a hidden placeholder. */
export function visibleEmail(db: Db, userId: string): string | null {
  const row = db.prepare("SELECT email,email_placeholder FROM owners WHERE id=?").get(userId) as { email: string | null; email_placeholder: number } | undefined;
  return row?.email && !row.email_placeholder ? row.email : null;
}
