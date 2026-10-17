import { it, expect } from "vitest";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { startHarness, login, rawUpgrade } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { UserBrowserGateway, userBrowserMcpServers, userBrowserThreadServers, USER_BROWSER_SCREEN_PATH } from "../../src/control/userBrowser.js";
import { USER_BROWSER_TOOLS } from "../../src/control/userBrowserTools.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";
// @ts-expect-error plain ESM script without types
import { linkDevice } from "../../bin/device-link-client.mjs";

const LOCAL_TOKEN = "local-bridge-secret";

const REQUEST_HUMAN = expect.objectContaining({ name: "request_human" });

/** A stand-in for the browser half of bin/phone-bridge.mjs: answers each JSON-RPC message on its own, and the person's picture, front and live view. */
async function fakeBridge(pages = "## Pages\n1: Inbox") {
  const seen: Array<{ path: string; body: { id?: unknown; method?: string; params?: { name?: string } } }> = [];
  const screenInput: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) { res.writeHead(401).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : {};
    seen.push({ path: req.url ?? "", body });
    if (req.url?.startsWith("/browser/screenshot")) { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.from([0xff, 0xd8, 0xff])); return; }
    if (req.url?.startsWith("/browser/front")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    // An older bridge has no browser: a tool it does not know stands in for it here.
    if (body.params?.name === "from_an_old_bridge") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body.method === "tools/list"
      ? { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "list_pages" }] } }
      : { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: pages }] } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) { socket.destroy(); return; }
    seen.push({ path: req.url ?? "", body: {} });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "size", width: 1280, height: 800 }));
      ws.send(Buffer.from([0xff, 0xd8, 0xff, 0x01]));
      ws.on("message", (msg) => screenInput.push(msg.toString()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, screenInput, close: () => { server.closeAllConnections(); server.close(); } };
}

async function signIn(h: Awaited<ReturnType<typeof startHarness>>, username: string) {
  await createMember(h.ctx.db, username, `${username}-password-123`);
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  const res = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: `${username}-password-123` }) });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const csrf = /pa_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(username) as { id: string }).id;
  return { cookie, csrf, id };
}

