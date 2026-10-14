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
  const res = await register({ email: "Alice@Example.com", password: "alice-password-123", inviteCode: code.replace(/-/g, "").toLowerCase() });
  expect(res.status).toBe(200);
  // The email is stored lowercase; the username (the account's address) is made from it.
  expect(await res.json()).toMatchObject({ ok: true, username: "alice", email: "alice@example.com", role: "member" });
  const cookie = res.headers.getSetCookie().map(s => s.split(";")[0]!).join("; ");
  expect(await (await h.request("/api/auth/session", { headers: { cookie } })).json()).toMatchObject({ authenticated: true, username: "alice", email: "alice@example.com", role: "member" });
  // A registered member is an ordinary member: owner settings stay closed.
  expect((await h.request("/api/settings/invites", { headers: { cookie } })).status).toBe(403);

  const again = await register({ email: "alice2@example.com", password: "alice-password-123", inviteCode: code });
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ error: "invite_used" });

  const list = (await (await h.request("/api/settings/invites", { headers: owner })).json()) as { invites: Array<{ code: string; note: string; usedBy: string | null; usedAt: number | null }> };
  expect(list.invites.find(i => i.code === code)).toMatchObject({ note: "alice@example.com", usedBy: "alice" });
  clearFailures();
});

it("refuses an invalid supplied code even while registration is open", async () => {
  for (const inviteCode of ["AAAA-BBBB-CCCC"]) {
    const res = await register({ email: "mallory@example.com", password: "mallory-password-123", inviteCode });
    expect(res.status).toBe(400);
  }
  expect(h.ctx.db.prepare("SELECT 1 FROM owners WHERE username='mallory'").get()).toBeUndefined();
  clearFailures();
});

it("validates the email and password before spending the code", async () => {
  const code = await issue();
  await register({ email: "taken@example.com", password: "taken-password-123" });
  for (const email of ["", "bob", "bob@", "bob@example", `${"b".repeat(250)}@example.com`]) expect((await register({ email, password: "long-enough-pass", inviteCode: code })).status).toBe(400);
  expect((await register({ email: "bob@example.com", password: "short", inviteCode: code })).status).toBe(400);
  const taken = await register({ email: "TAKEN@example.com", password: "long-enough-pass", inviteCode: code });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toMatchObject({ error: "email_taken" });
  // An old account's hidden placeholder email is taken too.
  expect((await register({ email: "owner@clawpage.ai", password: "long-enough-pass", inviteCode: code })).status).toBe(409);
  // None of those used the code up.
  expect((await register({ email: "bob@example.com", password: "long-enough-pass", inviteCode: code })).status).toBe(200);
});

it("makes a free username from the email, never a reserved one", async () => {
  const made = async (email: string) => ((await (await register({ email, password: "long-enough-pass" })).json()) as { username: string }).username;
  expect(await made("bob@other.example")).toMatch(/^bob-[a-z2-9]{4}$/);
  expect(await made("owner@example.org")).toMatch(/^owner-[a-z2-9]{4}$/);
  expect(await made("Jane.Doe+news@example.com")).toBe("jane-doe-news");
  expect(await made("x@example.com")).toBe("user");
});

it("signs in with the email in any case, and old accounts keep signing in with their username", async () => {
  const signIn = (body: Record<string, string>) => h.request("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify(body) });
  expect((await signIn({ email: "ALICE@example.com", password: "alice-password-123" })).status).toBe(200);
  expect((await signIn({ email: "alice@example.com", password: "wrong-password-123" })).status).toBe(401);
  clearFailures();
  await createMember(h.ctx.db, "Legacy", "legacy-password-123");
  // An account without an email gets `<username>@clawpage.ai`, hidden from the person.
  expect(h.ctx.db.prepare("SELECT email,email_placeholder FROM owners WHERE username='Legacy'").get()).toEqual({ email: "Legacy@clawpage.ai", email_placeholder: 1 });
  const byName = await signIn({ username: "Legacy", password: "legacy-password-123" });
  expect(byName.status).toBe(200);
  const cookie = byName.headers.getSetCookie().map(s => s.split(";")[0]!).join("; ");
  expect(await (await h.request("/api/auth/session", { headers: { cookie } })).json()).toMatchObject({ authenticated: true, username: "Legacy", email: null });
  expect((await signIn({ email: "Legacy", password: "legacy-password-123" })).status).toBe(200);
  expect((await signIn({ email: "legacy@clawpage.ai", password: "legacy-password-123" })).status).toBe(200);
  clearFailures();
});

it("gives a racing pair exactly one account per code", async () => {
  const code = await issue();
  const [a, b] = await Promise.all([
    register({ email: "racer-a@example.com", password: "racer-password-123", inviteCode: code }),
    register({ email: "racer-b@example.com", password: "racer-password-123", inviteCode: code }),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 400]);
  clearFailures();
});

it("lets the owner revoke an unused code", async () => {
  const code = await issue();
  expect((await h.request(`/api/settings/invites/${code}`, { method: "DELETE", headers: owner })).status).toBe(200);
  expect((await h.request(`/api/settings/invites/${code}`, { method: "DELETE", headers: owner })).status).toBe(409);
  expect(await (await register({ email: "late@example.com", password: "late-password-123", inviteCode: code })).json()).toMatchObject({ error: "invalid_invite" });
  clearFailures();
});

it("locks out an address that keeps guessing codes", async () => {
  for (let i = 0; i < h.ctx.cfg.loginMaxFailures; i++) await register({ email: "guesser@example.com", password: "guess-password-123", inviteCode: `ZZZZ-ZZZZ-ZZ${i}Z` });
  expect((await register({ email: "guesser@example.com", password: "guess-password-123", inviteCode: await issue() })).status).toBe(429);
  clearFailures();
});

it("rejects cross-site registration", async () => {
  const res = await h.request("/api/auth/register", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ email: "x1@example.com", password: "x-password-1234", inviteCode: await issue() }) });
  expect(res.status).toBe(403);
});

it("registers without an invite while fewer than 20 accounts exist", async () => {
  expect(await (await h.request("/api/auth/session")).json()).toMatchObject({ registrationRequiresInvite: false });
  const res = await register({ email: "open-member@example.com", password: "open-password-123" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ role: "member", username: "open-member", email: "open-member@example.com" });
});

it("counts all existing accounts and requires a valid invite at 20", async () => {
  const count = () => (h.ctx.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as {n: number}).n;
  while (count() < 20) {
    const n = count();
    h.ctx.db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) SELECT ?,?, 'member', password_hash,password_salt,password_params,created_at FROM owners WHERE role='owner'").run(`seed-${n}`, `seed-${n}`);
  }
  expect(await (await h.request("/api/auth/session")).json()).toMatchObject({ registrationRequiresInvite: true });
  const refused = await register({ email: "needs-invite@example.com", password: "open-password-123" });
  expect(await refused.json()).toMatchObject({ error: "invite_required" });
  expect(refused.status).toBe(400);
  expect(count()).toBe(20);
  expect((await register({ email: "needs-invite@example.com", password: "open-password-123", inviteCode: await issue() })).status).toBe(200);
  expect(count()).toBe(21);
});
