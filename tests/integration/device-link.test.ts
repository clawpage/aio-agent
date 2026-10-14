import { it, expect } from "vitest";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { startHarness, login, rawUpgrade } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { PhoneGateway, phoneMcpServers, phoneThreadServers, PHONE_SCREEN_PATH } from "../../src/control/phone.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";
// @ts-expect-error plain ESM script without types
import { linkDevice } from "../../bin/device-link-client.mjs";

const LOCAL_TOKEN = "local-bridge-secret";

/** A stand-in for bin/phone-bridge.mjs on the user's Mac: checks its own token, records what reaches it. */
async function fakeBridge() {
  const seen: Array<{ method: string; path: string; body?: unknown; session?: string }> = [];
  const screenInput: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) { res.writeHead(401).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    seen.push({ method: req.method ?? "", path: req.url ?? "", body: data ? JSON.parse(data) : undefined, session: req.headers["mcp-session-id"] as string | undefined });
    if (req.url === "/screenshot") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.from([0xff, 0xd8, 0xff])); return; }
    if (req.url === "/status") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ device: { serial: "S9", model: "Pixel 9", name: "Pixel", android: "16" } })); return; }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(data).id, result: { tools: [{ name: "mobile_list_available_devices" }] } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "device", name: "Pixel" }));
      ws.send(Buffer.from([2, 0, 0, 0, 7, 0xbb]));
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
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const csrf = /pa_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(username) as { id: string }).id;
  return { cookie, csrf, id };
}

