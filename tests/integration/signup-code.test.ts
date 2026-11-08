import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { startHarness, type TestHarness } from "../helpers/harness.js";
import { MAX_ATTEMPTS, ResendMailer, SENDS_PER_IP_HOUR, type Mail, type Mailer } from "../../src/control/auth/signupCode.js";
import { createMember } from "../../src/control/auth/owner.js";
import { GOOGLE_CLIENT_COOKIE } from "../../src/control/auth/google.js";
import { sha256Hex } from "../../src/control/auth/passwords.js";

/** Stands in for Resend: keeps what would have been sent. */
class FakeMailer implements Mailer {
  sent: Mail[] = [];
  fail = false;
  async send(mail: Mail) {
    if (this.fail) throw new Error("resend answered 503");
    this.sent.push(mail);
  }
}

let h: TestHarness;
let off: TestHarness;
const mailer = new FakeMailer();
const json = { "content-type": "application/json" };
const cookies = (res: { headers: { getSetCookie(): string[] } }) => res.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
let ips = 0;
/** Each test asks from its own address, so the hourly limit per address only meets the test about it. */
const from = () => `203.0.113.${++ips}`;
const sendCode = (email: string, ip: string, locale = "zh-CN") =>
  h.request("/api/auth/register/code", { method: "POST", headers: { ...json, "cf-connecting-ip": ip, "x-aio-locale": locale }, body: JSON.stringify({ email }) });
const register = (body: Record<string, string>, ip: string, harness = h) =>
  harness.request("/api/auth/register", { method: "POST", headers: { ...json, "cf-connecting-ip": ip }, body: JSON.stringify(body) });
const lastCode = () => /\b(\d{6})\b/.exec(mailer.sent.at(-1)!.subject)![1]!;

// Apple's key list, for the Apple registration below; nothing else leaves the test.
const apple = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...apple.publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const appleToken = (claims: Record<string, unknown>) => {
  const head = `${b64({ alg: "RS256", kid: "test-kid" })}.${b64(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), apple.privateKey).toString("base64url")}`;
};

beforeAll(async () => {
  h = await startHarness({ PA_TRUST_CF_CONNECTING_IP: "1", PA_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", PA_GOOGLE_CLIENT_SECRET: "test-only" }, { mailer });
  off = await startHarness({ PA_TRUST_CF_CONNECTING_IP: "1" });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === "https://appleid.apple.com/auth/keys") return new Response(JSON.stringify({ keys: [jwk] }));
    if (String(input).startsWith("https://api.resend.com")) throw new Error("tests never reach Resend");
    return real(input, init);
  });
});
afterAll(async () => { vi.restoreAllMocks(); await h?.shutdown(); await off?.shutdown(); });

it("tells the register form a code is needed only when the deployment sends one", async () => {
  expect(await (await h.request("/api/auth/session")).json()).toMatchObject({ authenticated: false, emailCode: true });
  expect(await (await off.request("/api/auth/session")).json()).toMatchObject({ authenticated: false, emailCode: false });
});

it("emails a 6-digit code in the console's language, keeps only its hash, and registers with it once", async () => {
  const ip = from();
  const sent = await sendCode("Carol@Example.com", ip);
  expect(sent.status).toBe(200);
  expect(await sent.json()).toEqual({ ok: true, retryAfter: 60 });
  const mail = mailer.sent.at(-1)!;
  const code = lastCode();
  expect(mail).toMatchObject({ from: "一站 <noreply@clawpage.ai>", to: "carol@example.com", subject: `一站验证码：${code}` });
  expect(mail.text).toContain(code);
  expect(mail.html).toContain(code);
  expect(mail.html).toMatch(/^<!doctype html>/);
  const row = h.ctx.db.prepare("SELECT * FROM signup_codes WHERE email='carol@example.com'").get() as Record<string, unknown>;
  expect(Object.values(row).map(String)).not.toContain(code);

  // The code goes out in the sign-up page's language (each of the console's five), and
  // English, Spanish and Japanese mail comes from Clawpage Agent.
  const byLocale: Array<[string, string, (code: string) => string, string]> = [
    ["en", "Clawpage Agent", (c) => `Clawpage Agent verification code: ${c}`, "signing up for Clawpage Agent"],
    ["es", "Clawpage Agent", (c) => `Código de verificación de Clawpage Agent: ${c}`, "Estás creando una cuenta en Clawpage Agent"],
    ["ja", "Clawpage Agent", (c) => `Clawpage Agent 確認コード：${c}`, "Clawpage Agent に登録しようとしています"],
    ["zh-TW", "一站", (c) => `一站驗證碼：${c}`, "你正在註冊一站"],
  ];
  for (const [locale, sender, subject, intro] of byLocale) {
    expect((await sendCode(`dan-${locale}@example.com`, ip, locale)).status).toBe(200);
    const sentMail = mailer.sent.at(-1)!;
    expect(sentMail).toMatchObject({ from: `${sender} <noreply@clawpage.ai>`, subject: subject(lastCode()) });
    expect(sentMail.text).toContain(intro);
    expect(sentMail.html).toContain(intro);
  }

  const base = { email: "carol@example.com", password: "carol-password-123", inviteCode: "" };
  expect(await (await register(base, ip)).json()).toMatchObject({ error: "email_code_required" });
  const wrong = await register({ ...base, emailCode: code === "000000" ? "111111" : "000000" }, ip);
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toMatchObject({ error: "email_code_invalid" });
  const ok = await register({ ...base, emailCode: code }, ip);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, username: "carol", email: "carol@example.com" });
  expect(h.ctx.db.prepare("SELECT 1 FROM signup_codes WHERE email='carol@example.com'").get()).toBeUndefined();
});

