import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { SessionStore } from "../../src/control/auth/sessions.js";
import { AccountSuspendedError, activeMembers, pageAccount, suspensionKey } from "../../src/control/auth/suspension.js";
import { UserRuntimes } from "../../src/control/tenants.js";
import type { AppContext } from "../../src/control/context.js";

let db: Db;
const add = (id: string, username: string) =>
  db.prepare("INSERT INTO owners (id, username, password_hash, password_salt, password_params, created_at, role) VALUES (?,?,?,?,?,?,'member')")
    .run(id, username, "h", "s", "scrypt$1$1$1$1", Date.now());
const suspend = (id: string) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(suspensionKey(id), String(Date.now()));

beforeEach(() => { db = openDb(":memory:"); add("user_a", "alice"); add("user_b", "bob"); });
afterEach(() => db.close());

it("stops a suspended account's sessions and refuses new ones, and lifting restores the same session", () => {
  const sessions = new SessionStore(db, 3_600_000, 1_800_000);
  const { token } = sessions.create("user_a", "primary");
  suspend("user_a");
  expect(sessions.resolve("primary", token)).toBeNull();
  expect(() => sessions.create("user_a", "primary")).toThrow(AccountSuspendedError);
  expect(sessions.create("user_b", "primary").session.ownerId).toBe("user_b");
  db.prepare("DELETE FROM meta WHERE key=?").run(suspensionKey("user_a"));
  expect(sessions.resolve("primary", token)?.ownerId).toBe("user_a");
});

it("serves no pages of a suspended account and starts no runtime for it", async () => {
  suspend("user_a");
  expect(pageAccount(db, "alice")).toBeNull();
  expect(pageAccount(db, "bob")).toBe("user_b");
  expect(activeMembers(db)).toEqual(["user_b"]);
  await expect(new UserRuntimes({ db } as AppContext).resolve("user_a")).rejects.toThrow("Account suspended");
});
