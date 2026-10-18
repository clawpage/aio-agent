import { afterAll, beforeAll, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import vm from "node:vm";
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SHARE_CLI_PY } from "../../src/control/sandbox/seed.js";
import { CLAWPAGE_SDK_JS } from "../../src/control/sandbox/clawpageSdk.js";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { ShareStore } from "../../src/control/share.js";
import { ClawpageData, RATE_LIMITS } from "../../src/control/clawpages.js";
import { memberConfig } from "../../src/control/tenants.js";

let h: TestHarness;
let store: ShareStore;
let gateway: MemberModelGateway;
let tool: string;
let toolRoot: string;
let owner: { runtimeUserId: string; dataDir: string; share?: { token: string; endpoint: string } };
let memberId: string;
let memberToken: string;
const b64 = (text: string) => Buffer.from(text).toString("base64");
/** A JPEG's first bytes: enough for the cover check, which goes by signature. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("cover")]);
/** Stands in for aio-render.py's Page: records the address it was sent to and "captures" a JPEG. */
const FAKE_RENDERER = `import base64, time
class Page:
    def __init__(self, width, scale):
        self.size = (width, scale)
        with open(LOG_PATH, "a") as f:
            f.write("start\\n")
    def metrics(self, height):
        pass
    def call(self, method, params=None, session=False, timeout=60):
        if method == "Page.navigate":
            self.url = params["url"]
            with open(LOG_PATH, "a") as f:
                f.write(params["url"] + "\\n")
            if "hang" in self.url:
                time.sleep(30)
        if method == "Page.captureScreenshot":
            assert params["format"] == "jpeg" and params["clip"]["width"] == 480 and params["clip"]["height"] == 640
            with open(LOG_PATH, "a") as f:
                f.write("q%d\\n" % params["quality"])
            # A picture-heavy page is too large at high quality.
            if "heavy" in self.url and params["quality"] > 62:
                return {"data": base64.b64encode(b"\\xff\\xd8\\xff" + b"x" * (1500 * 1024)).decode()}
            return {"data": "${JPEG.toString("base64")}"}
        return {}
    def evaluate(self, expression):
        return True
    def close(self):
        pass
`;

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
  owner = { ...h.ctx.cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
  store.provision(owner as never);
  const member = await createMember(h.ctx.db, "cr", "member-password-123");
  memberId = member.id;
  const memberCfg = memberConfig(h.ctx.cfg, member.id, 18091);
  store.provision(memberCfg);
  memberToken = memberCfg.share!.token;
  // The sandbox's tools directory: the CLI beside a stand-in for the graphic renderer (no Chromium here).
  toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pa-clawpages-cli-"));
  tool = path.join(toolRoot, "aio-share");
  fs.mkdirSync(tool);
  fs.mkdirSync(path.join(toolRoot, "aio-graphic"));
  fs.writeFileSync(path.join(toolRoot, "aio-graphic", "aio-render.py"), FAKE_RENDERER.replaceAll("LOG_PATH", JSON.stringify(path.join(toolRoot, "rendered.log"))));
  fs.writeFileSync(path.join(tool, "aio-share.py"), SHARE_CLI_PY);
  fs.writeFileSync(path.join(tool, "clawpage-sdk.js"), CLAWPAGE_SDK_JS);
  fs.writeFileSync(path.join(tool, "config.json"), JSON.stringify({ ...owner.share, endpoint: `http://127.0.0.1:${gateway.port}/share/owner_1` }));
});
afterAll(async () => {
  fs.rmSync(toolRoot, { recursive: true, force: true });
  gateway?.close();
  await h?.shutdown();
});