it("keeps the code through a refusal that is not about it", async () => {
  const ip = from();
  await sendCode("erin@example.com", ip);
  const code = lastCode();
  expect(await (await register({ email: "erin@example.com", password: "short", inviteCode: "", emailCode: code }, ip)).json()).toMatchObject({ error: "weak_password" });
  expect(await (await register({ email: "erin@example.com", password: "erin-password-123", inviteCode: "ZZZZ-ZZZZ-ZZZZ", emailCode: code }, ip)).json()).toMatchObject({ error: "invalid_invite" });
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  expect((await register({ email: "erin@example.com", password: "erin-password-123", inviteCode: "", emailCode: code }, ip)).status).toBe(200);
});

it("refuses an expired code", async () => {
  const ip = from();
  await sendCode("frank@example.com", ip);
  h.ctx.db.prepare("UPDATE signup_codes SET expires_at=? WHERE email='frank@example.com'").run(Date.now() - 1);
  const res = await register({ email: "frank@example.com", password: "frank-password-123", inviteCode: "", emailCode: lastCode() }, ip);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "email_code_expired" });
});

it(`voids the code after ${MAX_ATTEMPTS} wrong tries, even for the right one after`, async () => {
  const ip = from();
  await sendCode("grace@example.com", ip);
  const code = lastCode();
  const wrong = code === "999999" ? "888888" : "999999";
  const answers: string[] = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) answers.push(((await (await register({ email: "grace@example.com", password: "grace-password-123", inviteCode: "", emailCode: wrong }, ip)).json()) as { error: string }).error);
  expect(answers).toEqual([...Array(MAX_ATTEMPTS - 1).fill("email_code_invalid"), "email_code_attempts"]);
  expect(await (await register({ email: "grace@example.com", password: "grace-password-123", inviteCode: "", emailCode: code }, ip)).json()).toMatchObject({ error: "email_code_attempts" });
});

it("sends an address one email a minute; a new code replaces the old one", async () => {
  const ip = from();
  await sendCode("heidi@example.com", ip);
  const first = lastCode();
  const count = mailer.sent.length;
  const again = await sendCode("heidi@example.com", ip);
  expect(again.status).toBe(429);
  expect(again.headers.get("retry-after")).toMatch(/^\d+$/);
  const body = (await again.json()) as { error: string; retryAfter: number; message: string };
  expect(body).toMatchObject({ error: "email_code_cooldown" });
  expect(body.retryAfter).toBeGreaterThan(0);
  expect(body.retryAfter).toBeLessThanOrEqual(60);
  expect(body.message).toContain(`${body.retryAfter} 秒`);
  expect(mailer.sent.length).toBe(count);

  h.ctx.db.prepare("UPDATE signup_codes SET sent_at=sent_at-61000 WHERE email='heidi@example.com'").run();
  expect((await sendCode("heidi@example.com", ip)).status).toBe(200);
  const second = lastCode();
  if (first !== second) {
    expect(await (await register({ email: "heidi@example.com", password: "heidi-password-123", inviteCode: "", emailCode: first }, ip)).json()).toMatchObject({ error: "email_code_invalid" });
  }
  expect((await register({ email: "heidi@example.com", password: "heidi-password-123", inviteCode: "", emailCode: second }, ip)).status).toBe(200);
});

it(`sends at most ${SENDS_PER_IP_HOUR} emails an hour from one address`, async () => {
  const ip = from();
  for (let i = 0; i < SENDS_PER_IP_HOUR; i++) expect((await sendCode(`busy-${i}@example.com`, ip)).status).toBe(200);
  const refused = await sendCode("busy-last@example.com", ip);
  expect(refused.status).toBe(429);
  expect(await refused.json()).toMatchObject({ error: "email_code_too_many" });
  // Another address is not held back by it.
  expect((await sendCode("busy-last@example.com", from())).status).toBe(200);
});

