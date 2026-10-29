import { it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WIDGET_CLI_PY } from "../../src/control/sandbox/seed.js";
import { startHarness, login, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { ShareStore } from "../../src/control/share.js";
import { WidgetStore } from "../../src/control/widgets.js";
import { memberConfig } from "../../src/control/tenants.js";
import { webFetchSpec } from "../../src/control/http/api.js";
import { WEB_FETCH_SCRIPT } from "../../src/control/documents/service.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");

async function setup(h: TestHarness) {
  const db = h.ctx.db;
  const lookup = (sql: string, v: string) => (db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  const store = new ShareStore({
    cfg: h.ctx.cfg, port: 0,
    usernameOf: (id) => lookup("SELECT username AS v FROM owners WHERE id=?", id),
    userIdOf: (name) => lookup("SELECT id AS v FROM owners WHERE username=?", name),
  });
  store.widgets = new WidgetStore(h.ctx.cfg);
  h.ctx.share = store;
  const gateway = new MemberModelGateway({ ...h.ctx.cfg, memberModelPort: 0 }, h.ctx.log, store);
  await gateway.start();
  const owner = { ...h.ctx.cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
  store.provision(owner);
  return { store, gateway, owner };
}

async function workspaceCookie(h: TestHarness): Promise<{ cookie: string; csrf: string; workspace: string }> {
  const { cookie, csrf } = await login(h);
  const res = await h.request("/api/workspace/ticket", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: "{}" });
  const { ticket } = (await res.json()) as { ticket: string };
  const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
  const workspace = boot.headers.getSetCookie().filter((c) => c.startsWith("pa_ws_session=")).map((c) => c.split(";")[0]).join("; ");
  return { cookie, csrf, workspace };
}

const widget = [
  { path: "index.html", data: b64("<!doctype html><html><head><title>b</title></head><body><div id=x></div><script>aio.onData(d=>x.textContent=d.n)</script></body></html>") },
  { path: "app.js", data: b64("console.log(1)") },
];

it("publishes widgets over the share channel and frames them for the signed-in account only, sandboxed, with the runtime", async () => {
  const h = await startHarness();
  const { store, gateway, owner } = await setup(h);
  try {
    const member = await createMember(h.ctx.db, "cr", "member-password-123");
    const memberCfg = memberConfig(h.ctx.cfg, member.id, 18090);
    gateway.provision(memberCfg);
    const api = (userId: string, rest: string, token: string, method = "GET", body?: unknown) =>
      fetch(`http://127.0.0.1:${gateway.port}/share/${userId}/widgets${rest}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const publish = (body: Record<string, unknown>, name = "board", token = owner.share!.token, userId = "owner_1") => api(userId, `/${name}`, token, "POST", body);

    // Only the runtime's own token, for its own widgets; malformed widgets never land.
    expect((await api("owner_1", "", "f".repeat(64))).status).toBe(403);
    expect((await publish({ description: "d", files: widget }, "board", memberCfg.share!.token)).status).toBe(403);
    expect((await publish({ description: "d", files: [{ path: "a.html", data: b64("x") }] })).status).toBe(400);
    expect((await publish({ description: "d", files: [...widget, { path: "../x", data: b64("x") }] })).status).toBe(400);
    expect((await publish({ files: widget })).status).toBe(400); // no description
    expect((await publish({ description: "d", files: widget }, "Bad_Name")).status).toBe(400);

    const created = await publish({ title: "看板", description: "A board. data: {n: text}", example: { n: "</script><b>" }, files: widget });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ name: "board", title: "看板", files: 2 });
    expect((await api("owner_1", "", owner.share!.token).then((r) => r.json())).widgets.map((w: { name: string }) => w.name)).toEqual(["board"]);
    // Republishing keeps what it does not say.
    expect((await publish({ files: widget })).status).toBe(200);
    expect(store.widgets!.get("owner_1", "board")).toMatchObject({ title: "看板", description: "A board. data: {n: text}", example: { n: "</script><b>" } });

    // No workspace session: nothing.
    expect((await h.request("/widgets/board/", { host: "workspace" })).status).toBe(401);
    const { cookie, csrf, workspace } = await workspaceCookie(h);
    const page = await h.request("/widgets/board/", { host: "workspace", headers: { cookie: workspace } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^sandbox allow-scripts/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain(`frame-ancestors ${h.ctx.cfg.primaryOrigins.join(" ")}`);
    // The runtime comes first in <head>, the example cannot close the script.
    expect(html.indexOf("window.aio")).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf("window.aio")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain('{"n":"\\u003c/script>\\u003cb>"}');
    expect((await h.request("/widgets/board/app.js", { host: "workspace", headers: { cookie: workspace } })).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await h.request("/widgets/board", { host: "workspace", headers: { cookie: workspace } })).status).toBe(301);
    expect((await h.request("/widgets/nope/", { host: "workspace", headers: { cookie: workspace } })).status).toBe(404);
    // Another account's address is not this session's (in a multi-account deployment the session is dropped: 401).
    expect((await h.request(`/u/cr/widgets/board/`, { host: "workspace", headers: { cookie: workspace } })).status).not.toBe(200);
    // Not on the console's own origin.
    expect((await h.request("/widgets/board/", { headers: { cookie } })).status).not.toBe(200);

    // The console lists them.
    const listed = await h.request("/api/widgets", { headers: { cookie } });
    expect(((await listed.json()) as { widgets: Array<{ name: string }> }).widgets.map((w: { name: string }) => w.name)).toEqual(["board"]);

    // AI answers come from this account, framed for the widget.
    const answer = vi.fn(async () => ({ text: '```json\n{"ok":1}\n```', model: "m" }));
    store.ai = { answer };
    const ask = (body: unknown) => h.request("/api/widgets/ai", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await ask({ name: "nope", input: "hi" })).status).toBe(404);
    expect((await ask({ name: "board" })).status).toBe(400);
    const ok = await ask({ name: "board", input: "hi", system: "Be brief.", json: true });
    expect(await ok.json()).toEqual({ text: '```json\n{"ok":1}\n```', json: { ok: 1 }, model: "m" });
    const [userId, req] = answer.mock.calls[0] as unknown as [string, { system: string; messages: unknown[]; effort: string }];
    expect(userId).toBe("owner_1");
    expect(req.system).toContain('"看板"');
    expect(req.system).toContain("Be brief.");
    expect(req).toMatchObject({ messages: [{ role: "user", content: "hi" }], effort: "low" });
    // Without CSRF the console's own origin refuses.
    expect((await h.request("/api/widgets/ai", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "board", input: "hi" }) })).status).toBe(403);

    // Web requests run in the sandbox, checked first.
    const webFetch = vi.spyOn(h.ctx.documents, "webFetch").mockResolvedValue({ status: 200, url: "https://example.com/", contentType: "text/plain", truncated: false, text: "hello" });
    const get = (body: unknown) => h.request("/api/widgets/fetch", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await get({ name: "board", url: "file:///etc/passwd" })).status).toBe(400);
    expect(await (await get({ name: "board", url: "https://example.com/", headers: { Cookie: "a=b", Accept: "text/plain" } })).json()).toMatchObject({ status: 200, text: "hello" });
    expect(webFetch).toHaveBeenCalledWith({ url: "https://example.com/", method: "GET", headers: { Accept: "text/plain" }, body: null });

    // Deleting from the sandbox takes it away.
    expect((await api("owner_1", "/board", owner.share!.token, "DELETE")).status).toBe(204);
    expect((await h.request("/widgets/board/", { host: "workspace", headers: { cookie: workspace } })).status).toBe(404);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("checks a widget's web request", () => {
  expect(webFetchSpec({ url: "ftp://x" })).toBeTypeOf("string");
  expect(webFetchSpec({ url: "https://x/", method: "CONNECT" })).toBeTypeOf("string");
  expect(webFetchSpec({ url: "https://x/", headers: { "X-A": "1\r\nHost: y" } })).toBeTypeOf("string");
  expect(webFetchSpec({ url: "https://x/", body: { a: 1 } })).toBeTypeOf("string");
  expect(webFetchSpec({ url: "https://x/", method: "post", headers: { Host: "y", "Content-Type": "application/json" }, body: "{}" }))
    .toEqual({ url: "https://x/", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(webFetchSpec({ url: "https://x/", method: "GET", body: "x" })).toMatchObject({ body: null });
});

it("the sandbox's fetch refuses private addresses, also after a redirect", async () => {
  const run = (spec: unknown) => new Promise<{ code: number; out: string }>((resolve) => {
    const child = execFile("python3", ["-c", WEB_FETCH_SCRIPT], (err, stdout) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout }));
    child.stdin!.end(JSON.stringify(spec));
  });
  for (const url of ["http://127.0.0.1:1/", "http://localhost/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/"]) {
    const r = await run({ url, method: "GET", headers: {}, body: null });
    expect(r.code, url).toBe(4);
    expect(JSON.parse(r.out)).toEqual({ error: "BLOCKED" });
  }
});

it("the sandbox aio-widget CLI publishes, lists, pulls and deletes through the gateway", async () => {
  const h = await startHarness();
  const { gateway, owner } = await setup(h);
  const tool = fs.mkdtempSync(path.join(os.tmpdir(), "pa-widget-cli-"));
  try {
    fs.writeFileSync(path.join(tool, "aio-widget.py"), WIDGET_CLI_PY);
    fs.writeFileSync(path.join(tool, "config.json"), JSON.stringify({ ...owner.share, endpoint: `http://127.0.0.1:${gateway.port}/share/owner_1` }));
    const dir = path.join(tool, "src", "trip-board");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>行程</h1>");
    fs.writeFileSync(path.join(dir, ".preview.html"), "x");
    const env = { ...process.env, AIO_WIDGET_ROOT: path.join(tool, "pulled") };
    const run = (...args: string[]) => promisify(execFile)("python3", [path.join(tool, "aio-widget.py"), ...args], { env }).then((r) => JSON.parse(r.stdout), (e: { stdout: string }) => JSON.parse(e.stdout));

    expect(await run("publish", dir)).toMatchObject({ ok: false }); // no widget.json
    fs.writeFileSync(path.join(dir, "widget.json"), JSON.stringify({ title: "行程看板", description: "Trips. data: {trips: []}", example: { trips: [] } }));
    const published = await run("publish", dir);
    expect(published).toMatchObject({ ok: true, name: "trip-board", title: "行程看板", files: 1 });
    expect(published.embed).toMatch(/^```widget\n\{"component": "trip-board"/);
    expect((await run("list")).widgets.map((w: { name: string }) => w.name)).toEqual(["trip-board"]);
    expect(await run("pull", "trip-board")).toMatchObject({ ok: true, files: 1 });
    expect(fs.readFileSync(path.join(tool, "pulled", "trip-board", "index.html"), "utf8")).toBe("<h1>行程</h1>");
    expect(JSON.parse(fs.readFileSync(path.join(tool, "pulled", "trip-board", "widget.json"), "utf8"))).toMatchObject({ title: "行程看板", example: { trips: [] } });
    expect(await run("pull", "trip-board")).toMatchObject({ ok: false });
    expect(await run("delete", "trip-board")).toEqual({ ok: true });
    expect((await run("list")).widgets).toEqual([]);
  } finally {
    fs.rmSync(tool, { recursive: true, force: true });
    gateway.close();
    await h.shutdown();
  }
});
