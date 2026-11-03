import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { startHarness, type TestHarness } from "../helpers/harness.js";
import { createInvite, registerWithInvite } from "../../src/control/auth/invites.js";

let h: TestHarness;
const json = {"content-type": "application/json"};
const cookies = (res: {headers: {getSetCookie(): string[]}}) => res.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
// Stands in for Apple's signing key; Apple's key list is served from it.
const apple = generateKeyPairSync("rsa", {modulusLength: 2048});
const other = generateKeyPairSync("rsa", {modulusLength: 2048});
const jwk = {...apple.publicKey.export({format: "jwk"}), kid: "test-kid", alg: "RS256", use: "sig"};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const token = (claims: Record<string, unknown>, key = apple.privateKey, kid = "test-kid") => {
  const head = `${b64({alg: "RS256", kid})}.${b64(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
};
let subject = 0;
beforeAll(async () => {
  h = await startHarness({});
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === "https://appleid.apple.com/auth/keys") return new Response(JSON.stringify({keys: [jwk]}));
    return real(input, init);
  });
});
beforeEach(() => h.ctx.db.prepare("DELETE FROM login_failures").run());
afterAll(async () => { vi.restoreAllMocks(); await h?.shutdown(); });

async function begin() {
  const start = await h.request("/api/auth/apple/start", {method: "POST", headers: json, body: "{}"});
  expect(start.status).toBe(200);
  return {client: cookies(start), nonce: ((await start.json()) as {nonce: string}).nonce};
}
const claims = (nonce: string, sub = `apple-${++subject}`) => ({iss: "https://appleid.apple.com", aud: "ai.clawpage.agent", sub,
  exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), nonce, email: `${sub}@privaterelay.appleid.com`, email_verified: "true"});
const verify = (client: string, identityToken: string) => h.request("/api/auth/apple/verify", {method: "POST", headers: {...json, cookie: client}, body: JSON.stringify({identityToken})});
const activate = (client: string, inviteCode = "") => h.request("/api/auth/apple/register", {method: "POST", headers: {...json, cookie: client}, body: JSON.stringify({inviteCode})});

it("registers a new Apple ID with its verified email, then signs the same Apple ID straight back in", async () => {
  const flow = await begin();
  const before = h.ctx.db.prepare("SELECT count(*) AS n FROM owners").get();
  const first = await verify(flow.client, token(claims(flow.nonce, "stable-apple")));
  expect(await first.json()).toEqual({authenticated: false, pending: {email: "stable-apple@privaterelay.appleid.com"}});
  expect(cookies(first)).not.toContain("pa_session=");
  expect(h.ctx.db.prepare("SELECT count(*) AS n FROM owners").get()).toEqual(before);
  expect(await (await h.request("/api/auth/apple/pending", {headers: {cookie: flow.client}})).json()).toEqual({enabled: true, pending: {email: "stable-apple@privaterelay.appleid.com"}});
  const registered = await activate(flow.client, createInvite(h.ctx.db).code);
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({role: "member", email: "stable-apple@privaterelay.appleid.com"});
  expect(await (await h.request("/api/auth/session", {headers: {cookie: cookies(registered)}})).json()).toMatchObject({authenticated: true, role: "member"});
  expect((await activate(flow.client, createInvite(h.ctx.db).code)).status).toBe(401);

  const again = await begin();
  const back = await verify(again.client, token(claims(again.nonce, "stable-apple")));
  expect(await back.json()).toMatchObject({authenticated: true, role: "member"});
  expect(await (await h.request("/api/auth/session", {headers: {cookie: cookies(back)}})).json()).toMatchObject({authenticated: true, email: "stable-apple@privaterelay.appleid.com"});
});

it("refuses a wrong nonce, audience, issuer, signature, key, expiry or unverified email", async () => {
  const bad: Array<(nonce: string) => string> = [
    () => token(claims("other-nonce")),
    n => token({...claims(n), aud: "com.someone.else"}),
    n => token({...claims(n), iss: "https://accounts.google.com"}),
    n => token(claims(n), other.privateKey),
    n => token(claims(n), apple.privateKey, "unknown-kid"),
    n => token({...claims(n), exp: Math.floor(Date.now() / 1000) - 1}),
    n => token({...claims(n), email_verified: "false"}),
    n => token({...claims(n), email: undefined}),
    () => "not-a-token",
  ];
  for (const make of bad) {
    const flow = await begin();
    const res = await verify(flow.client, make(flow.nonce));
    expect(res.status).toBe(401);
    expect(cookies(res)).not.toContain("pa_session=");
    expect(await (await h.request("/api/auth/apple/pending", {headers: {cookie: flow.client}})).json()).toMatchObject({pending: null});
    h.ctx.db.prepare("DELETE FROM login_failures").run();
  }
});

it("binds a token to the flow that issued its nonce, once", async () => {
  const flow = await begin();
  const signed = token(claims(flow.nonce));
  expect((await verify("", signed)).status).toBe(401);
  const elsewhere = await begin();
  expect((await verify(elsewhere.client, signed)).status).toBe(401);
  expect((await verify(flow.client, signed)).status).toBe(200);
  expect((await verify(flow.client, signed)).status).toBe(401);
});

it("never links an Apple ID to an existing account by matching email", async () => {
  const existing = await registerWithInvite(h.ctx.db, {email: "taken-apple@privaterelay.appleid.com", password: "existing-password-123", code: ""});
  const flow = await begin();
  await verify(flow.client, token(claims(flow.nonce, "taken-apple")));
  const refused = await activate(flow.client, createInvite(h.ctx.db).code);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({error: "email_taken"});
  expect(h.ctx.db.prepare("SELECT 1 FROM apple_identities WHERE owner_id=?").get(existing.id)).toBeUndefined();
});

it("cancelling forgets the verified Apple ID", async () => {
  const flow = await begin();
  await verify(flow.client, token(claims(flow.nonce)));
  await h.request("/api/auth/apple/cancel", {method: "POST", headers: {...json, cookie: flow.client}});
  expect(await (await h.request("/api/auth/apple/pending", {headers: {cookie: flow.client}})).json()).toMatchObject({pending: null});
  expect((await activate(flow.client, createInvite(h.ctx.db).code)).status).toBe(401);
});

it("refuses cross-site starts", async () => {
  const res = await h.request("/api/auth/apple/start", {method: "POST", headers: {...json, origin: "https://evil.example"}, body: "{}"});
  expect(res.status).toBe(403);
});
