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
import { memberConfig } from "../../src/control/tenants.js";

/** The account's history is kept small here, so a few 20 KB pages reach it. */
const ACCOUNT_BYTES = 64 * 1024;

let h: TestHarness;
let store: ShareStore;
let gateway: MemberModelGateway;
let tool: string;
let toolRoot: string;
let ownerToken: string;
let memberId: string;
let memberToken: string;
let session: { cookie: string; csrf: string };
const b64 = (text: string) => Buffer.from(text).toString("base64");
/** Two different pictures, by their signatures (the cover check goes by those). */
const JPEG_A = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("cover-a")]);
const JPEG_B = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("cover-b")]);

beforeAll(async () => {
  h = await startHarness();
  const lookup = (sql: string, v: string) => (h.ctx.db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  store = new ShareStore({
    cfg: h.ctx.cfg, port: 0, data: new ClawpageData(h.ctx.cfg.dataDir), history: { accountBytes: ACCOUNT_BYTES },
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
  const member = await createMember(h.ctx.db, "cr", "member-password-123");
  memberId = member.id;
  const memberCfg = memberConfig(h.ctx.cfg, member.id, 18092);
  store.provision(memberCfg);
  memberToken = memberCfg.share!.token;
  toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pa-clawpage-versions-cli-"));
  tool = path.join(toolRoot, "aio-share");
  fs.mkdirSync(tool);
  fs.writeFileSync(path.join(tool, "aio-share.py"), SHARE_CLI_PY);
  fs.writeFileSync(path.join(tool, "config.json"), JSON.stringify({ token: ownerToken, endpoint: `http://127.0.0.1:${gateway.port}/share/owner_1` }));
  session = await login(h);
});
afterAll(async () => {
  fs.rmSync(toolRoot, { recursive: true, force: true });
  gateway?.close();
  await h?.shutdown();
});

const cli = (...args: string[]) => promisify(execFile)("python3", [path.join(tool, "aio-share.py"), ...args]).then((r) => JSON.parse(r.stdout), (e) => JSON.parse(e.stdout));
/** The account's sandbox, through the member gateway. */
const gw = (pathname: string, init: { method?: string; body?: unknown; token?: string; userId?: string } = {}) =>
  fetch(`http://127.0.0.1:${gateway.port}/share/${init.userId ?? "owner_1"}/pages${pathname}`, {
    method: init.method ?? "GET", headers: { authorization: `Bearer ${init.token ?? ownerToken}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const publish = async (name: string, html: string, extra: Record<string, unknown> = {}, opts: { token?: string; userId?: string } = {}) => {
  const res = await gw(`/${name}`, { method: "POST", body: { title: html.replace(/<[^>]+>/g, ""), files: [{ path: "index.html", data: b64(html) }], ...extra }, ...opts });
  expect(res.status).toBe(200);
  return (await res.json()) as SharePage;
};
const setCover = async (name: string, data: Buffer) => {
  const res = await gw(`/${name}/cover`, { method: "POST", body: { data: data.toString("base64") } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { cover: number }).cover;
};
/** The console, signed in as the owner. */
const console_ = (pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  h.request(`/api/clawpages${pathname}`, {
    method: init.method,
    headers: init.headers ?? { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const pub = (pathname: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
  h.request(pathname, { host: "workspace", method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
type Version = { at: number; title: string; files: number; bytes: number; updatedBy: string | null; restoredFrom: number | null };
const versionsOf = async (name: string) => {
  const res = await console_(`/${name}/versions`);
  expect(res.status).toBe(200);
  return (JSON.parse(await res.text()) as { versions: Version[] }).versions;
};
const records = (name: string) => store.data!.tables("owner_1", name).map((t) => [t.name, t.records]);

it("keeps every replaced version, and restores one as a new version: files and their cover, never the data", async () => {
  const v1 = await publish("site", "<h1>v1</h1>");
  store.data!.createTable("owner_1", "site", "votes", "public");
  store.data!.put("owner_1", "site", "votes", "alice", { pick: "a" }, { owner: true });
  store.data!.put("owner_1", "site", "votes", "bob", { pick: "b" }, { owner: true });
  await setCover("site", JPEG_A);
  const v2 = await publish("site", "<h1>v2</h1><p>more</p>");
  const v3 = await publish("site", "<h1>v3</h1>");
  await setCover("site", JPEG_B);

  // Newest first, each as it was published.
  expect(await versionsOf("site")).toEqual([
    { at: v2.updatedAt, title: "v2more", files: 1, bytes: Buffer.byteLength("<h1>v2</h1><p>more</p>"), updatedBy: null, restoredFrom: null },
    { at: v1.updatedAt, title: "v1", files: 1, bytes: Buffer.byteLength("<h1>v1</h1>"), updatedBy: null, restoredFrom: null },
  ]);

  // A collaborator's version says who published it once it is replaced.
  const collaborator = store.data!.addCollaborator("owner_1", "site", "Rui's agent");
  const auth = { authorization: `Bearer ${collaborator.token}` };
  const v4res = await pub("/u/owner/share/site/.api", auth, "POST", { baseUpdatedAt: v3.updatedAt, files: [{ path: "index.html", data: b64("<h1>v4 broken</h1>") }] });
  expect(v4res.status).toBe(200);
  const v4 = JSON.parse(await v4res.text()) as SharePage;
  expect((await versionsOf("site"))[0]).toMatchObject({ at: v3.updatedAt, updatedBy: null });
  const v5 = await publish("site", "<h1>v5</h1>", { baseUpdatedAt: v4.updatedAt });
  expect((await versionsOf("site"))[0]).toMatchObject({ at: v4.updatedAt, updatedBy: "Rui's agent" });

  const before = store.page("owner_1", "site")!;
  expect(before.updatedAt).toBe(v5.updatedAt);
  const seen = await pub("/u/owner/share/site/");
  expect(await seen.text()).toBe("<h1>v5</h1>");
  const etag = seen.headers.get("etag")!, lastModified = seen.headers.get("last-modified")!;
  const tables = records("site");

  // Without CSRF the console refuses.
  expect((await console_(`/site/versions/${v1.updatedAt}/restore`, { method: "POST", body: {}, headers: { cookie: session.cookie, "content-type": "application/json" } })).status).toBe(403);
  const res = await console_(`/site/versions/${v1.updatedAt}/restore`, { method: "POST", body: {} });
  expect(res.status).toBe(200);
  const restored = JSON.parse(await res.text()) as SharePage;
  expect(restored).toMatchObject({ name: "site", title: "v1", restoredFrom: v1.updatedAt, updatedBy: null });
  expect(restored.updatedAt).toBeGreaterThan(before.updatedAt);
  expect(store.page("owner_1", "site")).toMatchObject({ restoredFrom: v1.updatedAt, updatedAt: restored.updatedAt });

  // Visitors get it at once: a later Last-Modified, and their copy's ETag no longer matches.
  const after = await pub("/u/owner/share/site/");
  expect(after.status).toBe(200);
  expect(await after.text()).toBe("<h1>v1</h1>");
  expect(Date.parse(after.headers.get("last-modified")!)).toBeGreaterThan(Date.parse(lastModified));
  expect((await pub("/u/owner/share/site/", { "if-none-match": etag })).status).toBe(200);
  expect((await pub("/u/owner/share/site/", { "if-modified-since": lastModified })).status).toBe(200);

  // The cover v1 had, as a new one.
  expect(store.cover("owner_1", "site")!.data.equals(JPEG_A)).toBe(true);
  expect(restored.cover).toBeGreaterThan(before.cover!);

  // The replaced version is now the newest earlier one, and v1 stays in the history (a restore copies).
  const history = await versionsOf("site");
  expect(history[0]).toMatchObject({ at: v5.updatedAt, title: "v5", updatedBy: null });
  expect(history.map((v) => v.at)).toContain(v1.updatedAt);
  // The data is as it was.
  expect(records("site")).toEqual(tables);
  expect(store.data!.get("owner_1", "site", "votes", "alice", { owner: true })).toMatchObject({ value: { pick: "a" } });

  // Whoever holds the replaced version must pull first: a collaborator, and the owner naming it.
  expect((await pub("/u/owner/share/site/.api", auth, "POST", { baseUpdatedAt: v5.updatedAt, files: [{ path: "index.html", data: b64("<h1>stale</h1>") }] })).status).toBe(409);
  const stale = await gw("/site", { method: "POST", body: { baseUpdatedAt: v5.updatedAt, files: [{ path: "index.html", data: b64("<h1>stale</h1>") }] } });
  expect(stale.status).toBe(409);
  expect(await (await pub("/u/owner/share/site/")).text()).toBe("<h1>v1</h1>");

  // The restore can itself be undone.
  const undone = await console_(`/site/versions/${v5.updatedAt}/restore`, { method: "POST", body: {} });
  expect(undone.status).toBe(200);
  expect(await (await pub("/u/owner/share/site/")).text()).toBe("<h1>v5</h1>");
  expect((await versionsOf("site"))[0]).toMatchObject({ at: restored.updatedAt, restoredFrom: v1.updatedAt });
});

it("a version restored without a cover has none: the current version's cover does not come along", async () => {
  const p1 = await publish("plain", "<h1>p1</h1>");
  await publish("plain", "<h1>p2</h1>");
  const cover = await setCover("plain", JPEG_B);
  await publish("plain", "<h1>p3</h1>");
  expect(store.page("owner_1", "plain")!.cover).toBe(cover);
  const res = await gw(`/plain/versions/${p1.updatedAt}/restore`, { method: "POST", body: {} });
  expect(res.status).toBe(200);
  expect(((await res.json()) as SharePage).cover).toBeNull();
  expect(store.cover("owner_1", "plain")).toBeNull();
});

it("keeps the 5 most recent versions of a page, and the account's history within its size, dropping the oldest first", async () => {
  const published: SharePage[] = [];
  for (let i = 1; i <= 8; i++) published.push(await publish("many", `<h1>m${i}</h1>`));
  expect((await versionsOf("many")).map((v) => v.at)).toEqual(published.slice(2, 7).map((p) => p.updatedAt).reverse());

  // Another account (whose history is its own): two pages of 20 KB each, published in turn.
  const big = (n: string) => `<h1>${n}</h1>${"x".repeat(20_000)}`;
  const as = { token: memberToken, userId: memberId };
  const a1 = await publish("alpha", big("a1"), {}, as);
  const b1 = await publish("beta", big("b1"), {}, as);
  const a2 = await publish("alpha", big("a2"), {}, as);
  const b2 = await publish("beta", big("b2"), {}, as);
  await publish("alpha", big("a3"), {}, as);
  // Three versions fit in 64 KB.
  expect(store.versions(memberId, "alpha")!.map((v) => v.at)).toEqual([a2.updatedAt, a1.updatedAt]);
  await publish("beta", big("b3"), {}, as);
  // The fourth pushed the account over: its oldest version (alpha's first) went, wherever it was.
  expect(store.versions(memberId, "alpha")!.map((v) => v.at)).toEqual([a2.updatedAt]);
  expect(store.versions(memberId, "beta")!.map((v) => v.at)).toEqual([b2.updatedAt, b1.updatedAt]);
  // The owner's history is not touched by another account's.
  expect((await versionsOf("many"))).toHaveLength(5);
});

it("refuses versions that are not there, and the history never shows on a public path or in the list", async () => {
  const s1 = await publish("guarded", "<h1>g1</h1>");
  await publish("guarded", "<h1>g2</h1>");
  for (const at of ["123", "abc", "..%2F..%2Fx", "9999999999999"]) {
    const viaConsole = await console_(`/guarded/versions/${at}/restore`, { method: "POST", body: {} });
    expect(viaConsole.status, `console ${at}`).toBe(404);
    expect(JSON.parse(await viaConsole.text()).error).toBe("VERSION_NOT_FOUND");
    const viaGateway = await gw(`/guarded/versions/${at}/restore`, { method: "POST", body: {} });
    expect(viaGateway.status, `gateway ${at}`).toBe(404);
    expect(((await viaGateway.json()) as { code: string }).code).toBe("VERSION_NOT_FOUND");
  }
  expect(await (await pub("/u/owner/share/guarded/")).text()).toBe("<h1>g2</h1>");
  const missing = await console_(`/nowhere/versions/${s1.updatedAt}/restore`, { method: "POST", body: {} });
  expect(missing.status).toBe(404);
  expect(JSON.parse(await missing.text()).error).toBe("PAGE_NOT_FOUND");
  const missingList = await console_("/nowhere/versions");
  expect(missingList.status).toBe(404);
  expect(JSON.parse(await missingList.text()).error).toBe("PAGE_NOT_FOUND");
  expect(((await (await gw(`/nowhere/versions/${s1.updatedAt}/restore`, { method: "POST", body: {} })).json()) as { code: string }).code).toBe("PAGE_NOT_FOUND");
  expect((await gw("/nowhere/versions")).status).toBe(404);
  // Only GET the list and POST a restore.
  expect((await gw("/guarded/versions", { method: "DELETE" })).status).toBe(405);
  expect((await gw(`/guarded/versions/${s1.updatedAt}`, { method: "POST", body: {} })).status).toBe(405);
  expect((await gw(`/guarded/versions/${s1.updatedAt}/undo`, { method: "POST", body: {} })).status).toBe(405);

  // The history is on disk, but not on any public path, nor in the list.
  const kept = path.join(h.ctx.cfg.dataDir, "shares", "owner_1", ".versions", "guarded", String(s1.updatedAt), "index.html");
  expect(fs.readFileSync(kept, "utf8")).toBe("<h1>g1</h1>");
  expect((await pub(`/u/owner/share/.versions/guarded/${s1.updatedAt}/index.html`)).status).toBe(404);
  expect((await pub("/u/owner/share/guarded/.versions/")).status).toBe(404);
  expect((await pub(`/u/owner/share/guarded/.versions/guarded/${s1.updatedAt}/index.html`)).status).toBe(404);
  expect((await pub("/u/owner/share/guarded/%2E%2E/.versions/guarded/")).status).toBe(404);
  const listed = JSON.parse(await (await console_("")).text()).pages as Array<{ name: string }>;
  expect(listed.map((p) => p.name)).toContain("guarded");
  expect(listed.some((p) => p.name.startsWith("."))).toBe(false);
  expect(((await (await gw("")).json()) as { pages: Array<{ name: string }> }).pages.some((p) => p.name.startsWith("."))).toBe(false);
});

it("deleting a page deletes its history; the same name starts from none", async () => {
  await publish("gone", "<h1>1</h1>");
  await publish("gone", "<h1>2</h1>");
  const dir = path.join(h.ctx.cfg.dataDir, "shares", "owner_1", ".versions", "gone");
  expect(fs.readdirSync(dir)).toHaveLength(1);
  expect((await console_("/gone", { method: "DELETE" })).status).toBe(204);
  expect(fs.existsSync(dir)).toBe(false);
  await publish("gone", "<h1>again</h1>");
  expect(await versionsOf("gone")).toEqual([]);
});

it("only the account's own sandbox and console reach the history; never a collaborator, another account or a visitor", async () => {
  const k1 = await publish("closed", "<h1>k1</h1>");
  await publish("closed", "<h1>k2</h1>");
  // The gateway: its runtime's token only, for its own account only.
  expect((await gw("/closed/versions", { token: "f".repeat(64) })).status).toBe(403);
  expect((await gw("/closed/versions", { token: memberToken })).status).toBe(403);
  expect((await gw(`/closed/versions/${k1.updatedAt}/restore`, { method: "POST", body: {}, token: memberToken })).status).toBe(403);
  const listed = await gw("/closed/versions");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ name: "closed", versions: [{ at: k1.updatedAt }] });

  // The collaborators' API has no history.
  const collaborator = store.data!.addCollaborator("owner_1", "closed", "Rui's agent");
  const auth = { authorization: `Bearer ${collaborator.token}` };
  expect((await pub("/u/owner/share/closed/.api/versions", auth)).status).toBe(404);
  expect((await pub(`/u/owner/share/closed/.api/versions/${k1.updatedAt}/restore`, auth, "POST", {})).status).toBe(404);
  expect((await pub(`/u/owner/share/closed/.data/versions`)).status).not.toBe(200);

  // The console: signed in, and only the account's own pages.
  expect((await h.request("/api/clawpages/closed/versions")).status).toBe(401);
  expect((await h.request(`/api/clawpages/closed/versions/${k1.updatedAt}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  const signin = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cr", password: "member-password-123" }) });
  expect(signin.status).toBe(200);
  const cookies = (signin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!);
  const memberHeaders = { cookie: cookies.join("; "), "x-csrf-token": decodeURIComponent(cookies.find((c) => c.startsWith("pa_csrf="))!.slice(8)), "content-type": "application/json" };
  expect((await h.request("/api/clawpages/closed/versions", { headers: memberHeaders })).status).toBe(404);
  expect((await h.request(`/api/clawpages/closed/versions/${k1.updatedAt}/restore`, { method: "POST", headers: memberHeaders, body: "{}" })).status).toBe(404);
  expect(await (await pub("/u/owner/share/closed/")).text()).toBe("<h1>k2</h1>");
});

it("the sandbox CLI lists versions and restores one, leaving the folder's version as it was, so publishing it conflicts", async () => {
  const dir = path.join(toolRoot, "cli-page");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>c1</h1>");
  const c1 = await cli("publish", dir, "--no-cover");
  expect(c1).toMatchObject({ ok: true, name: "cli-page" });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>c2</h1>");
  const c2 = await cli("publish", dir, "--no-cover");
  expect(c2).toMatchObject({ ok: true });

  const listed = await cli("versions", "cli-page");
  expect(listed).toMatchObject({ name: "cli-page", versions: [{ at: c1.updatedAt, title: "cli-page", files: 1, updatedBy: null, restoredFrom: null }] });
  expect(listed.versions[0].published).toBe(new Date(c1.updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z"));
  expect(listed.versions[0].published).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  const state = fs.readFileSync(path.join(dir, ".clawpage.json"), "utf8");
  expect(await cli("restore", "cli-page", "abc")).toMatchObject({ ok: false, error: expect.stringContaining("Not a version") });
  const restored = await cli("restore", "cli-page", String(c1.updatedAt));
  expect(restored).toMatchObject({ ok: true, name: "cli-page", restoredFrom: c1.updatedAt, updatedBy: null, next: expect.stringContaining("pull cli-page --force") });
  expect(await (await pub("/u/owner/share/cli-page/")).text()).toBe("<h1>c1</h1>");
  expect(fs.readFileSync(path.join(dir, ".clawpage.json"), "utf8")).toBe(state);

  // The old folder would replace the restore: refused as a version conflict.
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>c3 from the old folder</h1>");
  expect(await cli("publish", dir, "--no-cover")).toMatchObject({ ok: false, error: expect.stringContaining("changed since") });
  expect(await (await pub("/u/owner/share/cli-page/")).text()).toBe("<h1>c1</h1>");

  // A collaborator's folder cannot list or restore the history.
  const remote = path.join(toolRoot, "remote-page");
  fs.mkdirSync(remote);
  fs.writeFileSync(path.join(remote, ".clawpage.json"), JSON.stringify({ name: "cli-page", updatedAt: c2.updatedAt, api: `${h.baseUrl}/u/owner/share/cli-page/.api`, token: "cpc_x", owner: "owner" }));
  expect(await cli("--remote", remote, "restore", "cli-page", String(c1.updatedAt))).toMatchObject({ ok: false, error: expect.stringContaining("Only the page's owner") });
  expect(await cli("--remote", remote, "versions", "cli-page")).toMatchObject({ ok: false, error: expect.stringContaining("Only the page's owner") });
});

it("tells the executor a page was restored, and from which version", async () => {
  const r1 = await publish("habit", "<h1>r1</h1>");
  await publish("habit", "<h1>r2</h1>");
  expect((await console_(`/habit/versions/${r1.updatedAt}/restore`, { method: "POST", body: {} })).status).toBe(200);
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "改打卡页", related: [], dependencies: [], resources: [] }) });
  const before = h.codex.startedTurns.length;
  await h.request("/api/tasks", { method: "POST", headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "把打卡页改回去", clientMessageId: "clawpage-restored-note" }) });
  await vi.waitFor(() => expect(h.codex.startedTurns.length).toBeGreaterThan(before));
  const prompt = h.codex.startedTurns.at(-1)!.text;
  const line = prompt.split("\n").find((l) => l.startsWith("- habit "))!;
  expect(line).toContain("restored from the version of");
  expect(line).toMatch(/- habit "r1" https:\/\/\S+\/u\/owner\/share\/habit\/ \(published [^)]+\); no data tables/);
});
