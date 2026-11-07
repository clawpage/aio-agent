import { afterAll, beforeAll, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SHARE_CLI_PY } from "../../src/control/sandbox/seed.js";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { ShareStore, type SharePage } from "../../src/control/share.js";
import { ClawpageData } from "../../src/control/clawpages.js";

let h: TestHarness;
let store: ShareStore;
let gateway: MemberModelGateway;
let tool: string;
let toolRoot: string;
let ownerToken: string;
let session: { cookie: string; csrf: string };
let member: { cookie: string; csrf: string };
const b64 = (text: string) => Buffer.from(text).toString("base64");
const VISITOR = { id: "user_rui", name: "rui", email: "rui@example.com" };

beforeAll(async () => {
  h = await startHarness();
  const lookup = (sql: string, v: string) => (h.ctx.db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  store = new ShareStore({
    cfg: h.ctx.cfg, port: 0, data: new ClawpageData(h.ctx.cfg.dataDir),
    usernameOf: (id) => lookup("SELECT username AS v FROM owners WHERE id=?", id),
    userIdOf: (name) => lookup("SELECT id AS v FROM owners WHERE username=?", name),
  });
  h.ctx.share = store;
  h.ctx.tasks.setClawpages((id) => store.list(id));
  gateway = new MemberModelGateway({ ...h.ctx.cfg, memberModelPort: 0 }, h.ctx.log, store);
  await gateway.start();
  const owner = { ...h.ctx.cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") } as never as Parameters<ShareStore["provision"]>[0];
  store.provision(owner);
  ownerToken = owner.share!.token;
  await createMember(h.ctx.db, "cr", "member-password-123");
  toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pa-clawpage-offline-cli-"));
  tool = path.join(toolRoot, "aio-share");
  fs.mkdirSync(tool);
  fs.writeFileSync(path.join(tool, "aio-share.py"), SHARE_CLI_PY);
  fs.writeFileSync(path.join(tool, "config.json"), JSON.stringify({ token: ownerToken, endpoint: `http://127.0.0.1:${gateway.port}/share/owner_1` }));
  session = await login(h);
  const signin = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cr", password: "member-password-123" }) });
  const cookies = signin.headers.getSetCookie?.() ?? [];
  member = { cookie: cookies.map((c) => c.split(";")[0]).join("; "), csrf: decodeURIComponent(/pa_csrf=([^;]+)/.exec(cookies.join(";"))?.[1] ?? "") };
});
afterAll(async () => {
  fs.rmSync(toolRoot, { recursive: true, force: true });
  gateway?.close();
  await h?.shutdown();
});

/** The sandbox's CLI (no renderer here: a cover it tries to make fails with coverError). */
const cli = (...args: string[]) => promisify(execFile)("python3", [path.join(tool, "aio-share.py"), ...args]).then((r) => JSON.parse(r.stdout), (e) => JSON.parse(e.stdout));
const gw = (pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`http://127.0.0.1:${gateway.port}/share/owner_1/pages${pathname}`, {
    method: init.method ?? "GET", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const publish = async (name: string, html: string) => {
  const res = await gw(`/${name}`, { method: "POST", body: { title: html.replace(/<[^>]+>/g, ""), files: [{ path: "index.html", data: b64(html) }] } });
  expect(res.status).toBe(200);
  return (await res.json()) as SharePage;
};
/** The console, signed in as the owner (or as someone else). */
const console_ = (pathname: string, init: { method?: string; body?: unknown; as?: { cookie: string; csrf: string } | null; csrf?: string } = {}) => {
  const who = init.as === undefined ? session : init.as;
  return h.request(`/api/clawpages${pathname}`, {
    method: init.method,
    headers: { ...(who ? { cookie: who.cookie, "x-csrf-token": init.csrf ?? who.csrf } : {}), "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
};
const setOffline = (name: string, offline: boolean) => console_(`/${name}`, { method: "PATCH", body: { offline } });
const pub = (pathname: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
  h.request(pathname, { host: "workspace", method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
/** Every way someone other than the owner reaches a page, and what each answers. */
const reach = async (name: string, collaborator: string, visitor: string) => {
  const status = async (p: Promise<{ status: number }>) => (await p).status;
  return {
    page: await status(pub(`/u/owner/share/${name}/`)),
    file: await status(pub(`/u/owner/share/${name}/index.html`)),
    short: await status(pub(`/u/owner/share/${name}`)),
    data: await status(pub(`/u/owner/share/${name}/.data/votes`)),
    auth: await status(pub(`/u/owner/share/${name}/.auth`, { authorization: `Bearer ${visitor}` })),
    ai: await status(pub(`/u/owner/share/${name}/.ai`, { authorization: `Bearer ${visitor}` }, "POST", { input: "hi" })),
    decide: await status(pub(`/u/owner/share/${name}/.decide`, { authorization: `Bearer ${visitor}` }, "POST", { question: "q", options: { a: "A", b: "B" } })),
    api: await status(pub(`/u/owner/share/${name}/.api`, { authorization: `Bearer ${collaborator}` })),
    sso: await status(h.request(`/api/clawpage-sso/authorize?owner=owner&page=${name}&silent=1`)),
  };
};

it("takes a page offline for everyone but its owner, keeps everything, and puts it back online", async () => {
  await publish("poll", "<h1>Lunch poll</h1>");
  store.data!.createTable("owner_1", "poll", "votes", "read-public");
  store.data!.put("owner_1", "poll", "votes", "alice", { pick: "noodles", note: "x".repeat(400) }, { owner: true });
  const collaborator = store.data!.addCollaborator("owner_1", "poll", "Rui's agent").token;
  store.data!.grant("owner_1", "poll", VISITOR);
  const visitor = store.data!.visitorToken("owner_1", "poll", VISITOR);

  const live = await reach("poll", collaborator, visitor);
  expect(live).toMatchObject({ page: 200, file: 200, short: 301, data: 200, auth: 200, api: 200, sso: 303 });
  expect(live.ai).not.toBe(404);
  expect(live.decide).not.toBe(404);

  // Only the owner's session, with its CSRF token, changes it; another account does not even see the page.
  expect((await console_("/poll", { method: "PATCH", body: { offline: true }, as: null })).status).toBe(401);
  expect((await console_("/poll", { method: "PATCH", body: { offline: true }, csrf: "wrong" })).status).toBe(403);
  const theirs = await console_("/poll", { method: "PATCH", body: { offline: true }, as: member });
  expect(theirs.status).toBe(404);
  expect(await theirs.json()).toMatchObject({ error: "PAGE_NOT_FOUND" });
  expect((await console_("/poll", { method: "PATCH", body: { offline: "yes" } })).status).toBe(400);
  expect((await setOffline("nope", true)).status).toBe(404);
  expect(store.page("owner_1", "poll")!.offlineAt).toBeNull();

  const res = await setOffline("poll", true);
  expect(res.status).toBe(200);
  const offline = (await res.json()) as SharePage;
  expect(offline.offlineAt).toEqual(expect.any(Number));

  // Every public address answers as if the page did not exist; a collaborator is told why.
  expect(await reach("poll", collaborator, visitor)).toEqual({ page: 404, file: 404, short: 404, data: 404, auth: 404, ai: 404, decide: 404, api: 404, sso: 404 });
  expect(await (await pub("/u/owner/share/poll/.data/votes")).json()).toMatchObject({ error: "PAGE_NOT_FOUND" });
  expect(await (await pub("/u/owner/share/poll/.api", { authorization: `Bearer ${collaborator}` })).json()).toMatchObject({ error: "PAGE_OFFLINE" });
  // A wrong token still learns nothing.
  expect((await pub("/u/owner/share/poll/.api", { authorization: "Bearer cpc_wrong" })).status).toBe(401);

  // The owner still sees it all: the list, its data and history, and the sandbox too.
  const listed = (JSON.parse(await (await console_("")).text()) as { pages: SharePage[] }).pages;
  expect(listed.find((p) => p.name === "poll")).toMatchObject({ offlineAt: offline.offlineAt, tables: [{ name: "votes", records: 1 }], collaborators: 1 });
  expect((await console_("/poll/tables/votes")).status).toBe(200);
  expect(((await (await gw("")).json()) as { pages: SharePage[] }).pages.find((p) => p.name === "poll")!.offlineAt).toBe(offline.offlineAt);
  // Taking it offline again changes nothing.
  expect(((await (await setOffline("poll", true)).json()) as SharePage).offlineAt).toBe(offline.offlineAt);

  // Publishing, by the sandbox or a restore, keeps it offline: only the owner puts it back.
  const republished = await publish("poll", "<h1>Lunch poll v2</h1>");
  expect(republished.offlineAt).toBe(offline.offlineAt);
  const restored = await gw(`/poll/versions/${(await store.versions("owner_1", "poll"))![0]!.at}/restore`, { method: "POST", body: {} });
  expect(((await restored.json()) as SharePage).offlineAt).toBe(offline.offlineAt);
  expect((await pub("/u/owner/share/poll/")).status).toBe(404);
  // The executor is told.
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "改投票页", related: [], dependencies: [], resources: [] }) });
  const before = h.codex.startedTurns.length;
  await h.request("/api/tasks", { method: "POST", headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "改一下投票页", clientMessageId: "clawpage-offline-note" }) });
  await vi.waitFor(() => expect(h.codex.startedTurns.length).toBeGreaterThan(before));
  const line = h.codex.startedTurns.at(-1)!.text.split("\n").find((l) => l.startsWith("- poll "))!;
  expect(line).toMatch(/OFFLINE since .*only the user can put it back online/);

  // Online again: as it was, with its data, collaborators and sign-ins.
  const back = await setOffline("poll", false);
  expect(((await back.json()) as SharePage).offlineAt).toBeNull();
  const again = await reach("poll", collaborator, visitor);
  expect(again).toMatchObject({ page: 200, file: 200, data: 200, auth: 200, api: 200, sso: 303 });
  expect(await (await pub("/u/owner/share/poll/")).text()).toBe("<h1>Lunch poll</h1>");
  expect(store.data!.tables("owner_1", "poll")).toMatchObject([{ name: "votes", records: 1 }]);
});

it("the sandbox's CLI keeps an offline page offline: publishing says so, and no cover is rendered of its 404", async () => {
  const dir = path.join(toolRoot, "share", "notes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Notes</h1>");
  expect(await cli("publish", dir, "--no-cover")).toMatchObject({ ok: true, name: "notes", offlineAt: null });
  expect((await setOffline("notes", true)).status).toBe(200);

  const out = await cli("publish", dir);
  expect(out).toMatchObject({ ok: true, name: "notes", offlineAt: expect.any(Number), offline: expect.stringMatching(/stays offline.*only they can put it back online/) });
  expect(out).not.toHaveProperty("coverError");
  expect(out).not.toHaveProperty("check");
  expect(await cli("cover", "notes")).toMatchObject({ ok: false, error: expect.stringMatching(/offline/) });
  const missing = await cli("cover", "--missing");
  expect(missing.covers.map((c: { name: string }) => c.name)).not.toContain("notes");
});

it("deletes a page with all its data for good, and a folder of the deleted page does not bring it back by itself", async () => {
  const dir = path.join(toolRoot, "share", "trip");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Trip</h1>");
  expect(await cli("publish", dir, "--no-cover")).toMatchObject({ ok: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Trip v2</h1>");
  expect(await cli("publish", dir, "--no-cover")).toMatchObject({ ok: true });
  store.data!.createTable("owner_1", "trip", "plans", "public");
  store.data!.createTable("owner_1", "trip", "secret", "private");
  store.data!.put("owner_1", "trip", "plans", "day1", { where: "Tokyo" }, { owner: true });
  const collaborator = store.data!.addCollaborator("owner_1", "trip", "Mom's agent").token;
  store.data!.grant("owner_1", "trip", VISITOR);
  const visitor = store.data!.visitorToken("owner_1", "trip", VISITOR);
  expect(store.versions("owner_1", "trip")).toHaveLength(1);

  // Only the owner deletes it.
  expect((await console_("/trip", { method: "DELETE", as: null })).status).toBe(401);
  expect((await console_("/trip", { method: "DELETE", csrf: "wrong" })).status).toBe(403);
  expect((await console_("/trip", { method: "DELETE", as: member })).status).toBe(404);
  expect(store.exists("owner_1", "trip")).toBe(true);

  expect((await console_("/trip", { method: "DELETE" })).status).toBe(204);
  expect((await console_("/trip", { method: "DELETE" })).status).toBe(404);
  // Files, history, every table and record, collaborators and sign-ins: all gone.
  expect(store.exists("owner_1", "trip")).toBe(false);
  expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, "shares", "owner_1", "trip"))).toBe(false);
  expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, "shares", "owner_1", ".versions", "trip"))).toBe(false);
  expect(store.data!.tables("owner_1", "trip")).toEqual([]);
  expect(store.data!.collaborators("owner_1", "trip")).toEqual([]);
  expect(store.data!.granted("owner_1", "trip", VISITOR.id)).toBe(false);
  const db = (store.data as unknown as { db: { prepare(sql: string): { get(...v: string[]): { n: number } } } }).db;
  expect(db.prepare("SELECT count(*) AS n FROM cp_records WHERE user_id=? AND page=?").get("owner_1", "trip").n).toBe(0);
  expect(await reach("trip", collaborator, visitor)).toMatchObject({ page: 404, file: 404, data: 404, auth: 404, ai: 404, decide: 404, api: 401, sso: 404 });
  expect((JSON.parse(await (await console_("")).text()) as { pages: SharePage[] }).pages.map((p) => p.name)).not.toContain("trip");

  // The workspace folder still holds it, and still names the deleted version: publishing it is refused...
  const refused = await cli("publish", dir, "--no-cover");
  expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/deleted after this folder's version.*--force/) });
  expect(store.exists("owner_1", "trip")).toBe(false);
  // ...until the user wants it again: a new page, with none of the old data.
  expect(await cli("publish", dir, "--no-cover", "--force")).toMatchObject({ ok: true, name: "trip" });
  expect(store.data!.tables("owner_1", "trip")).toEqual([]);
  expect(store.versions("owner_1", "trip")).toEqual([]);
  // A brand-new folder (no version of its own) publishes as always.
  const fresh = path.join(toolRoot, "share", "fresh");
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, "index.html"), "<h1>Fresh</h1>");
  expect(await cli("publish", fresh, "--no-cover")).toMatchObject({ ok: true, name: "fresh" });
});
