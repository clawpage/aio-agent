import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { OAuth2Client, LoginTicket } from "google-auth-library";
import { startHarness, type TestHarness } from "../helpers/harness.js";
import { createInvite } from "../../src/control/auth/invites.js";
import { GOOGLE_TTL } from "../../src/control/auth/google.js";

let h: TestHarness;
const json = {"content-type": "application/json"};
const cookies = (res: {headers: {getSetCookie(): string[]}}) => res.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
let subject = 0;
const nonces = new Map<string, string>();
let slowToken: Promise<void> | null = null;
beforeAll(async () => {
  h = await startHarness({PA_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", PA_GOOGLE_CLIENT_SECRET: "test-only"});
  vi.spyOn(OAuth2Client.prototype, "getToken").mockImplementation(async options => {
    const code = typeof options === "string" ? options : options.code;
    if (code === "forged") throw new Error("provider secret must not leak");
    const row = h.ctx.db.prepare("SELECT nonce FROM google_login_flows WHERE status='exchanging'").get() as {nonce: string};
    nonces.set(code, row.nonce);
    if (code === "slow" && slowToken) await slowToken;
    return {tokens: {id_token: code}, res: null} as any;
  });
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockImplementation(async options => {
    expect(options.audience).toBe("fixture.apps.googleusercontent.com");
    return new LoginTicket("", {sub: options.idToken, email: "google@example.com", email_verified: options.idToken !== "unverified",
      nonce: options.idToken === "bad-nonce" ? "other" : nonces.get(options.idToken)} as any);
  });
});
beforeEach(() => h.ctx.db.prepare("DELETE FROM login_failures").run());
afterAll(async () => { vi.restoreAllMocks(); await h?.shutdown(); });

async function begin(native = false) {
  const start = await h.request("/api/auth/google/start", {method: "POST", headers: json, body: JSON.stringify({native})});
  expect(start.status).toBe(200);
  const client = cookies(start);
  const url = new URL(((await start.json()) as {url: string}).url);
  const authorize = await h.request(url.pathname + url.search, {headers: {cookie: native ? "" : client}});
  expect(authorize.status).toBe(303);
  const google = new URL(authorize.headers.get("location")!);
  expect(google.origin).toBe("https://accounts.google.com");
  expect(google.searchParams.get("scope")).toBe("openid email");
  expect(google.searchParams.get("code_challenge_method")).toBe("S256");
  expect(google.searchParams.get("nonce")).toBeTruthy();
  return {client, browser: cookies(authorize), state: url.searchParams.get("state")!};
}
const callback = (flow: Awaited<ReturnType<typeof begin>>, sub = `sub-${++subject}`, native = false) =>
  h.request(`/api/auth/google/callback?state=${flow.state}&code=${sub}`, {headers: {cookie: native ? flow.browser : `${flow.client}; ${flow.browser}`}});
const activate = (client: string, username: string, inviteCode: string) => h.request("/api/auth/google/register", {
  method: "POST", headers: {...json, cookie: client}, body: JSON.stringify({username, inviteCode}),
});

it("requires an invite after verified Google sign-in, before any session or sandbox access", async () => {
  const flow = await begin();
  const count = h.ctx.db.prepare("SELECT count(*) AS n FROM owners").get();
  const result = await callback(flow, "stable-subject");
  expect(result.headers.get("location")).toBe("/login?google=invite");
  expect(cookies(result)).not.toContain("pa_session=");
  expect(h.ctx.db.prepare("SELECT count(*) AS n FROM owners").get()).toEqual(count);
  expect((await h.request("/api/status", {headers: {cookie: flow.client}})).status).toBe(401);
  expect(await (await h.request("/api/auth/google/pending", {headers: {cookie: flow.client}})).json()).toEqual({enabled: true, pending: {email: "google@example.com"}});
  expect((await activate(flow.client, "google-alice", "")).status).toBe(400);
  const code = createInvite(h.ctx.db).code;
  const registered = await activate(flow.client, "google-alice", code);
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({role: "member", username: "google-alice"});
  const cookie = cookies(registered);
  expect(await (await h.request("/api/auth/session", {headers: {cookie}})).json()).toMatchObject({authenticated: true, role: "member"});
  expect((await h.request("/api/settings/invites", {headers: {cookie}})).status).toBe(403);
  expect((await activate(flow.client, "other-name", code)).status).toBe(401);
});

it("returns an existing Google subject directly to its member account without another invite", async () => {
  const flow = await begin();
  const result = await callback(flow, "stable-subject");
  expect(result.headers.get("location")).toBe("/login");
  expect(await (await h.request("/api/auth/session", {headers: {cookie: cookies(result)}})).json()).toMatchObject({username: "google-alice", role: "member"});
});

it("never treats a matching email or username as an existing account link", async () => {
  const flow = await begin();
  await callback(flow);
  const code = createInvite(h.ctx.db).code;
  expect((await activate(flow.client, "owner", code)).status).toBe(400);
  expect(h.ctx.db.prepare("SELECT 1 FROM google_identities WHERE owner_id='owner_1'").get()).toBeUndefined();
  expect(h.ctx.db.prepare("SELECT used_at FROM invites WHERE code=?").get(code)).toEqual({used_at: null});
});

it("refuses unverified email, wrong nonce and failed signed-token verification without leaking provider errors", async () => {
  for (const code of ["unverified", "bad-nonce", "forged"]) {
    const flow = await begin();
    const res = await callback(flow, code);
    expect(res.headers.get("location")).toBe("/login?google=error");
    expect(await res.text()).not.toContain("provider secret");
    expect(await (await h.request("/api/auth/google/pending", {headers: {cookie: flow.client}})).json()).toMatchObject({pending: null});
  }
});

it("rejects missing browser/client bindings, wrong state and repeated callbacks", async () => {
  const flow = await begin();
  for (const cookie of [flow.client, flow.browser, ""]) {
    const res = await h.request(`/api/auth/google/callback?state=${flow.state}&code=intruder`, {headers: {cookie}});
    expect(res.headers.get("location")).toBe("/login?google=error");
  }
  expect((await h.request("/api/auth/google/callback?state=wrong&code=intruder")).headers.get("location")).toBe("/login?google=error");
  expect((await callback(flow)).headers.get("location")).toBe("/login?google=invite");
  expect((await callback(flow)).headers.get("location")).toBe("/login?google=error");
});

it("returns native authentication only through a one-use handoff bound to the initiating App cookie", async () => {
  const flow = await begin(true);
  const result = await callback(flow, `native-${++subject}`, true);
  const url = new URL(result.headers.get("location")!);
  expect(url.protocol).toBe("aioagent:"); expect(url.hostname).toBe("auth");
  const ticket = url.searchParams.get("ticket");
  const redeem = (cookie: string) => h.request("/api/auth/google/redeem", {method: "POST", headers: {...json, cookie}, body: JSON.stringify({ticket})});
  expect((await redeem(flow.browser)).status).toBe(401);
  expect(await (await h.request("/api/auth/google/pending", {headers: {cookie: flow.client}})).json()).toMatchObject({pending: null});
  expect(await (await redeem(flow.client)).json()).toMatchObject({authenticated: false, pending: {email: "google@example.com"}});
  expect((await redeem(flow.client)).status).toBe(401);
  expect((await activate(flow.client, "native-member", createInvite(h.ctx.db).code)).status).toBe(200);
});

it("atomically spends an invite only once across Google accounts", async () => {
  const a = await begin(); await callback(a);
  const b = await begin(); await callback(b);
  const code = createInvite(h.ctx.db).code;
  const results = await Promise.all([activate(a.client, "google-race-a", code), activate(b.client, "google-race-b", code)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 400]);
});

it("cannot create two member accounts for the same Google subject racing with different invites", async () => {
  const a = await begin(); await callback(a, "same-racing-subject");
  const b = await begin(); await callback(b, "same-racing-subject");
  const codes = [createInvite(h.ctx.db).code, createInvite(h.ctx.db).code];
  const results = await Promise.all([activate(a.client, "same-google-a", codes[0]), activate(b.client, "same-google-b", codes[1])]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(h.ctx.db.prepare("SELECT count(*) AS n FROM invites WHERE code IN (?,?) AND used_at IS NOT NULL").get(...codes)).toEqual({n: 1});
});

it("cancelling while Google exchanges a code prevents late completion from creating a session", async () => {
  let release!: () => void;
  slowToken = new Promise<void>(resolve => { release = resolve; });
  const flow = await begin();
  const result = callback(flow, "slow");
  await vi.waitFor(() => expect(h.ctx.db.prepare("SELECT 1 FROM google_login_flows WHERE status='exchanging'").get()).toBeTruthy());
  await h.request("/api/auth/google/cancel", {method: "POST", headers: {...json, cookie: flow.client}});
  release();
  const response = await result;
  expect(response.headers.get("location")).toBe("/login?google=error");
  expect(cookies(response)).not.toContain("pa_session=");
  slowToken = null;
});

it("refuses expired, cancelled and cross-site registration flows, and rate limits invite guesses", async () => {
  const flow = await begin(); await callback(flow);
  expect((await h.request("/api/auth/google/register", {method: "POST", headers: {...json, cookie: flow.client, origin: "https://evil.example"}, body: "{}"})).status).toBe(403);
  for (let i = 0; i < h.ctx.cfg.loginMaxFailures; i++) await activate(flow.client, "google-guesser", "BAD-INVITE");
  expect((await activate(flow.client, "google-guesser", createInvite(h.ctx.db).code)).status).toBe(429);
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  h.ctx.db.prepare("UPDATE google_login_flows SET expires_at=expires_at-?").run(GOOGLE_TTL + 1);
  expect((await activate(flow.client, "expired-google", createInvite(h.ctx.db).code)).status).toBe(401);
  const fresh = await begin(); await callback(fresh);
  await h.request("/api/auth/google/cancel", {method: "POST", headers: {...json, cookie: fresh.client}});
  expect((await activate(fresh.client, "cancelled-google", createInvite(h.ctx.db).code)).status).toBe(401);
});