it("links a Mac's phone to the account that linked it, over the socket the Mac dials, and to no one else", async () => {
  const bridge = await fakeBridge();
  const h = await startHarness();
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, h.ctx.log);
  const phone = new PhoneGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: names, userIdOf: ids, links });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, phone);
  await gateway.start();
  Object.assign(h.ctx, { phone, deviceLinks: links });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head)
    : phone.ownsUpgrade(req) ? phone.handleUpgrade(h.ctx, req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  let client: { close(): void } | null = null;
  try {
    const alice = await signIn(h, "alice");
    const bob = await signIn(h, "bob");
    const owner = await login(h);
    const as = (who: { cookie: string; csrf: string }) => ({ cookie: who.cookie, "x-csrf-token": who.csrf, "content-type": "application/json" });

    // Nobody has a phone yet: no host bridge, no linked Mac.
    for (const who of [alice, bob, owner]) expect(await (await h.request("/api/phone", { headers: { cookie: who.cookie } })).json()).toEqual({ available: false, device: null });
    const aliceCfg = memberConfig(cfg, alice.id, 18092);
    gateway.provision(aliceCfg);
    expect(aliceCfg.phone).toBeUndefined();

    // Alice links her Mac: the token comes back once; it is not stored in the clear.
    const created = await h.request("/api/device-links", { method: "POST", headers: as(alice), body: JSON.stringify({ name: "From console" }) });
    expect(created.status).toBe(200);
    const { token, link } = (await created.json()) as { token: string; link: { id: string } };
    expect(token).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(h.ctx.db.prepare("SELECT * FROM device_links").all())).not.toContain(token);
    phone.refresh(aliceCfg);
    expect(aliceCfg.phone!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/phone\/[a-f0-9]{64}\/mcp$/);
    expect(phoneThreadServers(aliceCfg)).toEqual({ aio_phone: { url: aliceCfg.phone!.url, tool_timeout_sec: expect.any(Number) } });
    expect(phoneMcpServers(aliceCfg)).toEqual({ aio_phone: { type: "http", url: aliceCfg.phone!.url } });
    expect(codexRequirementsToml(aliceCfg)).toContain(`[mcp_servers.aio_phone.identity]\nurl = "${aliceCfg.phone!.url}"\n`);
    // Nobody else's runtime gets one: not Bob's, not the owner's (the host has no phone of its own any more).
    const bobCfg = memberConfig(cfg, bob.id, 18093);
    gateway.provision(bobCfg);
    phone.provision(cfg);
    expect(bobCfg.phone).toBeUndefined();
    expect(cfg.phone).toBeUndefined();
    expect(codexRequirementsToml(bobCfg)).not.toContain("aio_phone");

    // Only her token, only on the primary host, opens the socket.
    const primary = { Host: `localhost:${h.primaryPort}`, Upgrade: "websocket" };
    expect((await rawUpgrade(h.primaryPort, DEVICE_LINK_PATH, { ...primary, Authorization: `Bearer dl_${"x".repeat(43)}` })).statusLine).toContain("401");
    expect((await rawUpgrade(h.primaryPort, DEVICE_LINK_PATH, { Host: `127.0.0.1:${h.primaryPort}`, Authorization: `Bearer ${token}` })).statusLine).toContain("401");

    // Before the Mac connects her phone is known but offline.
    expect(await (await h.request("/api/phone", { headers: { cookie: alice.cookie } })).json()).toEqual({ available: true, reachable: false, device: null });

    const states: string[] = [];
    client = linkDevice({ url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, name: "Alice's MacBook", local: bridge.url, localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s) });
    await expect.poll(() => states.at(-1)).toBe("online");
    const listed = (await (await h.request("/api/device-links", { headers: { cookie: alice.cookie } })).json()) as { links: Array<{ id: string; name: string; online: boolean }> };
    expect(listed.links).toEqual([expect.objectContaining({ id: link.id, name: "Alice's MacBook", online: true })]);
    expect((await (await h.request("/api/device-links", { headers: { cookie: bob.cookie } })).json())).toEqual({ links: [] });

    // Status and the task card's picture come from her Mac (a member's responses never carry a "model" field).
    expect(await (await h.request("/api/phone", { headers: { cookie: alice.cookie } })).json()).toEqual({ available: true, reachable: true, device: { serial: "S9", name: "Pixel", android: "16" } });
    const shot = await h.request("/api/phone/screenshot?at=1", { headers: { cookie: alice.cookie } });
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    // Bob and the owner still have none.
    expect(await (await h.request("/api/phone", { headers: { cookie: bob.cookie } })).json()).toEqual({ available: false, device: null });
    expect((await h.request("/api/phone/screenshot?at=1", { headers: { cookie: owner.cookie } })).status).toBe(404);

    // Her executor's MCP calls go down the socket to the bridge, with the bridge's own token added on the Mac;
    // the gateway holds its own session with mobile-mcp there.
    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const call = { jsonrpc: "2.0", id: 5, method: "tools/list" };
    const res = await fetch(local(aliceCfg.phone!.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 5, result: { tools: [{ name: "mobile_list_available_devices" }] } });
    expect(bridge.seen.filter((s) => s.path === "/mcp").map((s) => [(s.body as { method: string }).method, s.session])).toEqual([
      ["initialize", undefined], ["notifications/initialized", "sess-1"], ["tools/list", "sess-1"]]);

    // Only the bridge's endpoints pass through the Mac.
    const tunnel = links.tunnelFor(alice.id)!;
    expect((await tunnel.request("GET", "/../etc/passwd", { timeoutMs: 5000 })).status).toBe(404);
    expect((await tunnel.request("DELETE", "/mcp", { timeoutMs: 5000 })).status).toBe(404);
    expect(bridge.seen.map((s) => s.path)).not.toContain("/../etc/passwd");

    // The live screen: her console session, relayed through the Mac.
    const ws = new WebSocket(`ws://127.0.0.1:${h.primaryPort}${PHONE_SCREEN_PATH}`, { headers: { Host: `localhost:${h.primaryPort}`, Origin: `http://localhost:${h.primaryPort}`, Cookie: alice.cookie } });
    const got: Array<string | Buffer> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data, binary) => { got.push(binary ? (data as Buffer) : data.toString()); if (got.length === 2) resolve(); });
      ws.on("error", reject);
    });
    expect(got[0]).toBe(JSON.stringify({ type: "device", name: "Pixel" }));
    expect(Buffer.isBuffer(got[1]) && got[1].equals(Buffer.from([2, 0, 0, 0, 7, 0xbb]))).toBe(true);
    ws.send(JSON.stringify({ t: "key", k: "back" }));
    await expect.poll(() => bridge.screenInput).toEqual([JSON.stringify({ t: "key", k: "back" })]);
    ws.close();
    // Bob's console cannot open hers.
    expect((await rawUpgrade(h.primaryPort, PHONE_SCREEN_PATH, { Host: `localhost:${h.primaryPort}`, Origin: `http://localhost:${h.primaryPort}`, Cookie: bob.cookie })).statusLine).toContain("404");

    // Removing the link closes the socket for good and takes the tools away.
    expect((await h.request(`/api/device-links/${link.id}`, { method: "DELETE", headers: as(bob) })).status).toBe(404);
    expect((await h.request(`/api/device-links/${link.id}`, { method: "DELETE", headers: as(alice) })).status).toBe(200);
    await expect.poll(() => states.at(-1)).toBe("revoked");
    phone.refresh(aliceCfg);
    expect(aliceCfg.phone).toBeUndefined();
    expect(await (await h.request("/api/phone", { headers: { cookie: alice.cookie } })).json()).toEqual({ available: false, device: null });
  } finally {
    client?.close();
    links.close();
    gateway.close();
    bridge.close();
    await h.shutdown();
  }
});