const cliWith = (env: Record<string, string>, ...args: string[]) => promisify(execFile)("python3", [path.join(tool, "aio-share.py"), ...args], { env: { ...process.env, ...env } }).then((r) => JSON.parse(r.stdout), (e) => JSON.parse(e.stdout));
const cli = (...args: string[]) => promisify(execFile)("python3", [path.join(tool, "aio-share.py"), ...args]).then((r) => JSON.parse(r.stdout), (e) => JSON.parse(e.stdout));
const pub = (pathname: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  h.request(pathname, { host: "workspace", method: init.method, headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const publish = (name: string, html = "<h1>app</h1>") => fetch(`http://127.0.0.1:${gateway.port}/share/owner_1/pages/${name}`, {
  method: "POST", headers: { authorization: `Bearer ${owner.share!.token}`, "content-type": "application/json" },
  body: JSON.stringify({ title: name, files: [{ path: "index.html", data: b64(html) }] }),
});

it("the sandbox CLI builds a mini app: SDK, tables, data, list, pull, and delete with its data", async () => {
  const dir = path.join(tool, "lunch-poll");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "index.html"), '<script src="clawpage-sdk.js"></script><h1>午饭投票</h1>');
  expect(await cli("sdk", dir)).toMatchObject({ ok: true, script: '<script src="clawpage-sdk.js"></script>' });
  // Publishing refreshes the page's copy of the SDK.
  fs.writeFileSync(path.join(dir, "clawpage-sdk.js"), "stale");
  expect(await cli("publish", dir, "--title", "午饭投票")).toMatchObject({ ok: true, name: "lunch-poll", files: 2 });
  expect(await (await pub("/u/owner/share/lunch-poll/clawpage-sdk.js")).text()).toBe(CLAWPAGE_SDK_JS);

  expect(await cli("data", "create", "lunch-poll", "votes", "--permission", "public")).toMatchObject({ name: "votes", permission: "public", records: 0 });
  expect(await cli("data", "create", "lunch-poll", "votes")).toMatchObject({ ok: false, error: "Table votes already exists" });
  expect(await cli("data", "put", "lunch-poll", "votes", "alice", '{"choice":"noodles"}')).toMatchObject({ key: "alice", value: { choice: "noodles" } });
  expect(await cli("data", "patch", "lunch-poll", "votes", "alice", '{"note":"no spice"}')).toMatchObject({ value: { choice: "noodles", note: "no spice" } });
  expect((await cli("data", "add", "lunch-poll", "votes", '{"choice":"rice"}')).key).toMatch(/^rec_/);
  expect(await cli("data", "incr", "lunch-poll", "tally", "totals", "noodles", "--by", "2")).toMatchObject({ value: { noodles: 2 } });
  expect((await cli("data", "list", "lunch-poll", "votes", "--all")).count).toBe(2);
  expect(await cli("data", "get", "lunch-poll", "votes", "nobody")).toMatchObject({ ok: false });
  const backup = path.join(tool, "votes.json");
  expect(await cli("data", "export", "lunch-poll", "votes", "--out", backup)).toMatchObject({ ok: true, records: 2 });
  expect(await cli("data", "delete", "lunch-poll", "votes", "alice")).toEqual({ ok: true, deleted: "alice" });
  expect(await cli("data", "import", "lunch-poll", "votes", backup)).toEqual({ imported: 2 });
  expect(await cli("data", "permission", "lunch-poll", "tally", "read-public")).toMatchObject({ permission: "read-public" });
  const listed = (await cli("list")).pages.find((p: { name: string }) => p.name === "lunch-poll");
  expect(listed.tables.map((t: { name: string; records: number }) => [t.name, t.records])).toEqual([["tally", 1], ["votes", 2]]);

  // Pull brings the published files back, and never over work in progress unless asked.
  expect(await cli("pull", "lunch-poll", "--dir", dir)).toMatchObject({ ok: false });
  const pulled = path.join(tool, "pulled");
  expect(await cli("pull", "lunch-poll", "--dir", pulled)).toMatchObject({ ok: true, files: 2 });
  expect(fs.readFileSync(path.join(pulled, "index.html"), "utf8")).toContain("午饭投票");

  // A runtime's token reaches only its own account's pages.
  const foreign = await fetch(`http://127.0.0.1:${gateway.port}/share/owner_1/pages/lunch-poll/data/votes`, { headers: { authorization: `Bearer ${memberToken}` } });
  expect(foreign.status).toBe(403);

  expect(await cli("delete", "lunch-poll")).toEqual({ ok: true, deleted: "lunch-poll" });
  expect(store.data!.tables("owner_1", "lunch-poll")).toEqual([]);
  expect((await pub("/u/owner/share/lunch-poll/.data/votes")).status).toBe(404);
});

it("serves a page's data to visitors by permission, with open CORS and no cookies, and to its owner link fully", async () => {
  expect((await publish("guestbook")).status).toBe(200);
  const data = store.data!;
  data.createTable("owner_1", "guestbook", "entries", "public");
  data.createTable("owner_1", "guestbook", "stats", "read-public");
  data.createTable("owner_1", "guestbook", "secrets", "private");
  data.put("owner_1", "guestbook", "secrets", "s", "hidden", { owner: true });
  data.put("owner_1", "guestbook", "stats", "count", { n: 1 }, { owner: true });

  const preflight = await pub("/u/owner/share/guestbook/.data/entries", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

  const posted = await pub("/u/owner/share/guestbook/.data/entries", { method: "POST", headers: { origin: "null" }, body: { value: { text: "hello" } } });
  expect(posted.status).toBe(201);
  expect(posted.headers.get("access-control-allow-origin")).toBe("*");
  expect(posted.headers.get("set-cookie")).toBeNull();
  const listed = await pub("/u/owner/share/guestbook/.data/entries");
  expect((JSON.parse(await listed.text()) as { records: Array<{ value: unknown }> }).records.map((r) => r.value)).toEqual([{ text: "hello" }]);
  expect((await pub("/u/owner/share/guestbook/.data/stats/count")).status).toBe(200);
  expect((await pub("/u/owner/share/guestbook/.data/stats/count", { method: "PUT", body: { value: 2 } })).status).toBe(403);
  expect((await pub("/u/owner/share/guestbook/.data/secrets/s")).status).toBe(404);
  // Visitors see the tables they may use, and cannot manage them.
  expect(JSON.parse(await (await pub("/u/owner/share/guestbook/.data")).text()).tables.map((t: { name: string }) => t.name)).toEqual(["entries", "stats"]);
  expect((await pub("/u/owner/share/guestbook/.data/entries", { method: "PATCH", body: { permission: "private" } })).status).toBe(403);
  expect((await pub("/u/owner/share/guestbook/.data/entries", { method: "DELETE" })).status).toBe(403);

  // The owner link's token opens everything, for this page only.
  const auth = { authorization: `Bearer ${data.ownerToken("owner_1", "guestbook")}` };
  expect(JSON.parse(await (await pub("/u/owner/share/guestbook/.data/secrets/s", { headers: auth })).text()).value).toBe("hidden");
  expect((await pub("/u/owner/share/guestbook/.data/stats/count", { method: "PUT", headers: auth, body: { value: 2 } })).status).toBe(200);
  expect((await pub("/u/owner/share/guestbook/.data/secrets/s", { headers: { authorization: `Bearer ${data.ownerToken("owner_1", "other")}` } })).status).toBe(404);

  // Nowhere but the workspace origin, only for pages that exist, and a page's data path is not a file.
  expect((await h.request("/u/owner/share/guestbook/.data/entries", { host: "primary" })).status).not.toBe(200);
  expect((await pub("/u/owner/share/missing/.data/entries")).status).toBe(404);
  expect((await pub("/u/nobody/share/guestbook/.data/entries")).status).toBe(404);
  expect((await pub("/u/owner/share/guestbook/.data/entries", { method: "POST", body: { value: "x".repeat(200_000) } })).status).toBe(413);
});

it("limits anonymous writes per address, never the owner link", async () => {
  expect((await publish("counter")).status).toBe(200);
  store.data!.createTable("owner_1", "counter", "hits", "public");
  let status = 0;
  for (let i = 0; i <= RATE_LIMITS.writes; i++) status = (await pub("/u/owner/share/counter/.data/hits/total/incr", { method: "POST", body: { field: "n" } })).status;
  expect(status).toBe(429);
  const owned = await pub("/u/owner/share/counter/.data/hits/total/incr", { method: "POST", headers: { authorization: `Bearer ${store.data!.ownerToken("owner_1", "counter")}` }, body: { field: "n" } });
  expect(owned.status).toBe(200);
  expect(JSON.parse(await owned.text()).value).toEqual({ n: RATE_LIMITS.writes + 1 });
});

it("the SDK reads and writes a page's data from the page, takes the owner token out of the address, and previews in memory", async () => {
  expect((await publish("todo")).status).toBe(200);
  store.data!.createTable("owner_1", "todo", "items", "read-public");
  const replaced: string[] = [];
  const sandbox = (href: string) => {
    const url = new URL(href);
    const window: Record<string, unknown> = {
      location: { protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search, hash: url.hash },
      history: { state: null, replaceState: (_s: unknown, _t: string, next: string) => replaced.push(next) },
      console: { info: () => undefined },
      fetch: async (target: string, init: { method: string; headers: Record<string, string>; body?: string; credentials?: string }) => {
        expect(init.credentials).toBe("omit");
        const u = new URL(target);
        expect(u.host).toBe(url.host);
        const res = await h.request(u.pathname + u.search, { host: "workspace", method: init.method, headers: init.headers, body: init.body });
        return { status: res.status, ok: res.status >= 200 && res.status < 300, text: () => res.text() };
      },
    };
    window.window = window;
    vm.runInNewContext(CLAWPAGE_SDK_JS, window);
    return window as { Clawpage: new () => { mode: string; owner: boolean; page: string; table(n: string): Record<string, (...a: unknown[]) => Promise<unknown>>; tables(): Promise<unknown> } };
  };
  const base = `https://${h.ctx.cfg.workspaceHost}/u/owner/share/todo/`;

  const visitor = new (sandbox(base).Clawpage)();
  expect([visitor.mode, visitor.owner, visitor.page]).toEqual(["live", false, "todo"]);
  await expect(visitor.table("items").put("a", { done: false })).rejects.toMatchObject({ name: "ClawpageError", status: 403, code: "PERMISSION_DENIED" });
  expect(await visitor.table("items").get("missing")).toBeNull();

  const token = store.data!.ownerToken("owner_1", "todo");
  const me = new (sandbox(`${base}?v=1#cp=${encodeURIComponent(token)}`).Clawpage)();
  expect(me.owner).toBe(true);
  expect(replaced).toEqual(["/u/owner/share/todo/?v=1"]);
  const items = me.table("items");
  await items.put("a", { done: false, text: "milk" });
  await items.patch("a", { done: true });
  await items.post({ text: "eggs" });
  await items.incr("stats", "n", 3);
  const all = await items.listAll() as Array<{ key: string; value: unknown }>;
  expect(all.map((r) => r.value)).toEqual([{ done: true, text: "milk" }, expect.objectContaining({ text: "eggs" }), { n: 3 }]);
  expect(await items.delete("a")).toBe(true);
  expect(await items.delete("a")).toBe(false);
  // The visitor reads what the owner wrote.
  expect((await visitor.table("items").get("stats") as { value: unknown }).value).toEqual({ n: 3 });

  // Opened from a file, nothing leaves the page.
  const preview = sandbox("file:///home/gem/workspace/share/todo/index.html");
  const fetchSpy = vi.spyOn(preview as unknown as { fetch: () => unknown }, "fetch");
  const local = new preview.Clawpage();
  expect(local.mode).toBe("preview");
  const t = local.table("items");
  await t.put("x", { a: { b: 1 } });
  await t.patch("x", { a: { c: 2 } });
  await t.incr("x", "n");
  expect((await t.get("x") as { value: unknown }).value).toEqual({ a: { b: 1, c: 2 }, n: 1 });
  expect(((await t.list({ limit: 10 })) as { records: unknown[] }).records).toHaveLength(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("the console lists the account's clawpages with their data, opens them as the owner, moderates and deletes, and keeps accounts apart", async () => {
  expect((await publish("signup")).status).toBe(200);
  store.data!.createTable("owner_1", "signup", "people", "public");
  store.data!.put("owner_1", "signup", "people", "p1", { name: "Ann" }, { owner: true });
  store.data!.put("owner_1", "signup", "people", "p2", { name: "Bob" }, { owner: true });
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const api = (p: string, method = "GET", body?: unknown) => h.request(`/api/clawpages${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  expect((await h.request("/api/clawpages")).status).toBe(401);
  const pages = JSON.parse(await (await api("")).text()).pages as Array<{ name: string; tables: Array<{ name: string; records: number }> }>;
  expect(pages.find((p) => p.name === "signup")?.tables).toEqual([expect.objectContaining({ name: "people", permission: "public", records: 2 })]);

  const open = JSON.parse(await (await api("/signup/open", "POST", {})).text()) as { url: string };
  const [pageUrl, fragment] = open.url.split("#cp=");
  expect(pageUrl).toBe(`https://${h.ctx.cfg.workspaceHost}/u/owner/share/signup/`);
  expect(store.data!.isOwnerToken(decodeURIComponent(fragment!), "owner_1", "signup")).toBe(true);
  expect((await api("/missing/open", "POST", {})).status).toBe(404);

  const records = JSON.parse(await (await api("/signup/tables/people")).text()) as { records: Array<{ key: string }> };
  expect(records.records.map((r) => r.key)).toEqual(["p1", "p2"]);
  const exported = await api("/signup/tables/people/export");
  expect(exported.headers.get("content-disposition")).toContain("signup-people.json");
  expect(JSON.parse(await exported.text()).records).toEqual({ p1: { name: "Ann" }, p2: { name: "Bob" } });
  expect(JSON.parse(await (await api("/signup/tables/people", "PATCH", { permission: "read-public" })).text()).permission).toBe("read-public");
  expect((await api("/signup/tables/people/records/p1", "DELETE")).status).toBe(204);
  expect((await api("/signup/tables/people/records/p1", "DELETE")).status).toBe(404);
  // Unsafe calls need the CSRF token.
  expect((await h.request("/api/clawpages/signup", { method: "DELETE", headers: { cookie } })).status).toBe(403);

  // A member sees and manages only its own clawpages.
  await fetch(`http://127.0.0.1:${gateway.port}/share/${memberId}/pages/mine`, {
    method: "POST", headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "mine", files: [{ path: "index.html", data: b64("<p>mine</p>") }] }),
  });
  const signin = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cr", password: "member-password-123" }) });
  expect(signin.status).toBe(200);
  const cookies = (signin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!);
  const memberHeaders = { cookie: cookies.join("; "), "x-csrf-token": decodeURIComponent(cookies.find((c) => c.startsWith("pa_csrf="))!.slice(8)), "content-type": "application/json" };
  const theirs = await h.request("/api/clawpages", { headers: memberHeaders });
  expect(theirs.status).toBe(200);
  expect(JSON.parse(await theirs.text()).pages.map((p: { name: string }) => p.name)).toEqual(["mine"]);
  expect((await h.request("/api/clawpages/signup/tables/people", { headers: memberHeaders })).status).toBe(404);
  expect((await h.request("/api/clawpages/signup", { method: "DELETE", headers: memberHeaders })).status).toBe(404);
  expect((await h.request("/api/clawpages/signup/open", { method: "POST", headers: memberHeaders, body: "{}" })).status).toBe(404);

  expect((await api("/signup", "DELETE")).status).toBe(204);
  expect(JSON.parse(await (await api("")).text()).pages.map((p: { name: string }) => p.name)).not.toContain("signup");
  expect(store.data!.tables("owner_1", "signup")).toEqual([]);
});

it("tells the executor which clawpages the account has and what their data holds", async () => {
  expect((await publish("habit")).status).toBe(200);
  store.data!.put("owner_1", "habit", "checkins", "d1", { done: true }, { owner: true });
  const { cookie, csrf } = await login(h);
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "改打卡页", related: [], dependencies: [], resources: [] }) });
  const before = h.codex.startedTurns.length;
  await h.request("/api/tasks", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "给打卡页加个连续天数", clientMessageId: "clawpage-note" }) });
  await vi.waitFor(() => expect(h.codex.startedTurns.length).toBeGreaterThan(before));
  const prompt = h.codex.startedTurns.at(-1)!.text;
  expect(prompt).toContain("The user's clawpages");
  expect(prompt).toMatch(/- habit "habit" https:\/\/\S+\/u\/owner\/share\/habit\/ \(published [^)]+\); tables: checkins \(private, 1 records, last change /);
});

