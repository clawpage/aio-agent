import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MAX_ATTEMPTS, type Mail, type Mailer } from "../../src/control/auth/signupCode.js";

/** Stands in for Resend: keeps what would have been sent. */
class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail) { this.sent.push(mail); }
}

let h: TestHarness;
let off: TestHarness;
const mailer = new FakeMailer();
let ips = 0;
const json = { "content-type": "application/json" };
const cookies = (res: { headers: { getSetCookie(): string[] } }) => res.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
const csrfOf = (res: { headers: { getSetCookie(): string[] } }) => decodeURIComponent(/pa_csrf=([^;]+)/.exec(res.headers.getSetCookie().join(";"))?.[1] ?? "");
const lastCode = () => /\b(\d{6})\b/.exec(mailer.sent.at(-1)!.subject)![1]!;

/** Signs in from its own address, so lockouts and hourly limits meet only the test about them. */
async function signIn(harness: TestHarness, identifier: string, password: string) {
  const ip = `198.51.100.${++ips}`;
  const res = await harness.request("/api/auth/login", { method: "POST", headers: { ...json, "cf-connecting-ip": ip }, body: JSON.stringify({ email: identifier, password }) });
  expect(res.status).toBe(200);
  const s = { cookie: cookies(res), csrf: csrfOf(res), ip };
  const call = (path: string, body?: unknown) => harness.request(path, body === undefined
    ? { headers: { cookie: s.cookie, "cf-connecting-ip": ip } }
    : { method: "POST", headers: { ...json, cookie: s.cookie, "x-csrf-token": s.csrf, "cf-connecting-ip": ip, "x-aio-locale": "zh-CN" }, body: JSON.stringify(body) });
  return { ...s, call };
}

beforeAll(async () => {
  h = await startHarness({ PA_TRUST_CF_CONNECTING_IP: "1" }, { mailer });
  off = await startHarness({ PA_TRUST_CF_CONNECTING_IP: "1" });
  // As in production: a member's other requests go to its own runtime, which sends no email.
  h.ctx.runtimeForUser = async (id) => (id === "owner_1" ? h.ctx : off.ctx);
});
afterAll(async () => { await h?.shutdown(); await off?.shutdown(); });

it("binds the email an account from before email enters, together with the new password", async () => {
  await createMember(h.ctx.db, "oldtimer", "member-password-123");
  const a = await signIn(h, "oldtimer", "member-password-123");
  expect(await (await a.call("/api/account/security")).json()).toEqual({ available: true, email: null, minPassword: 12 });
  // Without an email there is nowhere to send the code.
  expect(await (await a.call("/api/account/password/code", {})).json()).toMatchObject({ error: "invalid_email" });

  expect((await a.call("/api/account/password/code", { email: "Old.Timer@Example.com" })).status).toBe(200);
  const mail = mailer.sent.at(-1)!;
  const code = lastCode();
  expect(mail).toMatchObject({ to: "old.timer@example.com", subject: `一站验证码：${code}` });
  expect(mail.text).toContain("绑定这个邮箱并修改登录密码");
  // The code fits only the address it was sent to.
  expect(await (await a.call("/api/account/password", { email: "other@example.com", password: "brand-new-password-456", code })).json()).toMatchObject({ error: "email_code_invalid" });
  const changed = await a.call("/api/account/password", { email: "old.timer@example.com", password: "brand-new-password-456", code });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ ok: true, email: "old.timer@example.com" });
  expect(await (await a.call("/api/auth/session")).json()).toMatchObject({ email: "old.timer@example.com" });
  expect(await (await a.call("/api/account/security")).json()).toMatchObject({ email: "old.timer@example.com" });
  // The email and the new password sign in from now on.
  await signIn(h, "old.timer@example.com", "brand-new-password-456");
});

it("answers a code for an address that has an account the same way, with a notice and no code", async () => {
  await createMember(h.ctx.db, "second", "member-password-123");
  h.ctx.db.prepare("UPDATE owners SET email='taken@example.com',email_placeholder=0 WHERE username='second'").run();
  await createMember(h.ctx.db, "third", "member-password-123");
  const a = await signIn(h, "third", "member-password-123");
  const res = await a.call("/api/account/password/code", { email: "taken@example.com" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, retryAfter: 60 });
  const mail = mailer.sent.at(-1)!;
  expect(mail.to).toBe("taken@example.com");
  expect(mail.subject).not.toMatch(/\d{6}/);
  expect(mail.text).not.toMatch(/\d{6}/);
  // No code that would work was told to anybody, and nothing changed.
  expect((await a.call("/api/account/password", { email: "taken@example.com", password: "brand-new-password-456", code: "000000" })).status).toBe(400);
  expect(h.ctx.db.prepare("SELECT email_placeholder FROM owners WHERE username='third'").get()).toMatchObject({ email_placeholder: 1 });
  await signIn(h, "third", "member-password-123");
});