it("starts over when the server goes quiet without closing the socket", async () => {
  // A server that accepts and then never pings or speaks: what the client sees when the
  // control plane restarted behind the edge and no close came through.
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let accepted = 0;
  wss.on("connection", () => { accepted += 1; });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const states: string[] = [];
  const client = linkDevice({ url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, token: `dl_${"a".repeat(43)}`, name: "Mac",
    local: "http://127.0.0.1:9", localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s), silenceMs: 200 });
  try {
    await expect.poll(() => accepted, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
    expect(states.slice(0, 4)).toEqual(["connecting", "online", "offline", "connecting"]);
  } finally {
    client.close();
    wss.close();
  }
});

it("keeps the executor's phone tools working through a Mac that is offline at first and whose bridge restarts", async () => {
  const h = await startHarness();
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, h.ctx.log);
  const phone = new PhoneGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: names, userIdOf: ids, links });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, phone);
  await gateway.start();
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  // A mobile-mcp that forgets its sessions on demand (as when it restarts on the Mac).
  const sessions = new Set<string>();
  let next = 0;
  const methods: string[] = [];
  const bridge = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const msg = JSON.parse(data) as { id?: number; method: string };
    methods.push(msg.method);
    if (msg.method === "initialize") {
      const sid = `s${++next}`;
      sessions.add(sid);
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": sid });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } })}\n\n`);
      return;
    }
    if (!sessions.has(String(req.headers["mcp-session-id"]))) { res.writeHead(404).end(); return; }
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Galaxy Z Flip6" }] } })}\n\n`);
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  let client: { close(): void } | null = null;
  try {
    const { token } = links.create("owner_1", "Mac");
    phone.provision(cfg);
    const url = cfg.phone!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = async (body: unknown) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
      return { status: res.status, body: res.status === 202 ? null : await res.json() };
    };
    const callTool = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mobile_list_available_devices", arguments: {} } };

    // The Mac is offline when the executor's thread starts: the server still starts, with the tools.
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mobile-mcp" } } });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toContain("mobile_list_available_devices");
    // A call says the Mac is offline, as a tool error the executor reads.
    const offline = await rpc(callTool);
    expect(offline.body).toMatchObject({ id: 3, result: { isError: true, content: [{ type: "text", text: expect.stringContaining("not connected") }] } });
    expect(methods).toEqual([]);

    // The Mac comes online: the same thread's next call works.
    client = linkDevice({ url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, name: "Mac", local: `http://127.0.0.1:${(bridge.address() as { port: number }).port}`, localToken: LOCAL_TOKEN, onState: () => undefined });
    await expect.poll(() => Boolean(links.tunnelFor("owner_1"))).toBe(true);
    expect((await rpc(callTool)).body).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "Galaxy Z Flip6" }] } });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);

    // mobile-mcp restarts on the Mac and forgets the session: the gateway opens a new one and the call still works.
    sessions.clear();
    expect((await rpc({ ...callTool, id: 4 })).body).toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "Galaxy Z Flip6" }] } });
    expect(methods.slice(3)).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
  } finally {
    client?.close();
    links.close();
    gateway.close();
    bridge.closeAllConnections();
    bridge.close();
    await h.shutdown();
  }
});

it("retries an answer other than the upgrade, and stops for good only on 401", async () => {
  // First a 502 (the control plane restarting behind the edge), then the upgrade; another server only ever says 401.
  const answers = ["HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"];
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  let upgrades = 0;
  server.on("upgrade", (req, socket, head) => {
    upgrades += 1;
    const answer = answers.shift();
    if (answer) { socket.end(answer); return; }
    wss.handleUpgrade(req, socket, head, () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gone = http.createServer();
  let refusals = 0;
  gone.on("upgrade", (_req, socket) => { refusals += 1; socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
  await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
  const port = (s: http.Server) => (s.address() as { port: number }).port;
  const states: string[] = [];
  const revoked: string[] = [];
  const a = linkDevice({ url: `ws://127.0.0.1:${port(server)}`, token: `dl_${"a".repeat(43)}`, name: "Mac", local: "http://127.0.0.1:9", localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s) });
  const b = linkDevice({ url: `ws://127.0.0.1:${port(gone)}`, token: `dl_${"b".repeat(43)}`, name: "Mac", local: "http://127.0.0.1:9", localToken: LOCAL_TOKEN, onState: (s: string) => revoked.push(s) });
  try {
    await expect.poll(() => states.at(-1), { timeout: 8000 }).toBe("online");
    expect(upgrades).toBe(2);
    expect(states).toEqual(["connecting", "offline", "connecting", "online"]);
    await expect.poll(() => revoked.at(-1)).toBe("revoked");
    await new Promise((r) => setTimeout(r, 1500));
    expect(refusals).toBe(1);
  } finally {
    a.close();
    b.close();
    server.closeAllConnections();
    server.close();
    gone.close();
    wss.close();
  }
});
