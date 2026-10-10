import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { startHarness, login, rawUpgrade } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { PhoneGateway, phoneMcpServers, phoneThreadServers, PHONE_SCREEN_PATH } from "../../src/control/phone.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";

const USERS: Record<string, string> = { owner_1: "owner", user_gadget: "betaw" };

/** A stand-in for bin/phone-bridge.mjs: records what reaches it. */
async function fakeBridge() {
  const seen: Array<{ path: string; auth?: string; body?: unknown }> = [];
  const screenInput: string[] = [];
  const server = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: data ? JSON.parse(data) : undefined });
    if (req.url === "/screenshot") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.from([0xff, 0xd8, 0xff])); return; }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/status") res.end(JSON.stringify({ device: { serial: "S1", model: "SM-F741U1", name: "Galaxy Z Flip6", android: "16" }, viewers: 0 }));
    else res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(data).id, result: { tools: [{ name: "mobile_list_available_devices" }] } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "device", name: "Galaxy Z Flip6" }));
      ws.send(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 1, 0xaa]));
      ws.on("message", (msg) => screenInput.push(msg.toString()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, seen, screenInput, close: () => { server.closeAllConnections(); server.close(); } };
}

it("offers the phone to the owner alone: tools through the gateway, the screen on the console, the bridge token kept on the host", async () => {
  const bridge = await fakeBridge();
  const h = await startHarness();
  const keyFile = path.join(h.dataDir, "phone-bridge.env");
  fs.writeFileSync(keyFile, "PHONE_BRIDGE_TOKEN=host-phone-secret\n", { mode: 0o600 });
  const saved = process.env.PHONE_BRIDGE_TOKEN;
  delete process.env.PHONE_BRIDGE_TOKEN;
  Object.assign(h.ctx.cfg, { memberModelPort: 0, phoneBridge: { url: bridge.url, secretsFile: keyFile } });
  const cfg = h.ctx.cfg;
  const phone = new PhoneGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => USERS[id] ?? null });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, phone);
  await gateway.start();
  h.ctx.phone = phone;
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => (phone.ownsUpgrade(req) ? phone.handleUpgrade(h.ctx, req, socket, head) : handleUpgrade(h.ctx, req, socket, head)));
  try {
    const owner = Object.assign(cfg, { runtimeUserId: "owner_1" });
    phone.provision(owner);
    // A member's config is derived from the owner's: it must not carry the owner's phone,
    // and neither the member gateway nor the phone gateway gives it one of its own.
    const gadget = memberConfig(cfg, "user_gadget", 18091);
    expect(gadget.phone).toBeUndefined();
    gateway.provision(gadget);
    phone.provision(gadget);
    expect(gadget.phone).toBeUndefined();

    expect(owner.phone!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/phone\/[a-f0-9]{64}\/mcp$/);
    expect(phoneThreadServers(owner)).toEqual({ aio_phone: { url: owner.phone!.url, tool_timeout_sec: expect.any(Number) } });
    expect(phoneMcpServers(owner)).toEqual({ aio_phone: { type: "http", url: owner.phone!.url } });
    expect(phoneThreadServers(gadget)).toEqual({});
    expect(codexRequirementsToml(owner)).toContain(`[mcp_servers.aio_phone.identity]\nurl = "${owner.phone!.url}"\n`);
    expect(codexRequirementsToml(gadget)).not.toContain("aio_phone");
    expect(JSON.stringify([owner, gadget])).not.toContain("host-phone-secret");

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const call = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    const rpc = (url: string) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) });
    expect((await rpc(owner.phone!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)))).status).toBe(403);
    const res = await rpc(owner.phone!.url);
    expect(res.status).toBe(200);
    expect(bridge.seen).toEqual([{ path: "/mcp", auth: "Bearer host-phone-secret", body: call }]);

    // Status: the owner sees the phone, a member is refused.
    const ownerAuth = await login(h);
    const status = await h.request("/api/phone", { headers: { cookie: ownerAuth.cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ available: true, reachable: true, device: { serial: "S1", model: "SM-F741U1", name: "Galaxy Z Flip6", android: "16" } });
    await createMember(h.ctx.db, "member", "member-password-123");
    h.ctx.db.prepare("DELETE FROM login_failures").run();
    const memberLogin = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "member", password: "member-password-123" }) });
    const memberCookie = (memberLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    expect((await h.request("/api/phone", { headers: { cookie: memberCookie } })).status).toBe(403);
    // The screen picture for a task card: the owner's only.
    const shot = await h.request("/api/phone/screenshot?at=1", { headers: { cookie: ownerAuth.cookie } });
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect((await h.request("/api/phone/screenshot?at=1", { headers: { cookie: memberCookie } })).status).toBe(403);

    // The screen: only an owner session, on the console's own origin.
    const primary = { Host: `localhost:${h.primaryPort}`, Origin: `http://localhost:${h.primaryPort}` };
    expect((await rawUpgrade(h.primaryPort, PHONE_SCREEN_PATH, primary)).statusLine).toContain("403");
    expect((await rawUpgrade(h.primaryPort, PHONE_SCREEN_PATH, { ...primary, Cookie: memberCookie })).statusLine).toContain("403");
    expect((await rawUpgrade(h.primaryPort, PHONE_SCREEN_PATH, { ...primary, Cookie: ownerAuth.cookie, Origin: "https://evil.example" })).statusLine).toContain("403");
    expect((await rawUpgrade(h.primaryPort, PHONE_SCREEN_PATH, { Host: `127.0.0.1:${h.primaryPort}`, Origin: `http://127.0.0.1:${h.primaryPort}`, Cookie: ownerAuth.cookie })).statusLine).toContain("403");
    expect(bridge.seen.filter((s) => s.path === "/screen")).toEqual([]);

    const ws = new WebSocket(`ws://127.0.0.1:${h.primaryPort}${PHONE_SCREEN_PATH}`, { headers: { ...primary, Cookie: ownerAuth.cookie } });
    const got: Array<string | Buffer> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data, binary) => { got.push(binary ? (data as Buffer) : data.toString()); if (got.length === 2) resolve(); });
      ws.on("error", reject);
    });
    expect(got[0]).toBe(JSON.stringify({ type: "device", name: "Galaxy Z Flip6" }));
    expect(Buffer.isBuffer(got[1]) && got[1].equals(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 1, 0xaa]))).toBe(true);
    ws.send(JSON.stringify({ t: "key", k: "home" }));
    await expect.poll(() => bridge.screenInput).toEqual([JSON.stringify({ t: "key", k: "home" })]);
    expect(bridge.seen.filter((s) => s.path === "/screen")).toEqual([{ path: "/screen", auth: "Bearer host-phone-secret" }]);
    ws.close();
  } finally {
    if (saved !== undefined) process.env.PHONE_BRIDGE_TOKEN = saved;
    gateway.close();
    bridge.close();
    await h.shutdown();
  }
});