it("answers a registered email exactly like a new one, and mails it a notice instead of a code", async () => {
  const ip = from();
  await createMember(h.ctx.db, "Legacy", "legacy-password-123");
  await sendCode("known@example.com", ip);
  expect((await register({ email: "known@example.com", password: "known-password-123", inviteCode: "", emailCode: lastCode() }, ip)).status).toBe(200);
  h.ctx.db.prepare("DELETE FROM signup_codes").run();

  const fresh = await sendCode("unknown@example.com", ip);
  const count = mailer.sent.length;
  const known = await sendCode("KNOWN@example.com", ip);
  expect(known.status).toBe(fresh.status);
  expect(await known.json()).toEqual(await fresh.json());
  expect(mailer.sent.length).toBe(count + 1);
  const notice = mailer.sent.at(-1)!;
  expect(notice).toMatchObject({ to: "known@example.com", subject: "一站：这个邮箱已有账号" });
  expect(`${notice.subject}${notice.text}${notice.html}`).not.toMatch(/\d{6}/);
  // Guessing there fails like a wrong code, never "this email is taken".
  for (const emailCode of ["123456", "654321"]) {
    expect(await (await register({ email: "known@example.com", password: "known-password-123", inviteCode: "", emailCode }, ip)).json()).toMatchObject({ error: "email_code_invalid" });
  }
  // An old account's hidden placeholder is answered the same and gets no email at all.
  const placeholder = await sendCode("legacy@clawpage.ai", ip);
  expect(await placeholder.json()).toEqual({ ok: true, retryAfter: 60 });
  expect(mailer.sent.length).toBe(count + 1);
});

it("lets the address ask again at once when the email could not be sent", async () => {
  const ip = from();
  mailer.fail = true;
  try {
    const failed = await sendCode("ivan@example.com", ip);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "email_send_failed", message: "验证码邮件没有发出去，请稍后再试" });
  } finally {
    mailer.fail = false;
  }
  expect((await sendCode("ivan@example.com", ip)).status).toBe(200);
  expect((await sendCode("not-an-email", ip)).status).toBe(400);
});

it("refuses a cross-site request for a code", async () => {
  const res = await h.request("/api/auth/register/code", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ email: "x@example.com" }) });
  expect(res.status).toBe(403);
});

it("asks Google and Apple registrations for no code", async () => {
  const ip = from();
  // A Google sign-in the server has verified (as the callback leaves it), waiting to register.
  h.ctx.db.prepare("INSERT INTO google_login_flows (state_hash,client_hash,verifier,nonce,native,status,expires_at,subject,email) VALUES (?,?,?,?,0,'ready',?,?,?)")
    .run("state-1", sha256Hex("google-client"), "v", "n", Date.now() + 60_000, "google-sub", "googler@example.com");
  const google = await h.request("/api/auth/google/register", { method: "POST", headers: { ...json, "cf-connecting-ip": ip, cookie: `${GOOGLE_CLIENT_COOKIE}=google-client` }, body: JSON.stringify({ inviteCode: "" }) });
  expect(google.status).toBe(200);
  expect(await google.json()).toMatchObject({ email: "googler@example.com" });

  const start = await h.request("/api/auth/apple/start", { method: "POST", headers: json, body: "{}" });
  const client = cookies(start);
  const { nonce } = (await start.json()) as { nonce: string };
  const now = Math.floor(Date.now() / 1000);
  await h.request("/api/auth/apple/verify", { method: "POST", headers: { ...json, cookie: client }, body: JSON.stringify({ identityToken: appleToken({
    iss: "https://appleid.apple.com", aud: "ai.clawpage.agent", sub: "apple-sub", exp: now + 600, iat: now, nonce, email: "apple-sub@privaterelay.appleid.com", email_verified: "true" }) }) });
  const appled = await h.request("/api/auth/apple/register", { method: "POST", headers: { ...json, cookie: client }, body: JSON.stringify({ inviteCode: "" }) });
  expect(appled.status).toBe(200);
  expect(await appled.json()).toMatchObject({ email: "apple-sub@privaterelay.appleid.com" });
  expect(mailer.sent.filter(m => m.to === "googler@example.com" || m.to.endsWith("privaterelay.appleid.com"))).toEqual([]);
});

it("without a Resend key, registers without a code and offers none", async () => {
  const ip = from();
  expect((await off.request("/api/auth/register/code", { method: "POST", headers: { ...json, "cf-connecting-ip": ip }, body: JSON.stringify({ email: "open@example.com" }) })).status).toBe(404);
  const res = await register({ email: "open@example.com", password: "open-password-123", inviteCode: "" }, ip, off);
  expect(res.status).toBe(200);
});

it("sends through Resend's HTTP API with the key, and reports only Resend's error name", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let answer = new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  const resend = new ResendMailer("re_test_key", (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer; }) as unknown as typeof fetch);
  const mail = { from: "一站 <noreply@clawpage.ai>", to: "a@example.com", subject: "s", text: "t", html: "<p>h</p>" };
  await resend.send(mail);
  expect(calls[0]!.url).toBe("https://api.resend.com/emails");
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer re_test_key", "content-type": "application/json" });
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: mail.from, to: ["a@example.com"], subject: "s", text: "t", html: "<p>h</p>" });
  answer = new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field: a@example.com" }), { status: 422 });
  await expect(resend.send(mail)).rejects.toThrow(/^resend answered 422 validation_error$/);
});
