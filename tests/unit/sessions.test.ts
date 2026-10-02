import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { SessionStore } from "../../src/control/auth/sessions.js";

const TTL = 60 * 60_000; // 1 hour
const RENEW = 30 * 60_000; // renew every 30 minutes

function store(db: Db): SessionStore {
  return new SessionStore(db, TTL, RENEW);
}

describe("SessionStore renewal and revocation", () => {
  let db: Db;
  let sessions: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    db = openDb(":memory:");
    db.prepare("INSERT INTO owners (id, username, password_hash, password_salt, password_params, created_at) VALUES (?,?,?,?,?,?)").run(
      "owner_1",
      "owner",
      "h",
      "s",
      "scrypt$1$1$1$1",
      Date.now(),
    );
    sessions = store(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("keeps a session alive when the client rotates more often than the idle-renew interval", () => {
    const { session, token } = sessions.create("owner_1", "primary");
    let current = token;

    // Rotate every 5 minutes for 4 hours: well past the original 1 hour TTL.
    for (let i = 0; i < 48; i++) {
      vi.advanceTimersByTime(5 * 60_000);
      const rotated = sessions.rotate(sessions.resolve("primary", current)!);
      expect(rotated).not.toBeNull();
      current = rotated!.token;
      expect(sessions.resolve("primary", current)).not.toBeNull();
      expect(sessions.isLive(session.id)).toBe(true);
    }
    // The session expiry must have moved forward with the rotations.
    const row = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(session.id) as { expires_at: number };
    expect(row.expires_at).toBeGreaterThan(Date.now() + TTL - 60_000);
  });

  it("refuses to rotate an expired session and reports it as not live", () => {
    const { session, token } = sessions.create("owner_1", "primary");
    vi.advanceTimersByTime(TTL + 1000);
    expect(sessions.resolve("primary", token)).toBeNull();
    expect(sessions.isLive(session.id)).toBe(false);
    expect(sessions.rotate(session)).toBeNull();
  });

  it("refuses to rotate or resolve a revoked session", () => {
    const { session, token } = sessions.create("owner_1", "primary");
    sessions.revoke(session.id, "logout");
    expect(sessions.resolve("primary", token)).toBeNull();
    expect(sessions.isLive(session.id)).toBe(false);
    expect(sessions.rotate(session)).toBeNull();
  });

  it("emits a revocation event so open sockets can be closed", () => {
    const { session } = sessions.create("owner_1", "primary");
    const seen: string[] = [];
    sessions.events.on("revoked", (id: string) => seen.push(id));
    sessions.revoke(session.id, "logout");
    expect(seen).toEqual([session.id]);
  });

  it("accepts the previous token only inside the rotation grace window", () => {
    const { token } = sessions.create("owner_1", "primary");
    const session = sessions.resolve("primary", token)!;
    const rotated = sessions.rotate(session)!;
    expect(sessions.resolve("primary", token)).not.toBeNull(); // grace
    vi.advanceTimersByTime(91_000);
    expect(sessions.resolve("primary", token)).toBeNull();
    expect(sessions.resolve("primary", rotated.token)).not.toBeNull();
  });

  it("revokes workspace sessions linked to a primary session", () => {
    const primary = sessions.create("owner_1", "primary");
    const ws = sessions.create("owner_1", "workspace", { parentSessionId: primary.session.id });
    expect(sessions.isLive(ws.session.id)).toBe(true);
    sessions.revoke(primary.session.id, "logout");
    sessions.revokeLinked("primary", primary.session.id, "parent-logout");
    expect(sessions.isLive(ws.session.id)).toBe(false);
    expect(sessions.resolve("workspace", ws.token)).toBeNull();
  });

  it("applies sliding expiry for idle sessions", () => {
    const { session, token } = sessions.create("owner_1", "primary");
    vi.advanceTimersByTime(RENEW + 1000);
    expect(sessions.resolve("primary", token)).not.toBeNull();
    const row = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(session.id) as { expires_at: number };
    expect(row.expires_at).toBeGreaterThan(Date.now() + TTL - 60_000);
  });
});
