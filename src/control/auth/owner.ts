import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { randomId, generateSecret, hashPassword, verifyPassword, dummyVerify } from "./passwords.js";
import type { Logger } from "../../common/logger.js";

export const BOOTSTRAP_USERNAME = "owner";

export interface BootstrapResult {
  created: boolean;
  /** Set when the owner password was rotated by an explicit reset. */
  reset?: boolean;
  /** Only set when a secret was newly generated into the local file. */
  generatedSecretPath?: string;
}

export const OWNER_SOURCE_META_KEY = "owner_bootstrap_source";

/**
 * Ensure exactly one owner exists. Registration (auth/invites.ts) only ever creates
 * members; the owner either comes from PA_OWNER_PASSWORD or from a locally generated
 * secret file (chmod 0600, git-ignored). The secret is never logged.
 */
export async function ensureOwner(
  db: Db,
  opts: { password: string; secretPath: string; log: Logger; reset?: boolean },
): Promise<BootstrapResult> {
  const existing = db.prepare("SELECT id FROM owners WHERE role='owner' LIMIT 1").get() as { id: string } | undefined;
  if (existing && !opts.reset) {
    // Never silently invent a new password for an existing owner: the operator
    // would be locked out with no way to discover the old one.
    const source = db.prepare("SELECT value FROM meta WHERE key = ?").get(OWNER_SOURCE_META_KEY) as { value: string } | undefined;
    if (source?.value === "generated" && !fs.existsSync(opts.secretPath)) {
      opts.log.error("owner password was generated but the local secret file is missing; set PA_OWNER_PASSWORD or run with PA_OWNER_PASSWORD_RESET=1 to rotate", {
        path: opts.secretPath,
      });
    }
    return { created: false };
  }

  let password = opts.password;
  let generatedSecretPath: string | undefined;
  if (!password) {
    if (fs.existsSync(opts.secretPath)) {
      password = fs.readFileSync(opts.secretPath, "utf8").trim();
    }
    if (!password) {
      password = generateSecret(24);
      fs.mkdirSync(path.dirname(opts.secretPath), { recursive: true, mode: 0o700 });
      // wx: never overwrite a secret that appeared concurrently.
      try {
        fs.writeFileSync(opts.secretPath, password + "\n", { mode: 0o600, flag: "wx" });
        fs.chmodSync(opts.secretPath, 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          password = fs.readFileSync(opts.secretPath, "utf8").trim();
        } else {
          throw err;
        }
      }
      generatedSecretPath = opts.secretPath;
    }
  }

  const rec = await hashPassword(password);
  if (existing) {
    db.prepare("UPDATE owners SET password_hash = ?, password_salt = ?, password_params = ? WHERE id = ?").run(
      rec.hash,
      rec.salt,
      rec.params,
      existing.id,
    );
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      OWNER_SOURCE_META_KEY,
      generatedSecretPath ? "generated" : "env",
    );
    // Rotating the password must invalidate every existing login.
    const revoked = db.prepare("UPDATE sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL").run(Date.now(), existing.id);
    opts.log.warn("owner password rotated", { generatedSecret: Boolean(generatedSecretPath), sessionsRevoked: revoked.changes });
    return { created: false, reset: true, generatedSecretPath };
  }

  try {
    db.prepare(
      "INSERT INTO owners (id, username, password_hash, password_salt, password_params, created_at, role) VALUES (?, ?, ?, ?, ?, ?, 'owner')",
    ).run("owner_1", BOOTSTRAP_USERNAME, rec.hash, rec.salt, rec.params, Date.now());
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      OWNER_SOURCE_META_KEY,
      generatedSecretPath ? "generated" : "env",
    );
  } catch (err) {
    // Concurrent bootstrap: another process won the race, nothing to do.
    if (String(err).includes("UNIQUE")) return { created: false };
    throw err;
  }
  opts.log.info("owner bootstrap complete", { generatedSecret: Boolean(generatedSecretPath) });
  return { created: true, generatedSecretPath };
}

export function getOwner(db: Db): { id: string; username: string } | null {
  const row = db.prepare("SELECT id, username FROM owners WHERE role='owner' LIMIT 1").get() as
    | { id: string; username: string }
    | undefined;
  return row ?? null;
}

export type UserRole = "owner" | "member";
export interface User { id: string; username: string; role: UserRole }
export function getUser(db: Db, id: string): User | null {
  return db.prepare("SELECT id,username,role FROM owners WHERE id=?").get(id) as User | undefined ?? null;
}
export async function createMember(db: Db, username: string, password: string): Promise<User> {
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(username) || username === BOOTSTRAP_USERNAME) throw new Error("账号格式无效");
  if (password.length < 12) throw new Error("密码至少需要12个字符");
  const rec = await hashPassword(password);
  const id = randomId("user");
  db.prepare("INSERT INTO owners (id,username,password_hash,password_salt,password_params,created_at,role) VALUES (?,?,?,?,?,?,'member')")
    .run(id,username,rec.hash,rec.salt,rec.params,Date.now());
  return { id, username, role: "member" };
}
export async function authenticateUser(db: Db, username: string, password: string): Promise<User | null> {
  const row = db.prepare("SELECT * FROM owners WHERE username=?").get(username) as
    (User & { password_hash: string; password_salt: string; password_params: string }) | undefined;
  if (!row) { await dummyVerify(password); return null; }
  const ok = await verifyPassword(password, { hash: row.password_hash, salt: row.password_salt, params: row.password_params });
  return ok ? { id: row.id, username: row.username, role: row.role } : null;
}
export async function authenticateOwner(db: Db, password: string): Promise<User | null> {
  return authenticateUser(db, BOOTSTRAP_USERNAME, password);
}
