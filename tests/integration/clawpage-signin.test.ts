import { it, expect } from "vitest";
import path from "node:path";
import { startHarness, login, type TestHarness } from "../helpers/harness.js";
import { ShareStore, pageReturn, parseJsonAnswer } from "../../src/control/share.js";
import { ClawpageData, type Visitor } from "../../src/control/clawpages.js";
import type { AiRequest } from "../../src/control/clawpageAi.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");

async function setup() {
  const h = await startHarness();
  const db = h.ctx.db;
  const lookup = (sql: string, v: string) => (db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  const asked: Array<AiRequest & { userId: string }> = [];
  const store = new ShareStore({
    cfg: h.ctx.cfg, port: 0,
    usernameOf: (id) => lookup("SELECT username AS v FROM owners WHERE id=?", id),
    userIdOf: (name) => lookup("SELECT id AS v FROM owners WHERE username=?", name),
    data: new ClawpageData(path.join(h.dataDir, "clawpages")),
    ai: { answer: async (userId, req) => { asked.push({ userId, ...req }); return { text: '```json\n{"score": 4, "feedback": "ok"}\n```', model: "test-model" }; } },
  });
  h.ctx.share = store;
  store.publish("owner_1", "toefl", { title: "每日托福", files: [{ path: "index.html", data: b64("<p>hi</p>") }, { path: "prompts/grade.md", data: b64("Grade the answer from 0 to 5.") }] });
  return { h, store, data: store.data!, asked };
}

const ws = (h: TestHarness, p: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  h.request(`/u/owner/share/toefl/${p}`, {
    host: "workspace", method: init.method,
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

it("signs a visitor in through the console, once per page, and back with a token only that page receives", async () => {
  const { h, store, data } = await setup();
  try {
    const host = h.ctx.cfg.workspaceHost;
    // The page starts it on its own origin, which hands over to the console's.
    const start = await ws(h, ".auth/sign-in?silent=1&return=lesson.html%3Fd%3D1");
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe(`https://${h.ctx.cfg.primaryHost}/api/clawpage-sso/authorize?owner=owner&page=toefl&return=lesson.html%3Fd%3D1&silent=1`);

    // Not signed in to the console: a silent check only answers; otherwise the sign-in page.
    const silent = await h.request("/api/clawpage-sso/authorize?owner=owner&page=toefl&return=lesson.html%3Fd%3D1&silent=1");
    expect(silent.status).toBe(303);
    expect(silent.headers.get("location")).toBe(`https://${host}/u/owner/share/toefl/lesson.html?d=1#cpv=none`);
    const asking = await h.request("/api/clawpage-sso/authorize?owner=owner&page=toefl&return=");
    expect(asking.headers.get("location")).toBe("/clawpage-sso?owner=owner&page=toefl&return=");
    expect((await h.request("/api/clawpage-sso/authorize?owner=owner&page=nope")).status).toBe(404);
    const anonymous = await h.request("/api/clawpage-sso/page?owner=owner&page=toefl&return=");
    expect(await anonymous.json()).toMatchObject({ title: "每日托福", owner: "owner", account: null, cancelUrl: `https://${host}/u/owner/share/toefl/#cpv=denied` });

    // Signed in to the console, allowed once.
    const { cookie, csrf } = await login(h);
    const info = (await (await h.request("/api/clawpage-sso/page?owner=owner&page=toefl", { headers: { cookie } })).json()) as { account: Visitor };
    expect(info.account).toMatchObject({ id: "owner_1", name: "owner" });
    expect((await h.request("/api/clawpage-sso/authorize?owner=owner&page=toefl&silent=1", { headers: { cookie } })).headers.get("location")).toMatch(/#cpv=none$/);
    const grant = { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ owner: "owner", page: "toefl", return: "../../x" }) };
    expect((await h.request("/api/clawpage-sso/grant", { ...grant, headers: { ...grant.headers, "x-csrf-token": "wrong" } })).status).toBe(403);
    const granted = (await (await h.request("/api/clawpage-sso/grant", grant)).json()) as { url: string };
    // Anything but a path inside the page goes back to the page itself.
    expect(granted.url).toMatch(new RegExp(`^https://${host.replace(/\./g, "\\.")}/u/owner/share/toefl/#cpv=cpv1\\.`));
    const token = decodeURIComponent(granted.url.split("#cpv=")[1]!);
    // From now on a silent check signs the person in.
    const again = await h.request("/api/clawpage-sso/authorize?owner=owner&page=toefl&silent=1&return=a.html", { headers: { cookie } });
    expect(again.headers.get("location")).toMatch(/\/u\/owner\/share\/toefl\/a\.html#cpv=cpv1\./);

    expect(await (await ws(h, ".auth", { token })).json()).toEqual({ user: { id: "owner_1", name: "owner", email: null } });
    // A visitor token is no owner link, for this page or any other.
    expect(data.isOwnerToken(token, "owner_1", "toefl")).toBe(false);
    expect(data.visitorOf(token, "owner_1", "other")).toBeNull();
    expect(data.visitorOf(data.ownerToken("owner_1", "toefl"), "owner_1", "toefl")).toBeNull();
    expect((await ws(h, ".data", { method: "POST", token, body: { name: "secrets", permission: "private" } })).status).toBe(403);

    // Signing out of the page ends it: the token stops working and the next silent check answers "none".
    expect((await ws(h, ".auth", { method: "DELETE", token })).status).toBe(204);
    expect((await ws(h, ".auth", { token })).status).toBe(401);
    data.createTable("owner_1", "toefl", "notes", "public");
    expect(await (await ws(h, ".data/notes", { token })).json()).toMatchObject({ error: "SIGN_IN_EXPIRED" });
    expect((await h.request("/api/clawpage-sso/authorize?owner=owner&page=toefl&silent=1", { headers: { cookie } })).headers.get("location")).toMatch(/#cpv=none$/);
    // Deleting the page forgets who signed in to it.
    store.remove("owner_1", "toefl");
    expect(data.visitors("owner_1", "toefl")).toEqual([]);
  } finally {
    await h.shutdown();
  }
});

it("keeps per-user records apart and lets signed-in visitors change only what they wrote", async () => {
  const { h, data } = await setup();
  try {
    const a: Visitor = { id: "user_a1", name: "a", email: "a@example.com" };
    const b: Visitor = { id: "user_b2", name: "b", email: null };
    for (const v of [a, b]) data.grant("owner_1", "toefl", v);
    const ta = data.visitorToken("owner_1", "toefl", a), tb = data.visitorToken("owner_1", "toefl", b);
    data.createTable("owner_1", "toefl", "answers", "per-user");
    data.createTable("owner_1", "toefl", "board", "signed-in");
    data.createTable("owner_1", "toefl", "lessons", "read-public");

    // Each has their own "state"; nobody sees anyone else's, and anonymous visitors are asked to sign in.
    expect((await ws(h, ".data/answers/state", { method: "PUT", token: ta, body: { value: { day: 1 } } })).status).toBe(200);
    expect((await ws(h, ".data/answers/state", { method: "PUT", token: tb, body: { value: { day: 7 } } })).status).toBe(200);
    expect(await (await ws(h, ".data/answers/state", { token: ta })).json()).toMatchObject({ key: "state", value: { day: 1 }, mine: true });
    const listed = (await (await ws(h, ".data/answers", { token: tb })).json()) as { records: Array<{ key: string; value: unknown }> };
    expect(listed.records.map((r) => [r.key, r.value])).toEqual([["state", { day: 7 }]]);
    expect(await (await ws(h, ".data/answers")).json()).toMatchObject({ error: "SIGN_IN_REQUIRED" });
    expect((await ws(h, ".data/answers/state")).status).toBe(401);
    // A visitor cannot reach another's record through its stored key either.
    expect((await ws(h, ".data/answers/user_a1.state", { token: tb })).status).toBe(404);
    // The owner sees everyone's, under each person's id, and who they are.
    const owned = data.list("owner_1", "toefl", "answers", { owner: true });
    expect(owned.records.map((r) => [r.key, r.by?.email ?? r.by?.name])).toEqual([["user_a1.state", "a@example.com"], ["user_b2.state", "b"]]);
    data.patch("owner_1", "toefl", "answers", "user_a1.state", { feedback: "good" }, { owner: true });
    expect(data.get("owner_1", "toefl", "answers", "state", { owner: false, visitor: a }).value).toEqual({ day: 1, feedback: "good" });

    // A shared table for signed-in visitors: everyone reads, each changes only their own.
    const posted = (await (await ws(h, ".data/board", { method: "POST", token: ta, body: { value: { text: "hi" } } })).json()) as { key: string };
    const seen = (await (await ws(h, ".data/board", { token: tb })).json()) as { records: Array<{ key: string; mine: boolean; by?: unknown }> };
    expect(seen.records).toEqual([expect.objectContaining({ key: posted.key, mine: false })]);
    expect(seen.records[0]!.by).toBeUndefined();
    expect(await (await ws(h, `.data/board/${posted.key}`, { method: "PATCH", token: tb, body: { value: { text: "mine now" } } })).json()).toMatchObject({ error: "NOT_YOURS" });
    expect((await ws(h, `.data/board/${posted.key}`, { method: "DELETE", token: tb })).status).toBe(403);
    expect((await ws(h, `.data/board/${posted.key}`, { method: "PATCH", token: ta, body: { value: { text: "edited" } } })).status).toBe(200);
    expect((await ws(h, ".data/board")).status).toBe(401);
    expect((await ws(h, `.data/board/${posted.key}`, { method: "DELETE", token: ta })).status).toBe(204);

    // Signing in changes nothing for the other kinds of table.
    expect((await ws(h, ".data/lessons/x", { method: "PUT", token: ta, body: { value: 1 } })).status).toBe(403);
    expect((await ws(h, ".data/lessons")).status).toBe(200);
  } finally {
    await h.shutdown();
  }
});

it("answers with the signed-in visitor's own AI, framed by the page's prompt", async () => {
  const { h, data, asked } = await setup();
  try {
    const a: Visitor = { id: "user_a1", name: "a", email: "a@example.com" };
    data.grant("owner_1", "toefl", a);
    const token = data.visitorToken("owner_1", "toefl", a);
    expect(await (await ws(h, ".ai", { method: "POST", body: { input: "hi" } })).json()).toMatchObject({ error: "SIGN_IN_REQUIRED" });
    expect((await ws(h, ".ai", { method: "OPTIONS" })).status).toBe(204);

    const res = await ws(h, ".ai", { method: "POST", token, body: { input: "Q: ... A: ...", prompt: "grade", json: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: expect.any(String), json: { score: 4, feedback: "ok" }, model: "test-model" });
    expect(asked[0]).toMatchObject({ userId: "user_a1", effort: "low", messages: [{ role: "user", content: "Q: ... A: ..." }] });
    expect(asked[0]!.system).toContain("每日托福");
    expect(asked[0]!.system).toContain("Grade the answer from 0 to 5.");
    expect(asked[0]!.system).toContain("exactly one JSON object");

    expect(await (await ws(h, ".ai", { method: "POST", token, body: { input: "x", prompt: "missing" } })).json()).toMatchObject({ error: "PROMPT_NOT_FOUND" });
    expect(await (await ws(h, ".ai", { method: "POST", token, body: { input: "x", prompt: "../grade" } })).json()).toMatchObject({ error: "INVALID_PROMPT" });
    expect(await (await ws(h, ".ai", { method: "POST", token, body: { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] } })).json()).toMatchObject({ error: "INVALID_MESSAGES" });
    expect(await (await ws(h, ".ai", { method: "POST", token, body: { input: "x", effort: "max" } })).json()).toMatchObject({ error: "INVALID_EFFORT" });
    expect((await ws(h, ".ai", { method: "POST", token, body: { input: "x".repeat(60_001) } })).status).toBe(413);

    // A photo goes inline with the text, as a page sends it from a canvas; nothing is fetched from a URL.
    const photo = `data:image/jpeg;base64,${"A".repeat(900_000)}`;
    const pic = await ws(h, ".ai", { method: "POST", token, body: { prompt: "grade", json: true, messages: [{ role: "user", content: [{ type: "text", text: "热量？" }, { type: "image_url", image_url: { url: photo } }] }] } });
    expect(pic.status).toBe(200);
    expect(asked.at(-1)!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "热量？" }, { type: "image", mediaType: "image/jpeg", data: "A".repeat(900_000) }] }]);
    const bad = (content: unknown, role = "user") => ws(h, ".ai", { method: "POST", token, body: { messages: [{ role, content }] } }).then(async (r) => [r.status, ((await r.json()) as { error: string }).error]);
    expect(await bad([{ type: "image_url", image_url: { url: "https://example.com/a.jpg" } }])).toEqual([400, "INVALID_IMAGE"]);
    expect(await bad([{ type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } }])).toEqual([400, "INVALID_IMAGE"]);
    expect(await bad([{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(2_000_000)}` } }])).toEqual([413, "IMAGE_TOO_LARGE"]);
    expect(await bad(Array.from({ length: 5 }, () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } })))).toEqual([413, "TOO_MANY_IMAGES"]);
    expect(await bad([{ type: "text", text: "  " }])).toEqual([400, "INVALID_MESSAGES"]);
    expect(await bad([{ type: "audio", data: "x" }])).toEqual([400, "INVALID_MESSAGES"]);

    // Ten a minute per person and page (the photo above was the second).
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await ws(h, ".ai", { method: "POST", token, body: { input: "again" } })).status);
    expect(statuses.filter((s) => s === 429).length).toBe(1);
  } finally {
    await h.shutdown();
  }
});

it("returns only to paths inside the page, and reads JSON out of an answer", () => {
  expect(pageReturn("")).toBe("");
  expect(pageReturn("lesson.html?d=1")).toBe("lesson.html?d=1");
  expect(pageReturn("?view=review")).toBe("?view=review");
  expect(pageReturn("sub/")).toBe("sub/");
  expect(pageReturn("%E8%AF%BE.html")).toBe("%E8%AF%BE.html");
  for (const bad of ["/u/other/share/x/", "../x", "//evil.example", "https://evil.example", "a#b", ".hidden", "a\\b", "%2e%2e/x", "%2E%2e/x", ".%2e/x", "a%2fb", "%2e%2e%2fx", "%zz", 7]) expect(pageReturn(bad)).toBe("");
  expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonAnswer('Here:\n```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
  expect(parseJsonAnswer("no json")).toBeNull();
});
