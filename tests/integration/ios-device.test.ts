import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startHarness, rawUpgrade } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { IOS_POLICY, IOS_TOOLS, IosDeviceGateway, iosMcpServers, iosThreadServers } from "../../src/control/iosDevice.js";
import { macParts } from "../helpers/macNative.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";
import { Logger } from "../../src/common/logger.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("secret-pixels")]);

/** A stand-in for the iOS app (DeviceTools.swift): dials in with its token and answers the frames it is sent. */
function fakeIphone(url: string, token: string, answer: (method: string, path: string, body: unknown) => { status: number; body?: unknown } | null) {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "x-aio-device-name": encodeURIComponent("Alice's iPhone") } });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as { t: string; id: number; method: string; path: string; body: string };
    if (msg.t !== "req") return;
    const body = msg.body ? JSON.parse(Buffer.from(msg.body, "base64").toString("utf8")) : undefined;
    seen.push({ method: msg.method, path: msg.path, body });
    const out = answer(msg.method, msg.path, body);
    if (!out) return; // never answers (the app went away mid-call)
    ws.send(JSON.stringify({ t: "res", id: msg.id, status: out.status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(out.body ?? {})).toString("base64") }));
  });
  return { ws, seen, opened: new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); }) };
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

it("gives an iPhone's photos, reminders and calendar to the account signed in on it, and to no one else", async () => {
  const h = await startHarness();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-log-"));
  const logFile = path.join(logDir, "control.log");
  const log = new Logger("info", logFile, false);
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, log);
  const { native } = macParts({ cfg, log, usernameOf: names, userIdOf: ids, links });
  const saved = new Map<string, { userId: string; bytes: Buffer }>();
  const ios = new IosDeviceGateway({ cfg, log, port: 0, usernameOf: names, userIdOf: ids, links, workspace: "/home/gem/workspace",
    filesFor: async (userId) => ({ read: async () => { throw new Error("unused"); }, write: async (file, bytes) => { saved.set(file, { userId, bytes }); } }) });
  const gateway = new MemberModelGateway(cfg, log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, native, undefined, undefined, ios);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links, ios });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  const phones: WebSocket[] = [];
  try {
    const alice = await signIn(h, "alice");
    const bob = await signIn(h, "bob");
    const as = (who: { cookie: string; csrf: string }) => ({ cookie: who.cookie, "x-csrf-token": who.csrf, "content-type": "application/json" });
    const aliceCfg = memberConfig(cfg, alice.id, 18092);
    const bobCfg = memberConfig(cfg, bob.id, 18093);
    gateway.provision(aliceCfg);
    expect(aliceCfg.ios).toBeUndefined();

    // The app asks for an iPhone link: a kind of its own, never counted as a Mac.
    expect((await h.request("/api/device-links", { method: "POST", headers: as(alice), body: JSON.stringify({ name: "iPhone", kind: "watch" }) })).status).toBe(400);
    const created = await h.request("/api/device-links", { method: "POST", headers: as(alice), body: JSON.stringify({ name: "iPhone", kind: "ios" }) });
    expect(created.status).toBe(200);
    const { token, link } = (await created.json()) as { token: string; link: { id: string } };
    expect(token).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(h.ctx.db.prepare("SELECT * FROM device_links").all())).not.toContain(token);
    expect(await (await h.request("/api/device-links", { headers: { cookie: alice.cookie } })).json()).toEqual({ links: [], envs: false });
    expect(((await (await h.request("/api/device-links?kind=ios", { headers: { cookie: alice.cookie } })).json()) as { links: Array<{ id: string }> }).links.map((l) => l.id)).toEqual([link.id]);
    expect(await (await h.request("/api/device-links?kind=ios", { headers: { cookie: bob.cookie } })).json()).toEqual({ links: [], envs: false });

    // Her runtime gets aio_ios (and not the Mac's tools); Bob's and the owner's get nothing.
    native.refresh(aliceCfg);
    ios.refresh(aliceCfg);
    expect(aliceCfg.macNative).toBeUndefined();
    expect(aliceCfg.ios!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/ios-device\/[a-f0-9]{64}\/mcp$/);
    expect(iosThreadServers(aliceCfg)).toEqual({ aio_ios: { url: aliceCfg.ios!.url, tool_timeout_sec: 120 } });
    expect(iosMcpServers(aliceCfg)).toEqual({ aio_ios: { type: "http", url: aliceCfg.ios!.url } });
    expect(codexRequirementsToml(aliceCfg)).toContain(`[mcp_servers.aio_ios.identity]\nurl = "${aliceCfg.ios!.url}"\n`);
    gateway.provision(bobCfg);
    ios.provision(cfg);
    expect(bobCfg.ios).toBeUndefined();
    expect(cfg.ios).toBeUndefined();
    expect(codexRequirementsToml(bobCfg)).not.toContain("aio_ios");
    // A capability URL nobody was given reaches nothing.
    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    expect((await fetch(local(aliceCfg.ios!.url).replace(/[a-f0-9]{64}/, "0".repeat(64)), { method: "POST", body: "{}" })).status).toBe(403);

    const rpc = async (body: unknown) => (await (await fetch(local(aliceCfg.ios!.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean; tools?: Array<{ name: string }> } & Record<string, unknown> };
    const call = (name: string, args: Record<string, unknown> = {}) => rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

    // While the app is closed the server still starts with its tools, and a call says to open the app.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result).toMatchObject({ serverInfo: { name: "aio_ios" }, instructions: IOS_POLICY });
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools!.map((t) => t.name)).toEqual(IOS_TOOLS.map((t) => t.name));
    const closed = await call("reminders_list");
    expect(closed.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("open the app") }] });
    expect(await (await h.request("/api/ios-device", { headers: { cookie: alice.cookie } })).json()).toEqual({ linked: true, reachable: false, abilities: null });
    expect(await (await h.request("/api/ios-device", { headers: { cookie: bob.cookie } })).json()).toEqual({ linked: false, reachable: false, abilities: null });

    // Only her token, on the primary host, opens the socket.
    expect((await rawUpgrade(h.primaryPort, DEVICE_LINK_PATH, { Host: `127.0.0.1:${h.primaryPort}`, Authorization: `Bearer ${token}` })).statusLine).toContain("401");

    // The app opens: calls go down its socket as {tool, arguments}, and its answers come back.
    const abilities = { photos: { enabled: true, permission: "limited" }, reminders: { enabled: true, permission: "authorized" }, calendar: { enabled: false, permission: "notDetermined" } };
    let hang = false;
    const phone = fakeIphone(`ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, (method, p, body) => {
      if (method === "GET" && p === "/ios/status") return { status: 200, body: { abilities, timeZone: "Asia/Shanghai" } };
      if (method !== "POST" || p !== "/ios/call") return { status: 404 };
      const { tool, arguments: args } = body as { tool: string; arguments: Record<string, unknown> };
      if (hang) return null;
      if (tool === "reminders_list") return { status: 200, body: { ok: true, result: { reminders: [{ id: "r1", title: "Buy milk", due: "2026-11-05" }] } } };
      if (tool.startsWith("calendar_")) return { status: 200, body: { ok: false, code: "off" } };
      if (tool === "photos_get") return { status: 200, body: { ok: true, result: { photos: (args.ids as string[]).filter((id) => id !== "gone").map((id) => ({ id, created: "2026-11-01T16:30:00+08:00", width: 4032, height: 3024, mediaType: "image", jpeg: JPEG.toString("base64") })), missing: (args.ids as string[]).filter((id) => id === "gone") } } };
      return { status: 200, body: { ok: false, code: "invalid", message: "no" } };
    });
    phones.push(phone.ws);
    await phone.opened;
    await expect.poll(() => Boolean(links.tunnelFor(alice.id, "ios"))).toBe(true);
    // An iPhone is never taken for a Mac.
    expect(links.tunnelFor(alice.id)).toBeNull();
    expect(((await (await h.request("/api/device-links?kind=ios", { headers: { cookie: alice.cookie } })).json()) as { links: Array<{ name: string; online: boolean }> }).links).toEqual([expect.objectContaining({ name: "Alice's iPhone", online: true })]);
    expect(await (await h.request("/api/ios-device", { headers: { cookie: alice.cookie } })).json()).toEqual({ linked: true, reachable: true, abilities });

    const listed = await call("reminders_list", { status: "open" });
    expect(listed.result.isError).toBeUndefined();
    expect(JSON.parse(listed.result.content[0]!.text!)).toEqual({ reminders: [{ id: "r1", title: "Buy milk", due: "2026-11-05" }] });
    expect(phone.seen.at(-1)).toEqual({ method: "POST", path: "/ios/call", body: { tool: "reminders_list", arguments: { status: "open" } } });

    // An ability that is off is explained, with where to turn it on.
    expect((await call("calendar_events", { from: "2026-11-01", to: "2026-11-02" })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Calendar is turned off") }] });

    // Photos: at most five, inside the workspace; saved in her workspace and shown to the model.
    expect((await call("photos_get", { ids: ["a", "b", "c", "d", "e", "f"] })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("At most 5") }] });
    expect((await call("photos_get", { ids: ["a"], folder: "/etc" })).result).toMatchObject({ isError: true });
    const before = phone.seen.length;
    const got = await call("photos_get", { ids: ["A1B2C3D4-0000/L0/001", "gone"], max_size: 9000, folder: "/home/gem/workspace/tasks/t1" });
    expect(phone.seen.length).toBe(before + 1);
    expect(phone.seen.at(-1)!.body).toEqual({ tool: "photos_get", arguments: { ids: ["A1B2C3D4-0000/L0/001", "gone"], max_size: 1600 } });
    expect([...saved.keys()]).toEqual(["/home/gem/workspace/tasks/t1/IMG-20261101-163000-A1B2C3D4.jpg"]);
    expect(saved.get("/home/gem/workspace/tasks/t1/IMG-20261101-163000-A1B2C3D4.jpg")).toEqual({ userId: alice.id, bytes: JPEG });
    expect(got.result.content[0]!.text).toContain("saved /home/gem/workspace/tasks/t1/IMG-20261101-163000-A1B2C3D4.jpg");
    expect(got.result.content[0]!.text).toContain("gone: not found");
    expect(got.result.content.slice(1)).toEqual([{ type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" }]);

    // The app leaves the screen in the middle of creating a reminder: the result is unknown, not failed.
    hang = true;
    const pending = call("reminders_create", { title: "Call mom" });
    await expect.poll(() => phone.seen.at(-1)?.body).toEqual({ tool: "reminders_create", arguments: { title: "Call mom" } });
    phone.ws.terminate();
    expect((await pending).result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not reachable.*Whether it was saved is unknown/s) }] });

    // The log names the account and the tool, never what the phone sent.
    await expect.poll(() => fs.readFileSync(logFile, "utf8")).toContain("iphone tool call");
    const written = fs.readFileSync(logFile, "utf8");
    expect(written).toContain(alice.id);
    expect(written).not.toContain("Buy milk");
    expect(written).not.toContain(JPEG.toString("base64"));

    // Removing the link takes the tools away, and the token no longer opens a socket.
    expect((await h.request(`/api/device-links/${link.id}`, { method: "DELETE", headers: as(bob) })).status).toBe(404);
    expect((await h.request(`/api/device-links/${link.id}`, { method: "DELETE", headers: as(alice) })).status).toBe(200);
    ios.refresh(aliceCfg);
    expect(aliceCfg.ios).toBeUndefined();
    expect((await rawUpgrade(h.primaryPort, DEVICE_LINK_PATH, { Host: `localhost:${h.primaryPort}`, Upgrade: "websocket", Authorization: `Bearer ${token}` })).statusLine).toContain("401");
  } finally {
    for (const ws of phones) ws.terminate();
    links.close();
    gateway.close();
    await h.shutdown();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