const hasChromium = fs.existsSync(chromium.executablePath());
it.skipIf(!hasChromium)("in a real browser, a published page in its CSP sandbox reads and writes its data, as a visitor and from an owner link", async () => {
  const html = `<!doctype html><meta charset="utf-8"><script src="clawpage-sdk.js"></script><pre id="out">pending</pre><script>
(async () => {
  const cp = new Clawpage(), log = ["owner:" + cp.owner, "hash:" + location.hash, "origin:" + self.origin];
  try {
    const notes = cp.table("notes");
    if (cp.owner) await notes.put("n1", { text: "from owner" });
    else { try { await notes.put("x", 1); log.push("put:ok"); } catch (e) { log.push("put:" + e.code); } }
    await cp.table("guest").post({ text: "hi" });
    const n1 = await notes.get("n1");
    log.push("n1:" + (n1 ? n1.value.text : "null"), "guest:" + (await cp.table("guest").list()).records.length);
  } catch (e) { log.push("error:" + e.code + ":" + e.message); }
  document.getElementById("out").textContent = log.join("|");
})();
</script>`;
  const res = await fetch(`http://127.0.0.1:${gateway.port}/share/owner_1/pages/browser-app`, {
    method: "POST", headers: { authorization: `Bearer ${owner.share!.token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "browser", files: [{ path: "index.html", data: b64(html) }, { path: "clawpage-sdk.js", data: b64(CLAWPAGE_SDK_JS) }] }),
  });
  expect(res.status).toBe(200);
  store.data!.createTable("owner_1", "browser-app", "notes", "read-public");
  store.data!.createTable("owner_1", "browser-app", "guest", "public");

  const host = h.ctx.cfg.workspaceHost;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    // The workspace origin is served by the harness, as the tunnel would: every request, the page's own fetches included.
    await context.route(`https://${host}/**`, async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const headers = await req.allHeaders();
      const r = await h.request(u.pathname + u.search, { host: "workspace", method: req.method(), body: req.postData() ?? undefined,
        headers: Object.fromEntries(["content-type", "authorization", "origin", "access-control-request-method", "access-control-request-headers"].filter((k) => headers[k]).map((k) => [k, headers[k]!])) });
      const out = Object.fromEntries(["content-type", "content-security-policy", "cache-control", "location", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age"]
        .flatMap((k) => { const v = r.headers.get(k); return v ? [[k, v]] : []; }));
      await route.fulfill({ status: r.status, headers: out, body: await r.text() });
    });
    const page = await context.newPage();
    const out = page.locator("#out");

    await page.goto(`https://${host}/u/owner/share/browser-app/`);
    await expect.poll(() => out.textContent(), { timeout: 15_000 }).toBe("owner:false|hash:|origin:null|put:PERMISSION_DENIED|n1:null|guest:1");

    // The console opens an owner link in a new tab.
    const token = store.data!.ownerToken("owner_1", "browser-app");
    const ownerTab = await context.newPage();
    await ownerTab.goto(`https://${host}/u/owner/share/browser-app/#cp=${encodeURIComponent(token)}`);
    await expect.poll(() => ownerTab.locator("#out").textContent(), { timeout: 15_000 }).toBe("owner:true|hash:|origin:null|n1:from owner|guest:2");
    // The token is gone from the address bar: a link copied now is a visitor's.
    expect(ownerTab.url()).toBe(`https://${host}/u/owner/share/browser-app/`);
    // A visitor reloading now reads what the owner wrote.
    await page.reload();
    await expect.poll(() => out.textContent(), { timeout: 15_000 }).toBe("owner:false|hash:|origin:null|put:PERMISSION_DENIED|n1:from owner|guest:3");
  } finally {
    await browser.close();
  }
});

it("publishing renders a cover of the live page; the console serves it to its own account only, and a sandbox start fills in missing ones", async () => {
  const dir = path.join(tool, "photo-wall");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>照片墙</h1>");
  const rendered = () => fs.existsSync(path.join(toolRoot, "rendered.log")) ? fs.readFileSync(path.join(toolRoot, "rendered.log"), "utf8").trim().split("\n") : [];
  const before = rendered().length;

  const published = await cli("publish", dir, "--title", "照片墙");
  expect(published, JSON.stringify(published)).toMatchObject({ ok: true, name: "photo-wall", cover: expect.any(Number) });
  // The live page as a visitor sees it, not the file in the workspace.
  expect(rendered().slice(before)).toEqual(["start", `https://${h.ctx.cfg.workspaceHost}/u/owner/share/photo-wall/`, "q78"]);
  expect(store.list("owner_1").find((p) => p.name === "photo-wall")?.cover).toBe(published.cover);

  // The console: the picture itself, checked by its bytes, kept long only under its version.
  const { cookie } = await login(h);
  const cover = await h.request(`/api/clawpages/photo-wall/cover?v=${published.cover}`, { headers: { cookie } });
  expect(cover.status).toBe(200);
  expect(cover.headers.get("content-type")).toBe("image/jpeg");
  expect(cover.headers.get("x-content-type-options")).toBe("nosniff");
  expect(cover.headers.get("cache-control")).toContain("immutable");
  expect((await h.request("/api/clawpages/photo-wall/cover", { headers: { cookie } })).headers.get("cache-control")).toBe("private, no-cache");
  expect((await h.request("/api/clawpages/photo-wall/cover")).status).toBe(401);
  // Never on the page's public path.
  expect((await pub("/u/owner/share/photo-wall/.cover")).status).toBe(404);

  // Only pictures, only for pages that exist, only through the account's own channel.
  const upload = (name: string, data: Buffer, token = owner.share!.token, userId = "owner_1") => fetch(`http://127.0.0.1:${gateway.port}/share/${userId}/pages/${name}/cover`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ data: data.toString("base64") }) });
  expect((await upload("photo-wall", Buffer.from("<svg onload=alert(1)>"))).status).toBe(400);
  expect((await upload("photo-wall", Buffer.concat([JPEG, Buffer.alloc(1600 * 1024)]))).status).toBe(413);
  expect((await upload("nowhere", JPEG)).status).toBe(404);
  expect((await upload("photo-wall", JPEG, memberToken)).status).toBe(403);

  // Republishing keeps the cover until a new one is rendered; --no-cover skips rendering.
  const again = await cli("publish", dir, "--no-cover");
  expect(again.cover).toBe(published.cover);
  expect(again.coverError).toBeUndefined();

  // A page without a cover (published before covers, or rendering failed) gets one from `cover --missing`.
  fs.rmSync(path.join(h.ctx.cfg.dataDir, "shares", "owner_1", "photo-wall", ".cover"));
  expect(store.list("owner_1").find((p) => p.name === "photo-wall")?.cover).toBeNull();
  const other = path.join(tool, "menu");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "index.html"), "<h1>菜单</h1>");
  expect(await cli("publish", other, "--no-cover")).toMatchObject({ ok: true });
  // While another run holds the lock, a second one does nothing.
  const holder = execFile("python3", ["-c", "import fcntl,time; f=open('/tmp/aio-share-cover.lock','w'); fcntl.flock(f, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(3)"]);
  await new Promise((r) => holder.stdout!.once("data", r));
  expect(await cli("cover", "--missing")).toMatchObject({ covers: [], skipped: expect.any(String) });
  await new Promise((r) => holder.once("exit", r));
  const mark = rendered().length;
  const missing = await cli("cover", "--missing");
  expect(missing.covers.map((c: { name: string }) => c.name).sort()).toEqual(expect.arrayContaining(["menu", "photo-wall"]));
  expect(missing.covers.every((c: { cover?: number }) => typeof c.cover === "number")).toBe(true);
  // One browser for all of them.
  expect(rendered().slice(mark).filter((l) => l === "start")).toHaveLength(1);
  expect((await cli("cover", "--missing")).covers).toEqual([]);

  // Another account's console never gets it.
  const signin = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cr", password: "member-password-123" }) });
  const memberCookie = (signin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!).join("; ");
  expect((await h.request("/api/clawpages/photo-wall/cover", { headers: { cookie: memberCookie } })).status).toBe(404);

  // A cover goes with its page.
  expect(await cli("delete", "photo-wall")).toEqual({ ok: true, deleted: "photo-wall" });
  expect((await h.request("/api/clawpages/photo-wall/cover", { headers: { cookie } })).status).toBe(404);
});