it("offers an account its own Chrome on the Mac it linked, and sends the executor to the sandbox browser while it is away", async () => {
  const bridge = await fakeBridge();
  const h = await startHarness();
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, h.ctx.log);
  const browser = new UserBrowserGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: names, userIdOf: ids, links });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, browser);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  let client: { close(): void } | null = null;
  try {
    const alice = await signIn(h, "alice");
    const bob = await signIn(h, "bob");
    const aliceCfg = memberConfig(cfg, alice.id, 18092);
    const bobCfg = memberConfig(cfg, bob.id, 18093);
    gateway.provision(aliceCfg);
    expect(aliceCfg.userBrowser).toBeUndefined();
    expect(userBrowserThreadServers(aliceCfg)).toEqual({});

    // Linking her Mac gives her runtime the tools; nobody else's runtime gets them.
    const created = await h.request("/api/device-links", { method: "POST", headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf, "content-type": "application/json" }, body: JSON.stringify({ name: "Mac" }) });
    const { token, link } = (await created.json()) as { token: string; link: { id: string } };
    browser.refresh(aliceCfg);
    const url = aliceCfg.userBrowser!.url;
    expect(url).toMatch(/^http:\/\/host\.docker\.internal:0\/user-browser\/[a-f0-9]{64}\/mcp$/);
    expect(userBrowserThreadServers(aliceCfg)).toEqual({ aio_user_browser: { url, tool_timeout_sec: expect.any(Number) } });
    expect(userBrowserThreadServers(aliceCfg, { key: "conv_1", title: "t" })).toEqual({ aio_user_browser: { url, http_headers: { "X-AIO-Task": "conv_1" }, tool_timeout_sec: 31 * 60 } });
    expect(userBrowserMcpServers(aliceCfg)).toEqual({ aio_user_browser: { type: "http", url } });
    expect(codexRequirementsToml(aliceCfg)).toContain(`[mcp_servers.aio_user_browser.identity]\nurl = "${url}"\n`);
    gateway.provision(bobCfg);
    browser.provision(cfg);
    expect(bobCfg.userBrowser).toBeUndefined();
    expect(cfg.userBrowser).toBeUndefined();

    const rpc = async (body: unknown, to = url) => {
      const res = await fetch(to.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };
    // A token nobody was given reaches nothing.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, url.replace(/[a-f0-9]{64}/, "0".repeat(64)))).status).toBe(403);

    // With the Mac away the server still starts, lists its tools, and a call says to use the sandbox browser.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).body).toEqual({ jsonrpc: "2.0", id: 1, result: expect.objectContaining({ protocolVersion: "2025-06-18", serverInfo: { name: "aio_user_browser", version: "1" }, instructions: expect.stringContaining("aio_tabs") }) });
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [...USER_BROWSER_TOOLS, REQUEST_HUMAN] } });
    const away = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_pages", arguments: {} } })).body as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(away.result.isError).toBe(true);
    expect(away.result.content[0]!.text).toMatch(/not connected.*aio_tabs/s);
    expect(bridge.seen).toEqual([]);

    // Once the Mac dials in, calls go down its socket to the bridge's browser endpoint.
    const states: string[] = [];
    client = linkDevice({ url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, name: "Mac", local: bridge.url, localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s) });
    await expect.poll(() => states.at(-1)).toBe("online");
    expect((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" })).body).toEqual({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "list_pages" }, REQUEST_HUMAN] } });
    expect((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_pages", arguments: {} } })).body).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "## Pages\n1: Inbox" }] } });
    expect(bridge.seen.map((s) => [s.path, s.body.method, s.body.id])).toEqual([["/browser/mcp", "tools/list", 4], ["/browser/mcp", "tools/call", 5]]);
    // The handshake never goes to the Mac.
    await rpc({ jsonrpc: "2.0", id: 6, method: "initialize" });
    expect(bridge.seen).toHaveLength(2);

    // A Mac app from before the browser answers the browser path 404: the executor is told to use the sandbox browser.
    const old = (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "from_an_old_bridge", arguments: {} } })).body as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(old.result).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/did not answer.*aio_tabs/s) }] });

    // Removing the link takes the tools away.
    expect((await h.request(`/api/device-links/${link.id}`, { method: "DELETE", headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf } })).status).toBe(200);
    await expect.poll(() => states.at(-1)).toBe("revoked");
    browser.refresh(aliceCfg);
    expect(aliceCfg.userBrowser).toBeUndefined();
  } finally {
    client?.close();
    links.close();
    gateway.close();
    bridge.close();
    await h.shutdown();
  }
});

