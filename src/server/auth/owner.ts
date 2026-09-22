import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { generateSecret, hashPassword, verifyPassword, dummyVerify, type PasswordRecord } from "./passwords.js";
import type { Logger } from "../logger.js";

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
 * Ensure exactly one owner exists. There is deliberately no registration route:
 * the owner either comes from PA_OWNER_PASSWORD or from a locally generated
 * secret file (chmod 0600, git-ignored). The secret is never logged.
 */
export async function ensureOwner(
  db: Db,
  opts: { password: string; secretPath: string; log: Logger; reset?: boolean },
): Promise<BootstrapResult> {
  const existing = db.prepare("SELECT id FROM owners LIMIT 1").get() as { id: string } | undefined;
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
    opts.log.warn("owner password rotated", { generatedSecret: Boolean(generatedSecretPath) });
    return { created: false, reset: true, generatedSecretPath };
  }

  try {
    db.prepare(
      "INSERT INTO owners (id, username, password_hash, password_salt, password_params, created_at) VALUES (?, ?, ?, ?, ?, ?)",
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
  const row = db.prepare("SELECT id, username FROM owners LIMIT 1").get() as
    | { id: string; username: string }
    | undefined;
  return row ?? null;
}

export async function authenticateOwner(db: Db, password: string): Promise<{ id: string; username: string } | null> {
  const row = db
    .prepare("SELECT id, username, password_hash, password_salt, password_params FROM owners LIMIT 1")
    .get() as
    | { id: string; username: string; password_hash: string; password_salt: string; password_params: string }
    | undefined;
  if (!row) {
    await dummyVerify(password);
    return null;
  }
  const record: PasswordRecord = { hash: row.password_hash, salt: row.password_salt, params: row.password_params };
  const ok = await verifyPassword(password, record);
  return ok ? { id: row.id, username: row.username } : null;
}
