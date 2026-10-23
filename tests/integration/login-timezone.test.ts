import { it, expect } from "vitest";
import { startHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { loginTimezone } from "../../src/control/auth/loginTimezone.js";

const feedZone = (db: { prepare(sql: string): { get(...a: unknown[]): unknown } }, owner: string) =>
  (db.prepare("SELECT timezone FROM schedules WHERE builtin='daily_feed' AND owner_id=?").get(owner) as { timezone: string } | undefined)?.timezone;
const settle = () => new Promise((r) => setTimeout(r, 50));

it("moves an account's daily feed to the time zone its browser signed in from", async () => {
  const root = await startHarness(), member = await startHarness();
  try {
    const signIn = (body: Record<string, unknown>) =>
      root.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(feedZone(root.ctx.db, "owner_1")).toBe(root.ctx.cfg.browser.timezone);

    // A zone that is not a real one, or none at all, leaves the feed where it was.
    for (const timeZone of ["Mars/Olympus", 42, undefined]) {
      expect((await signIn({ password: "correct horse battery staple", timeZone })).status).toBe(200);
      await settle();
      expect(feedZone(root.ctx.db, "owner_1")).toBe(root.ctx.cfg.browser.timezone);
    }
    // A wrong password moves nothing either.
    expect((await signIn({ password: "wrong", timeZone: "Asia/Tokyo" })).status).toBe(401);
    await settle();
    expect(feedZone(root.ctx.db, "owner_1")).toBe(root.ctx.cfg.browser.timezone);

    expect((await signIn({ password: "correct horse battery staple", timeZone: "Asia/Shanghai" })).status).toBe(200);
    await settle();
    expect(feedZone(root.ctx.db, "owner_1")).toBe("Asia/Shanghai");

    // A member's feed lives in its own runtime; only that one moves.
    const user = await createMember(root.ctx.db, "zone-member", "member-secret-123");
    member.ctx.db.prepare("INSERT INTO owners(id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,'member','x','x','{}',0)").run(user.id, user.username);
    member.ctx.cfg.runtimeUserId = user.id;
    member.ctx.tasks.init();
    expect(feedZone(member.ctx.db, user.id)).toBe(member.ctx.cfg.browser.timezone);
    root.ctx.runtimeForUser = async (id) => { if (id === user.id) return member.ctx; throw Error("unknown"); };
    root.ctx.db.prepare("DELETE FROM login_failures").run();
    expect((await signIn({ email: "zone-member", password: "member-secret-123", timeZone: "Europe/Berlin" })).status).toBe(200);
    await settle();
    expect(feedZone(member.ctx.db, user.id)).toBe("Europe/Berlin");
    expect(feedZone(root.ctx.db, "owner_1")).toBe("Asia/Shanghai");
  } finally {
    await member.shutdown();
    await root.shutdown();
  }
});

it("accepts only real IANA zones, in their canonical spelling", () => {
  expect(loginTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
  expect(loginTimezone("asia/shanghai")).toBe("Asia/Shanghai");
  expect(loginTimezone("UTC")).toBe("UTC");
  for (const bad of ["", "Mars/Olympus", "x".repeat(65), null, 8]) expect(loginTimezone(bad)).toBeNull();
});