it("shows the page a task works in on the user's Chrome, and hands it to the person and back", async () => {
  const bridge = await fakeBridge("## Pages\n1: Inbox (https://mail.example/)\n2: Example Domain (https://example.com/) [selected]");
  const h = await startHarness();
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }) });
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0 });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, h.ctx.log);
  const browser = new UserBrowserGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: names, userIdOf: ids, links });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, browser);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links, userBrowser: browser });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head)
    : browser.ownsUpgrade(req) ? browser.handleUpgrade(h.ctx, req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  let client: { close(): void } | null = null;
  try {
    const owner = await login(h);
    const headers = { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" };
    const ownerId = (h.ctx.db.prepare("SELECT id FROM owners WHERE role='owner'").get() as { id: string }).id;
    cfg.runtimeUserId = ownerId;
    const { token } = links.create(ownerId, "Mac");
    browser.provision(cfg);
    const states: string[] = [];
    client = linkDevice({ url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, name: "Mac", local: bridge.url, localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s) });
    await expect.poll(() => states.at(-1)).toBe("online");
    const task = ((await (await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "查个网页", clientMessageId: "ub-1" }) })).json()) as { task: { id: string; conversationId: string } }).task;
    const key = h.ctx.tasks.browserKey(task.id)!;
    const feed = async () => ((await (await h.request("/api/main", { headers: { cookie: owner.cookie } })).json()) as { tasks: Array<{ id: string; userBrowser?: unknown }> }).tasks.find((t) => t.id === task.id)?.userBrowser;
    expect(await feed()).toBeUndefined();

    // The executor's calls carry its task: the page it opens is that task's page.
    const agent = async (name: string, args: Record<string, unknown> = {}, id = 1) => {
      const res = await fetch(cfg.userBrowser!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), {
        method: "POST", headers: { "content-type": "application/json", "X-AIO-Task": key }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
      return ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    };
    await agent("new_page", { url: "https://example.com" });
    expect(await feed()).toEqual({ page: true, title: "Example Domain", url: "https://example.com/", holder: "ai", request: null });

    // Its picture comes from the Mac, of that page.
    const shot = await h.request(`/api/tasks/${task.id}/user-browser/screenshot?at=1`, { headers: { cookie: owner.cookie } });
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect(bridge.seen.some((s) => s.path === "/browser/screenshot?page=2")).toBe(true);

    // The agent asks for the person: the card says why, and the call waits.
    let answered: { content: Array<{ text: string }>; isError?: boolean } | null = null;
    void agent("request_human", { reason: "请在页面上登录" }, 9).then((r) => { answered = r; });
    await expect.poll(feed).toEqual({ page: true, title: "Example Domain", url: "https://example.com/", holder: "ai", request: "请在页面上登录" });

    // Watching is open to the account, input is not until it takes the page over.
    const origin = `http://localhost:${h.primaryPort}`;
    expect((await rawUpgrade(h.primaryPort, `${USER_BROWSER_SCREEN_PATH}?key=${key}`, { Host: `localhost:${h.primaryPort}`, Origin: "https://evil.example", Cookie: owner.cookie })).statusLine).toContain("403");
    expect((await rawUpgrade(h.primaryPort, `${USER_BROWSER_SCREEN_PATH}?key=conv_nobody`, { Host: `localhost:${h.primaryPort}`, Origin: origin, Cookie: owner.cookie })).statusLine).toContain("404");
    const ws = new WebSocket(`ws://127.0.0.1:${h.primaryPort}${USER_BROWSER_SCREEN_PATH}?key=${key}`, { headers: { Host: `localhost:${h.primaryPort}`, Origin: origin, Cookie: owner.cookie } });
    const got: Array<string | Buffer> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data, binary) => { got.push(binary ? (data as Buffer) : data.toString()); if (got.length === 2) resolve(); });
      ws.on("error", reject);
    });
    expect(got[0]).toBe(JSON.stringify({ type: "size", width: 1280, height: 800 }));
    expect(bridge.seen.some((s) => s.path === "/browser/screen?page=2")).toBe(true);
    ws.send(JSON.stringify({ t: "click", x: 0.5, y: 0.5 }));

    // Taking over brings the page to the front and shuts the agent out of it.
    const taken = await h.request(`/api/tasks/${task.id}/user-browser/control`, { method: "POST", headers, body: JSON.stringify({ action: "take" }) });
    expect(await taken.json()).toEqual({ userBrowser: { page: true, title: "Example Domain", url: "https://example.com/", holder: "human", request: "请在页面上登录" } });
    expect(bridge.seen.some((s) => s.path === "/browser/front?page=2")).toBe(true);
    expect((await agent("click", { pageId: 2, uid: "1_1" })).content[0]!.text).toMatch(/taken over.*request_human/s);
    ws.send(JSON.stringify({ t: "text", s: "你好" }));
    await expect.poll(() => bridge.screenInput).toEqual([JSON.stringify({ t: "text", s: "你好" })]);

    // Handing back answers the waiting agent, and the page is the agent's again.
    expect(answered).toBeNull();
    await h.request(`/api/tasks/${task.id}/user-browser/control`, { method: "POST", headers, body: JSON.stringify({ action: "release" }) });
    await expect.poll(() => answered?.content[0]?.text).toMatch(/handed the page back/);
    expect(await feed()).toEqual({ page: true, title: "Example Domain", url: "https://example.com/", holder: "ai", request: null });
    expect((await agent("click", { pageId: 2, uid: "1_1" })).isError).toBeFalsy();
    ws.close();
    expect((await h.request(`/api/tasks/${task.id}/user-browser/control`, { method: "POST", headers, body: JSON.stringify({ action: "close" }) })).status).toBe(400);
  } finally {
    client?.close();
    links.close();
    gateway.close();
    bridge.close();
    await h.shutdown();
  }
});
