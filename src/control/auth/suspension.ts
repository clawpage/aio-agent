import type { Db } from "../db.js";

/**
 * An account the administrator stopped (`bin/suspend-user.mjs`): `suspended:<id>` in meta, kept like
 * `member_model:<id>`. It cannot sign in, its sessions stop resolving, its runtime is not started and
 * its published pages are not served. Its data stays; lifting the suspension restores everything.
 */
export const suspensionKey = (userId: string) => `suspended:${userId}`;
/** SQL true for an `owners` row that is not suspended. */
const ACTIVE = "NOT EXISTS (SELECT 1 FROM meta WHERE key='suspended:'||owners.id)";

export function isSuspended(db: Db, userId: string): boolean {
  return db.prepare("SELECT 1 FROM meta WHERE key=?").get(suspensionKey(userId)) !== undefined;
}

/** The account a page address names (`/u/<username>/share/...`); none for a suspended one, so its pages are not served. */
export function pageAccount(db: Db, username: string): string | null {
  return (db.prepare(`SELECT id FROM owners WHERE username=? AND ${ACTIVE}`).get(username) as { id: string } | undefined)?.id ?? null;
}

/** The members whose runtimes start with the service. */
export function activeMembers(db: Db): string[] {
  return (db.prepare(`SELECT id FROM owners WHERE role='member' AND ${ACTIVE}`).all() as { id: string }[]).map(r => r.id);
}

export class AccountSuspendedError extends Error {
  constructor() { super("account suspended"); }
}
