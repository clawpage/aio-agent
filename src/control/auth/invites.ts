import { randomInt } from "node:crypto";
import type { Db } from "../db.js";
import { hashPassword, randomId, generateSecret } from "./passwords.js";
import { BOOTSTRAP_USERNAME, type User } from "./owner.js";

/**
 * One-time invite codes: required once the deployment has 20 accounts.
 * The owner issues them from the settings page (people ask by mailing the
 * address shown on the register form); a code becomes unusable the moment an
 * account is created with it, or when the owner revokes it.
 */

/** No 0/O, 1/I/L: a code is read off an email and typed on a phone. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export interface Invite {
  code: string;
  note: string;
  createdAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
}

/** Self-registered names are lowercase so `/u/<name>` and login never differ only by case. */
export const REGISTER_USERNAME = /^[a-z0-9_-]{2,40}$/;
export const MIN_PASSWORD = 12;
export const OPEN_REGISTRATION_LIMIT = 20;

/** All existing accounts count, including the owner and administrator-created members. */
export function registrationRequiresInvite(db: Db): boolean {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM owners").get() as { count: number };
  return count >= OPEN_REGISTRATION_LIMIT;
}

export class RegisterError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Accepts what people paste: lowercase, spaces, missing dashes. */
export function normalizeCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return s.length === 12 ? `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : s;
}

function newCode(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return normalizeCode(s);
}

export function createInvite(db: Db, note = ""): Invite {
  const invite: Invite = { code: newCode(), note: note.trim().slice(0, 200), createdAt: Date.now(), usedAt: null, usedBy: null, revokedAt: null };
  db.prepare("INSERT INTO invites (code,note,created_at) VALUES (?,?,?)").run(invite.code, invite.note, invite.createdAt);
  return invite;
}

export function listInvites(db: Db): Invite[] {
  return (db.prepare(
    "SELECT i.code,i.note,i.created_at,i.used_at,o.username AS used_by,i.revoked_at FROM invites i LEFT JOIN owners o ON o.id=i.used_by ORDER BY i.created_at DESC",
  ).all() as Array<{ code: string; note: string; created_at: number; used_at: number | null; used_by: string | null; revoked_at: number | null }>)
    .map(r => ({ code: r.code, note: r.note, createdAt: r.created_at, usedAt: r.used_at, usedBy: r.used_by, revokedAt: r.revoked_at }));
}

/** Only an unused code can be revoked; a used one already did its one job. */
export function revokeInvite(db: Db, code: string): boolean {
  return Number(db.prepare("UPDATE invites SET revoked_at=? WHERE code=? AND used_at IS NULL AND revoked_at IS NULL").run(Date.now(), normalizeCode(code)).changes) > 0;
}

/**
 * Create a member. Check the open-registration quota, claim any supplied code,
 * and insert the account in one write transaction. Concurrent registrations
 * cannot exceed the quota or spend the same code twice.
 */
export async function registerWithInvite(db: Db, input: { username: string; password: string; code: string }, google?: { subject: string; email: string; clientHash: string }): Promise<User> {
  const username = input.username.trim();
  const code = normalizeCode(input.code);
  if (!REGISTER_USERNAME.test(username) || username === BOOTSTRAP_USERNAME) {
    throw new RegisterError(400, "invalid_username", "账号只能用 2–40 位小写字母、数字、- 或 _");
  }
  if (input.password.length < MIN_PASSWORD) throw new RegisterError(400, "weak_password", `密码至少需要 ${MIN_PASSWORD} 个字符`);
  const rec = await hashPassword(input.password);
  const id = randomId("user");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!code && registrationRequiresInvite(db)) throw new RegisterError(400, "invite_required", "免邀请码注册名额已满，请输入邀请码");
    if (code) {
      const invite = db.prepare("SELECT used_at,revoked_at FROM invites WHERE code=?").get(code) as { used_at: number | null; revoked_at: number | null } | undefined;
      if (!invite || invite.revoked_at !== null) throw new RegisterError(400, "invalid_invite", "邀请码无效");
      if (invite.used_at !== null) throw new RegisterError(400, "invite_used", "这个邀请码已经用过了");
    }
    if (db.prepare("SELECT 1 FROM owners WHERE lower(username)=?").get(username)) throw new RegisterError(409, "username_taken", "这个账号已经有人用了，换一个吧");
    const now = Date.now();
    if (google) {
      const flow = db.prepare("SELECT subject FROM google_login_flows WHERE client_hash=? AND status='ready' AND expires_at>?").get(google.clientHash, now) as {subject: string} | undefined;
      if (flow?.subject !== google.subject) throw new RegisterError(401, "google_expired", "Google 登录已过期，请重新登录");
      if (db.prepare("SELECT 1 FROM google_identities WHERE subject=?").get(google.subject)) {
        throw new RegisterError(409, "google_registered", "这个 Google 账号已注册，请重新用 Google 登录");
      }
    }
    db.prepare("INSERT INTO owners (id,username,password_hash,password_salt,password_params,created_at,role) VALUES (?,?,?,?,?,?,'member')")
      .run(id, username, rec.hash, rec.salt, rec.params, now);
    if (code) db.prepare("UPDATE invites SET used_at=?,used_by=? WHERE code=?").run(now, id, code);
    if (google) {
      db.prepare("INSERT INTO google_identities (subject,owner_id,email,created_at) VALUES (?,?,?,?)").run(google.subject, id, google.email, now);
      db.prepare("DELETE FROM google_login_flows WHERE client_hash=?").run(google.clientHash);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { id, username, role: "member" };
}

/** OAuth-only accounts have an unguessable password, never disclosed or used by a caller. */
export function registerGoogleWithInvite(db: Db, identity: {subject: string; email: string; clientHash: string}, input: {username: string; code: string}): Promise<User> {
  return registerWithInvite(db, {...input, password: generateSecret(48)}, identity);
}
