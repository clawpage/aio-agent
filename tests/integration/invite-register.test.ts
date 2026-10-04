import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, login, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";

let h: TestHarness;
let owner: Record<string, string>;
const json = { "content-type": "application/json" };

beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h);
  owner = { cookie: auth.cookie, "x-csrf-token": auth.csrf, ...json };
});
afterAll(async () => { await h?.shutdown(); });

const register = (body: Record<string, string>) =>
  h.request("/api/auth/register", { method: "POST", headers: json, body: JSON.stringify(body) });
const issue = async (note = "") => {
  const res = await h.request("/api/settings/invites", { method: "POST", headers: owner, body: JSON.stringify({ note }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { invite: { code: string } }).invite.code;
};
const clearFailures = () => h.ctx.db.prepare("DELETE FROM login_failures").run();

it("registers with a one-time invite code, signs the new member in, and burns the code", async () => {
  const code = await issue("alice@example.com");
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  // Pasted lowercase without dashes still counts.
  const res = await register({ username: "alice", password: "alice-password-123", inviteCode: code.replace(/-/g, "").toLowerCase() });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, username: "alice", role: "member" });
  const cookie = res.headers.getSetCookie().map(s => s.split(";")[0]!).join("; ");
  expect(await (await h.request("/api/auth/session", { headers: { cookie } })).json()).toMatchObject({ authenticated: true, username: "alice", role: "member" });
  // A registered member is an ordinary member: owner settings stay closed.
  expect((await h.request("/api/settings/invites", { headers: { cookie } })).status).toBe(403);

  const again = await register({ username: "alice2", password: "alice-password-123", inviteCode: code });
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ error: "invite_used" });

  const list = (await (await h.request("/api/settings/invites", { headers: owner })).json()) as { invites: Array<{ code: string; note: string; usedBy: string | null; usedAt: number | null }> };
  expect(list.invites.find(i => i.code === code)).toMatchObject({ note: "alice@example.com", usedBy: "alice" });
  clearFailures();
});

it("refuses without a valid code and never creates the account", async () => {
  for (const inviteCode of ["", "AAAA-BBBB-CCCC"]) {
    const res = await register({ username: "mallory", password: "mallory-password-123", inviteCode });
    expect(res.status).toBe(400);
  }
  expect(h.ctx.db.prepare("SELECT 1 FROM owners WHERE username='mallory'").get()).toBeUndefined();
  clearFailures();
});

it("validates the name and password before spending the code", async () => {
  const code = await issue();
  await createMember(h.ctx.db, "taken", "taken-password-123");
  expect((await register({ username: "owner", password: "long-enough-pass", inviteCode: code })).status).toBe(400);
  expect((await register({ username: "Bob", password: "long-enough-pass", inviteCode: code })).status).toBe(400);
  expect((await register({ username: "bob", password: "short", inviteCode: code })).status).toBe(400);
  const taken = await register({ username: "taken", password: "long-enough-pass", inviteCode: code });
  expect(taken.status).toBe(409);
  // None of those used the code up.
  expect((await register({ username: "bob", password: "long-enough-pass", inviteCode: code })).status).toBe(200);
});

it("gives a racing pair exactly one account per code", async () => {
  const code = await issue();
  const [a, b] = await Promise.all([
    register({ username: "racer-a", password: "racer-password-123", inviteCode: code }),
    register({ username: "racer-b", password: "racer-password-123", inviteCode: code }),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 400]);
  clearFailures();
});

it("lets the owner revoke an unused code", async () => {
  const code = await issue();
  expect((await h.request(`/api/settings/invites/${code}`, { method: "DELETE", headers: owner })).status).toBe(200);
  expect((await h.request(`/api/settings/invites/${code}`, { method: "DELETE", headers: owner })).status).toBe(409);
  expect(await (await register({ username: "late", password: "late-password-123", inviteCode: code })).json()).toMatchObject({ error: "invalid_invite" });
  clearFailures();
});

it("locks out an address that keeps guessing codes", async () => {
  for (let i = 0; i < h.ctx.cfg.loginMaxFailures; i++) await register({ username: "guesser", password: "guess-password-123", inviteCode: `ZZZZ-ZZZZ-ZZ${i}Z` });
  expect((await register({ username: "guesser", password: "guess-password-123", inviteCode: await issue() })).status).toBe(429);
  clearFailures();
});

it("rejects cross-site registration", async () => {
  const res = await h.request("/api/auth/register", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ username: "x1", password: "x-password-1234", inviteCode: await issue() }) });
  expect(res.status).toBe(403);
});
