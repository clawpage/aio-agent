import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/control/db.js";
import { SessionStore } from "../../src/control/auth/sessions.js";
import { ensureOwner } from "../../src/control/auth/owner.js";
import { Logger } from "../../src/control/logger.js";
import { TicketStore } from "../../src/control/auth/tickets.js";

/**
 * Owner password rotation must invalidate every existing login, including the
 * companion (workspace) sessions derived from a primary session. Runs against a
 * throwaway database only — production credentials are never touched.
 */
describe("owner password rotation", () => {
  let db: Db;
  let sessions: SessionStore;
  let tmpDir: string;

  beforeEach(async () => {
    db = openDb(":memory:");
    sessions = new SessionStore(db, 3600_000, 60_000);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-owner-"));
    await ensureOwner(db, { password: "first-password", secretPath: path.join(tmpDir, "secret.txt"), log: new Logger("error", undefined, false) });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("revokes primary and companion sessions and invalidates pending tickets", async () => {
    const primary = sessions.create("owner_1", "primary");
    const companion = sessions.create("owner_1", "workspace", { parentSessionId: primary.session.id });
    const tickets = new TicketStore(db, 60_000);
    const ticket = tickets.issue(primary.session.id);

    expect(sessions.isLive(primary.session.id)).toBe(true);
    expect(sessions.isLive(companion.session.id)).toBe(true);

    const result = await ensureOwner(db, {
      password: "second-password",
      secretPath: path.join(tmpDir, "secret.txt"),
      log: new Logger("error", undefined, false),
      reset: true,
    });
    expect(result.reset).toBe(true);

    // Both cookie kinds stop working immediately.
    expect(sessions.isLive(primary.session.id)).toBe(false);
    expect(sessions.isLive(companion.session.id)).toBe(false);
    expect(sessions.resolve("primary", primary.token)).toBeNull();
    expect(sessions.resolve("workspace", companion.token)).toBeNull();

    // A ticket minted before the rotation can no longer bootstrap a companion session.
    expect(tickets.consume(ticket.ticket, { isValidSession: (id) => sessions.isLive(id) })).toBeNull();

    // The new password works; the old one does not.
    const { verifyPassword } = await import("../../src/control/auth/passwords.js");
    const row = db.prepare("SELECT password_hash, password_salt, password_params FROM owners LIMIT 1").get() as {
      password_hash: string;
      password_salt: string;
      password_params: string;
    };
    const record = { hash: row.password_hash, salt: row.password_salt, params: row.password_params };
    expect(await verifyPassword("second-password", record)).toBe(true);
    expect(await verifyPassword("first-password", record)).toBe(false);
  });

  it("does not rotate when the reset flag is absent", async () => {
    const before = db.prepare("SELECT password_hash FROM owners LIMIT 1").get() as { password_hash: string };
    const result = await ensureOwner(db, {
      password: "ignored",
      secretPath: path.join(tmpDir, "secret.txt"),
      log: new Logger("error", undefined, false),
    });
    expect(result.created).toBe(false);
    expect(result.reset).toBeUndefined();
    const after = db.prepare("SELECT password_hash FROM owners LIMIT 1").get() as { password_hash: string };
    expect(after.password_hash).toBe(before.password_hash);
  });
});
