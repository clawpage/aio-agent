import { it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SHARE_CLI_PY } from "../../src/control/docker/seed.js";
import { startHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { ShareStore } from "../../src/control/share.js";
import { memberConfig } from "../../src/control/tenants.js";

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

it("publishes a page from the sandbox channel and serves it publicly, sandboxed, on the workspace origin only", async () => {
  const h = await startHarness();
  const db = h.ctx.db;
  const lookup = (sql: string, v: string) => (db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  const store = new ShareStore({
    cfg: h.ctx.cfg, port: 0,
    usernameOf: (id) => lookup("SELECT username AS v FROM owners WHERE id=?", id),
    userIdOf: (name) => lookup("SELECT id AS v FROM owners WHERE username=?", name),
  });
  h.ctx.share = store;
  const gateway = new MemberModelGateway({ ...h.ctx.cfg, memberModelPort: 0 }, h.ctx.log, store);
  await gateway.start();
  try {
    const owner = { ...h.ctx.cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    store.provision(owner);
    const member = await createMember(db, "cr", "member-password-123");
    const memberCfg = memberConfig(h.ctx.cfg, member.id, 18090);
    gateway.provision(memberCfg);
    expect(owner.share!.endpoint).toBe("http://host.docker.internal:0/share/owner_1");
    expect(memberCfg.share!.token).not.toBe(owner.share!.token);

    const api = (userId: string, rest: string, token: string, method = "GET", body?: unknown) =>
      fetch(`http://127.0.0.1:${gateway.port}/share/${userId}/pages${rest}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const publish = (files: Array<{ path: string; data: string }>, name = "trip", token = owner.share!.token, userId = "owner_1") =>
      api(userId, `/${name}`, token, "POST", { title: "东京行程", files });
    const page = [
      { path: "index.html", data: b64('<!doctype html><title>t</title><img src="img/a.png"><script>document.title="ok"</script>') },
      { path: "img/a.png", data: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
    ];

    // Only the runtime's own token, and only for its own pages.
    expect((await api("owner_1", "", "f".repeat(64))).status).toBe(403);
    expect((await publish(page, "trip", memberCfg.share!.token)).status).toBe(403);
    expect((await api(member.id, "", owner.share!.token)).status).toBe(403);
    // Malformed pages never land.
    for (const bad of [
      [{ path: "about.html", data: b64("x") }],
      [...page, { path: "../escape.html", data: b64("x") }],
      [...page, { path: ".env", data: b64("SECRET=1") }],
      [...page, { path: "a\\b.html", data: b64("x") }],
    ]) expect((await publish(bad)).status).toBe(400);
    expect((await publish(page, "Bad_Name")).status).toBe(400);
    expect((await api("owner_1", "", owner.share!.token).then((r) => r.json())).pages).toEqual([]);

    const created = await publish(page);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ name: "trip", title: "东京行程", files: 2, url: `https://${h.ctx.cfg.workspaceHost}/u/owner/share/trip/` });
    expect((await api("owner_1", "", owner.share!.token).then((r) => r.json())).pages.map((p: { name: string }) => p.name)).toEqual(["trip"]);

    // Public, no session, sandboxed into an opaque origin.
    const html = await h.request("/u/owner/share/trip/", { host: "workspace" });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('document.title="ok"');
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = html.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^sandbox allow-scripts/);
    expect(csp).not.toContain("allow-same-origin");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("set-cookie")).toBeNull();
    const img = await h.request("/u/owner/share/trip/img/a.png", { host: "workspace" });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toMatch(/^sandbox /);

    // Address forms: a trailing slash for relative links, and the short `share?<name>`.
    const bare = await h.request("/u/owner/share/trip?x=1", { host: "workspace" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe("/u/owner/share/trip/?x=1");
    const short = await h.request("/u/owner/share?trip", { host: "workspace" });
    expect(short.status).toBe(302);
    expect(short.headers.get("location")).toBe("/u/owner/share/trip/");

    // Nothing outside the page, nothing hidden, nobody else's pages, and never on the primary origin.
    for (const probe of [
      "/u/owner/share/trip/%2e%2e/%2e%2e/owner-runtime/share-token",
      "/u/owner/share/trip/..%2f..%2fshare-token",
      "/u/owner/share/trip/.meta.json",
      "/u/owner/share/missing/",
      "/u/nobody/share/trip/",
      "/u/cr/share/trip/",
    ]) expect((await h.request(probe, { host: "workspace" })).status, probe).toBe(404);
    expect(await (await h.request("/u/owner/share/trip/", { host: "primary" })).text()).not.toContain('document.title="ok"');

    // Republishing replaces the page as a whole under the same address.
    expect((await publish([{ path: "index.html", data: b64("<p>v2</p>") }])).status).toBe(200);
    expect(await (await h.request("/u/owner/share/trip/", { host: "workspace" })).text()).toBe("<p>v2</p>");
    expect((await h.request("/u/owner/share/trip/img/a.png", { host: "workspace" })).status).toBe(404);

    // A member publishes under its own address with its own token.
    expect((await publish(page, "notes", memberCfg.share!.token, member.id)).status).toBe(200);
    expect((await h.request("/u/cr/share/notes/", { host: "workspace" })).status).toBe(200);
    expect((await h.request("/u/owner/share/notes/", { host: "workspace" })).status).toBe(404);

    expect((await api("owner_1", "/trip", owner.share!.token, "DELETE")).status).toBe(204);
    expect((await h.request("/u/owner/share/trip/", { host: "workspace" })).status).toBe(404);
    expect((await api("owner_1", "/trip", owner.share!.token, "DELETE")).status).toBe(404);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("the sandbox aio-share CLI publishes, lists and deletes through the gateway", async () => {
  const h = await startHarness();
  const store = new ShareStore({ cfg: h.ctx.cfg, port: 0, usernameOf: () => "owner", userIdOf: (n) => (n === "owner" ? "owner_1" : null) });
  h.ctx.share = store;
  const gateway = new MemberModelGateway({ ...h.ctx.cfg, memberModelPort: 0 }, h.ctx.log, store);
  await gateway.start();
  const tool = fs.mkdtempSync(path.join(os.tmpdir(), "pa-share-cli-"));
  try {
    const owner = { ...h.ctx.cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    store.provision(owner);
    fs.writeFileSync(path.join(tool, "aio-share.py"), SHARE_CLI_PY);
    fs.writeFileSync(path.join(tool, "config.json"), JSON.stringify({ ...owner.share, endpoint: `http://127.0.0.1:${gateway.port}/share/owner_1` }));
    const dir = path.join(tool, "Trip Plan");
    fs.mkdirSync(path.join(dir, "img"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>行程</h1>");
    fs.writeFileSync(path.join(dir, "img", "a.png"), "png");
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
    const run = (...args: string[]) => promisify(execFile)("python3", [path.join(tool, "aio-share.py"), ...args]).then((r) => JSON.parse(r.stdout));

    const page = await run("publish", dir, "--title", "行程");
    expect(page).toMatchObject({ ok: true, name: "trip-plan", title: "行程", files: 2, url: `https://${h.ctx.cfg.workspaceHost}/u/owner/share/trip-plan/` });
    expect(await (await h.request("/u/owner/share/trip-plan/", { host: "workspace" })).text()).toBe("<h1>行程</h1>");
    expect((await h.request("/u/owner/share/trip-plan/.env", { host: "workspace" })).status).toBe(404);
    expect((await run("list")).pages.map((p: { name: string }) => p.name)).toEqual(["trip-plan"]);
    expect(await run("delete", "trip-plan")).toEqual({ ok: true, deleted: "trip-plan" });
    const missing = await promisify(execFile)("python3", [path.join(tool, "aio-share.py"), "publish", path.join(tool, "img-only")]).catch((e) => e);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false });
  } finally {
    fs.rmSync(tool, { recursive: true, force: true });
    gateway.close();
    await h.shutdown();
  }
});