it("a cover too large is captured again at lower quality, a page that hangs is given up, and an oversized upload is answered", async () => {
  const log = () => fs.readFileSync(path.join(toolRoot, "rendered.log"), "utf8").trim().split("\n");
  const page = (name: string) => { const dir = path.join(tool, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "index.html"), `<h1>${name}</h1>`); return dir; };

  const mark = log().length;
  const heavy = await cli("publish", page("heavy-photos"));
  expect(heavy, JSON.stringify(heavy)).toMatchObject({ ok: true, cover: expect.any(Number) });
  expect(log().slice(mark).filter((l) => l.startsWith("q"))).toEqual(["q78", "q62"]);

  const started = Date.now();
  const hung = await cliWith({ AIO_SHARE_COVER_SECONDS: "2" }, "publish", page("hang-page"));
  expect(hung).toMatchObject({ ok: true, name: "hang-page", cover: null, coverError: expect.stringContaining("longer than 2 s") });
  expect(Date.now() - started).toBeLessThan(20_000);

  const oversized = await fetch(`http://127.0.0.1:${gateway.port}/share/owner_1/pages/heavy-photos/cover`, {
    method: "POST", headers: { authorization: `Bearer ${owner.share!.token}`, "content-type": "application/json" },
    body: JSON.stringify({ data: Buffer.alloc(2 * 1024 * 1024).toString("base64") }) });
  expect(oversized.status).toBe(413);
});