it("changes the password with the code emailed to the account, signs the other logins out, keeps this one", async () => {
  await createMember(h.ctx.db, "changer", "member-password-123");
  h.ctx.db.prepare("UPDATE owners SET email='changer@example.com',email_placeholder=0 WHERE username='changer'").run();
  const a = await signIn(h, "changer@example.com", "member-password-123");
  const other = await signIn(h, "changer@example.com", "member-password-123");
  expect((await a.call("/api/account/password/code", {})).status).toBe(200);
  const mail = mailer.sent.at(-1)!;
  expect(mail.to).toBe("changer@example.com");
  expect(mail.text).toContain("修改一站的登录密码");
  // One email a minute.
  const again = await a.call("/api/account/password/code", {});
  expect(again.status).toBe(429);
  expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
  const code = lastCode();
  // A short password is refused before the code is tried, so it costs no try.
  expect(await (await a.call("/api/account/password", { password: "short", code })).json()).toMatchObject({ error: "weak_password" });
  const changed = await a.call("/api/account/password", { password: "brand-new-password-456", code });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ ok: true, email: "changer@example.com" });
  expect(await (await a.call("/api/auth/session")).json()).toMatchObject({ authenticated: true });
  expect(await (await other.call("/api/auth/session")).json()).toMatchObject({ authenticated: false });
  // The old password is gone, the new one works, and the code went with the change.
  const old = await h.request("/api/auth/login", { method: "POST", headers: { ...json, "cf-connecting-ip": "198.51.100.250" }, body: JSON.stringify({ email: "changer@example.com", password: "member-password-123" }) });
  expect(old.status).toBe(401);
  await signIn(h, "changer@example.com", "brand-new-password-456");
  expect((await a.call("/api/account/password", { password: "another-password-789", code })).status).toBe(400);
});

it("lets a code survive only a few wrong tries", async () => {
  await createMember(h.ctx.db, "guesser", "member-password-123");
  h.ctx.db.prepare("UPDATE owners SET email='guesser@example.com',email_placeholder=0 WHERE username='guesser'").run();
  const a = await signIn(h, "guesser", "member-password-123");
  await a.call("/api/account/password/code", {});
  const code = lastCode();
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 1; i < MAX_ATTEMPTS; i++) expect(await (await a.call("/api/account/password", { password: "brand-new-password-456", code: wrong })).json()).toMatchObject({ error: "email_code_invalid" });
  expect(await (await a.call("/api/account/password", { password: "brand-new-password-456", code: wrong })).json()).toMatchObject({ error: "email_code_attempts" });
  expect(await (await a.call("/api/account/password", { password: "brand-new-password-456", code })).json()).toMatchObject({ error: "email_code_attempts" });
});

it("needs a signed-in member, the CSRF token, and a deployment that sends email", async () => {
  expect((await h.request("/api/account/password/code", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
  const owner = await login(h);
  const security = await h.request("/api/account/security", { headers: { cookie: owner.cookie } });
  expect(await security.json()).toMatchObject({ available: false });
  const refused = await h.request("/api/account/password/code", { method: "POST", headers: { ...json, cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: "{}" });
  expect(refused.status).toBe(403);
  await createMember(h.ctx.db, "nocsrf", "member-password-123");
  const a = await signIn(h, "nocsrf", "member-password-123");
  expect((await h.request("/api/account/password/code", { method: "POST", headers: { ...json, cookie: a.cookie, "cf-connecting-ip": a.ip }, body: JSON.stringify({ email: "x@example.com" }) })).status).toBe(403);

  await createMember(off.ctx.db, "nomail", "member-password-123");
  const b = await signIn(off, "nomail", "member-password-123");
  expect(await (await b.call("/api/account/security")).json()).toMatchObject({ available: false });
  expect((await b.call("/api/account/password/code", { email: "x@example.com" })).status).toBe(404);
});
