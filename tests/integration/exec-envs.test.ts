import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { macParts } from "../helpers/macNative.js";
import { EnvRegistry } from "../../src/control/envs/registry.js";
import { ENV_TOOLS, EnvGateway, envMcpServers, envThreadServers } from "../../src/control/envs/gateway.js";
import { ENV_POLICY, envBrief } from "../../src/control/envs/policy.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";
import { Logger } from "../../src/common/logger.js";

/**
 * The execution environments end to end (docs/EXEC-ENVS.md): stand-ins for every kind of device dial
 * in over a real device-link socket, the executor's side is aio_env on the member gateway, and what each
 * device was asked is recorded.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("page-pixels")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("photo-pixels")]);

type Asked = { method: string; path: string; body: any; headers: Record<string, string> };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | null;

/** A device dialing in with its token: answers the requests it is sent, and can push events. */
function device(url: string, token: string, name: string, answer: (asked: Asked) => Reply) {
  const seen: Asked[] = [];
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "x-aio-device-name": encodeURIComponent(name) } });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as { t: string; id: number; method: string; path: string; body: string; headers: Record<string, string> };
    if (msg.t !== "req") return;
    const text = msg.body ? Buffer.from(msg.body, "base64").toString("utf8") : "";
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    const asked = { method: msg.method, path: msg.path, body, headers: msg.headers ?? {} };
    seen.push(asked);
    const out = answer(asked);
    if (!out) return;
    ws.send(JSON.stringify({ t: "res", id: msg.id, status: out.status, headers: { "content-type": "application/json", ...out.headers }, body: Buffer.from(JSON.stringify(out.body ?? {})).toString("base64") }));
  });
  return {
    ws,
    seen,
    calls: () => seen.filter((s) => s.path === "/env/call").map((s) => s.body as { env: string; tool: string; arguments: Record<string, unknown> }),
    push: (name: string, data: unknown) => ws.send(JSON.stringify({ t: "event", name, data })),
    opened: new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); }),
  };
}

/** The new iPhone app (protocol 1): its in-app browser, its folder and photos, answered by /env/call. */
function newIphone(url: string, token: string, opts: { foreground?: boolean; confirm?: boolean } = {}) {
  return device(url, token, "Alice's iPhone", ({ method, path, body }) => {
    if (method === "GET" && path === "/env/manifest") {
      return { status: 200, body: { protocol: 1, envs: [{ deviceId: "IPHONE-VENDOR-ID", kind: "ios", name: "Alice's iPhone", capabilities: ["browser", "files", "photos", "calendar"], foreground: opts.foreground ?? true }] } };
    }
    if (method !== "POST" || path !== "/env/call") return { status: 404 };
    switch (body.tool) {
      case "browser_open": return { status: 200, body: { ok: true, result: { url: body.arguments.url, title: "Example" } } };
      case "browser_read": return { status: 200, body: { ok: true, result: { url: "https://example.com/", title: "Example", text: "Example Domain", elements: [{ ref: "e1", role: "link", name: "More information" }] } } };
      case "browser_click": return opts.confirm
        ? { status: 200, body: { ok: false, code: "needs_confirmation", message: "Pay $12.00 to Example" } }
        : { status: 200, body: { ok: true, result: { clicked: body.arguments.ref } } };
      case "browser_screenshot": return { status: 200, body: { ok: true, result: { image: PNG.toString("base64"), mimeType: "image/png" } } };
      case "photos_get": return { status: 200, body: { ok: true, result: { photos: [{ id: "P1", created: "2026-11-04T15:30:12", width: 4032, height: 3024, jpeg: JPEG.toString("base64") }], missing: [] } } };
      default: return { status: 200, body: { ok: false, code: "unknown_tool" } };
    }
  });
}

/** An iPhone app from before protocol 1: no manifest, the abilities from /ios/status, calls through /ios/call. */
function oldIphone(url: string, token: string) {
  return device(url, token, "Bob's old iPhone", ({ method, path, body }) => {
    if (path === "/ios/status") return { status: 200, body: { abilities: { photos: { enabled: true, permission: "authorized" }, reminders: { enabled: false, permission: "notDetermined" }, calendar: { enabled: true, permission: "authorized" } }, timeZone: "Asia/Shanghai" } };
    if (method === "POST" && path === "/ios/call") return { status: 200, body: { ok: true, result: { events: [{ title: "Dentist", tool: body.tool }] } } };
    return { status: 404 };
  });
}

/** A Mac app from before protocol 1 with one Android phone on USB: its bridge's /status, and mobile-mcp at /mcp. */
function oldMacWithPhone(url: string, token: string) {
  return device(url, token, "Alice's MacBook", ({ method, path, body }) => {
    if (path === "/status") return { status: 200, body: { device: { serial: "R5CT40ABCDE", model: "SM-S918", name: "Galaxy S23", android: "14" } } };
    if (method === "POST" && path === "/mcp") {
      if (body.method === "initialize") return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mobile-mcp", version: "1" } } }, headers: { "mcp-session-id": "mm-1" } };
      if (body.method === "notifications/initialized") return { status: 202 };
      if (body.method === "tools/call") {
        if (body.params.name === "mobile_take_screenshot") return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] } } };
        return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `done ${body.params.name}` }] } } };
      }
    }
    return { status: 404 };
  });
}

/** The Android app (protocol 1). The Play build has no debugging and so no apps or screen; the side-loaded APK with debugging granted has both, and names its adb serial. */
function androidApp(url: string, token: string, build: "play" | "apk") {
  return device(url, token, build === "apk" ? "Galaxy S23" : "Pixel 8", ({ method, path, body }) => {
    if (method === "GET" && path === "/env/manifest") {
      return { status: 200, body: { protocol: 1, envs: [build === "apk"
        ? { deviceId: "android-id-s23", aliases: ["R5CT40ABCDE"], kind: "android", name: "Galaxy S23", capabilities: ["browser", "files", "photos", "calendar", "apps", "screen"], foreground: false }
        : { deviceId: "android-id-pixel", kind: "android", name: "Pixel 8", capabilities: ["browser", "files", "photos", "calendar"], foreground: true }] } };
    }
    if (method === "POST" && path === "/env/call") return { status: 200, body: { ok: true, result: { did: body.tool } } };
    return { status: 404 };
  });
}

let h: Awaited<ReturnType<typeof startHarness>>;
let gateway: MemberModelGateway;
let links: DeviceLinks;
let envs: EnvGateway;
let registry: EnvRegistry;
let saved: Map<string, { userId: string; bytes: Buffer }>;
let devices: WebSocket[];
let url: string;

async function signIn(username: string) {
  await createMember(h.ctx.db, username, `${username}-password-123`);
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  const res = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: `${username}-password-123` }) });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const csrf = /pa_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(username) as { id: string }).id;
  return { cookie, csrf, id, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" } };
}

/** A device link of `kind` for the account, as the app asks for it; its token. */
async function link(who: { headers: Record<string, string> }, kind: "mac" | "ios" | "android", name: string): Promise<string> {
  const res = await h.request("/api/device-links", { method: "POST", headers: who.headers, body: JSON.stringify({ name, kind }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** An account's runtime with the execution environments on (PA_EXEC_ENVS=1), provisioned on the member gateway. */
function runtimeFor(userId: string, port: number) {
  const runtime = memberConfig({ ...h.ctx.cfg, execEnvs: true }, userId, port);
  gateway.provision(runtime);
  return runtime;
}

/** The account's aio_env, as its executor calls it. */
function executor(runtime: { env?: { url: string } }) {
  let id = 0;
  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(runtime.env!.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return (await res.json()) as { result: any; error?: unknown };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
  const text = (out: { content: Array<{ type: string; text?: string }> }) => out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const list = async () => JSON.parse(text(await call("env_list"))) as { envs: Array<{ id: string; kind: string; name: string; online: boolean; foreground: boolean; capabilities: string[] }> };
  return { rpc, call, text, list };
}

const waitFor = async <T>(probe: () => Promise<T | undefined> | T | undefined): Promise<T> => {
  for (let i = 0; i < 200; i++) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
};

beforeEach(async () => {
  h = await startHarness();
  const log = new Logger("error", undefined, false);
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  links = new DeviceLinks(h.ctx.db, cfg, log);
  const mac = macParts({ cfg, log, usernameOf: names, userIdOf: ids, links });
  saved = new Map();
  registry = new EnvRegistry({ links, log, phone: mac.phone, browser: mac.browser, shell: mac.shell });
  envs = new EnvGateway({ cfg, log, port: 0, usernameOf: names, userIdOf: ids, links, registry, workspace: "/home/gem/workspace",
    filesFor: async (userId) => ({ read: async (file) => { const kept = saved.get(file); if (!kept || kept.userId !== userId) throw new Error("no such file"); return kept.bytes; }, write: async (file, bytes) => { saved.set(file, { userId, bytes: Buffer.from(bytes) }); } }) });
  gateway = new MemberModelGateway(cfg, log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, mac.native, undefined, undefined, undefined, envs);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links, envs: registry });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  url = `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`;
  devices = [];
});

afterEach(async () => {
  for (const ws of devices) ws.terminate();
  links.close();
  gateway.close();
  await h.shutdown();
});

/** Connect a stand-in and wait until the registry has read what it offers. */
async function connect(stand: ReturnType<typeof device>, userId: string, count: number) {
  devices.push(stand.ws);
  await stand.opened;
  await waitFor(async () => (await registry.list(userId)).filter((e) => e.kind !== "sandbox" && e.online).length >= count || undefined);
  return stand;
}

describe("one model for every environment", () => {
  it("lists the sandbox and each linked device by what it can do, never by how it is connected", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18101);
    // aio_env is there from the start: Codex starts a thread's servers once, devices come and go.
    expect(runtime.env?.url).toMatch(/\/env\/[a-f0-9]{64}\/mcp$/);
    const agent = executor(runtime);
    expect((await agent.list()).envs).toEqual([{ id: "sandbox", kind: "sandbox", name: "Sandbox", online: true, foreground: false, capabilities: ["browser", "files", "shell"] }]);

    const iphone = await connect(newIphone(url, await link(alice, "ios", "iPhone")), alice.id, 1);
    await connect(oldMacWithPhone(url, await link(alice, "mac", "MacBook")), alice.id, 3);
    const pixel = await connect(androidApp(url, await link(alice, "android", "Pixel"), "play"), alice.id, 4);

    const listed = (await agent.list()).envs;
    const by = (kind: string, name: string) => listed.find((e) => e.kind === kind && e.name === name)!;
    expect(by("ios", "Alice's iPhone")).toMatchObject({ online: true, foreground: true, capabilities: ["browser", "files", "photos", "calendar"] });
    // The phone on the Mac's USB is just an Android environment with everything debugging gives.
    expect(by("android", "Galaxy S23")).toMatchObject({ online: true, capabilities: expect.arrayContaining(["apps", "screen"]) });
    expect(by("mac", "Alice's MacBook").capabilities).toContain("browser");
    expect(by("android", "Pixel 8").capabilities).toEqual(["browser", "files", "photos", "calendar"]);
    // Ids are stable across reconnects and say nothing of the transport.
    for (const env of listed) expect(env.id).toMatch(/^(sandbox|(ios|android|mac):[a-z0-9]{8})$/);
    const before = by("ios", "Alice's iPhone").id;
    iphone.ws.close();
    await waitFor(async () => (await registry.list(alice.id)).find((e) => e.id === before && !e.online));
    await connect(newIphone(url, await link(alice, "ios", "iPhone again")), alice.id, 3);
    expect((await agent.list()).envs.find((e) => e.name === "Alice's iPhone")?.id).toBe(before);
    pixel.ws.close();
  });

  it("offers one fixed list of tools, each acting on the environment it is told", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18102);
    const agent = executor(runtime);
    const init = await agent.rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(init.result.serverInfo.name).toBe("aio_env");
    const tools = (await agent.rpc("tools/list")).result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>;
    expect(tools.map((t) => t.name)).toEqual(ENV_TOOLS.map((t) => t.name));
    for (const tool of tools.filter((t) => t.name !== "env_list")) expect(tool.inputSchema.required).toContain("env");
    for (const name of ["browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot", "files_list", "files_pull", "files_push", "photos_get", "calendar_events", "apps_list", "app_open", "screen_read", "screen_tap", "screen_shot", "shell_bash"]) {
      expect(tools.map((t) => t.name)).toContain(name);
    }
  });
});

describe("the iPhone", () => {
  it("drives the app's own browser and keeps what it shows in the workspace", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18103);
    const agent = executor(runtime);
    const iphone = await connect(newIphone(url, await link(alice, "ios", "iPhone")), alice.id, 1);
    const env = (await agent.list()).envs.find((e) => e.kind === "ios")!.id;

    expect(agent.text(await agent.call("browser_open", { env, url: "https://example.com" }))).toContain("Example");
    const read = agent.text(await agent.call("browser_read", { env }));
    expect(read).toContain("More information");
    expect(iphone.calls().map((c) => [c.env, c.tool])).toEqual([["IPHONE-VENDOR-ID", "browser_open"], ["IPHONE-VENDOR-ID", "browser_read"]]);

    const shot = await agent.call("browser_screenshot", { env });
    expect(shot.content.find((c) => c.type === "image")).toMatchObject({ mimeType: "image/png", data: PNG.toString("base64") });
    const file = [...saved.keys()].find((f) => f.endsWith(".png"))!;
    expect(file).toMatch(/^\/home\/gem\/workspace\//);
    expect(saved.get(file)).toEqual({ userId: alice.id, bytes: PNG });

    const photo = await agent.call("photos_get", { env, ids: ["P1"] });
    expect(photo.content.find((c) => c.type === "image")?.data).toBe(JPEG.toString("base64"));
    expect([...saved.keys()].some((f) => f.endsWith(".jpg"))).toBe(true);
  });

  it("moves files between the iPhone's folder and the workspace, inside the workspace only", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18104);
    const agent = executor(runtime);
    const iphone = await connect(device(url, await link(alice, "ios", "iPhone"), "Alice's iPhone", ({ path, body }) => {
      if (path === "/env/manifest") return { status: 200, body: { protocol: 1, envs: [{ deviceId: "IPHONE-VENDOR-ID", kind: "ios", name: "Alice's iPhone", capabilities: ["files"], foreground: true }] } };
      if (body?.tool === "files_list") return { status: 200, body: { ok: true, result: { files: [{ name: "boarding-pass.pdf", size: 4 }] } } };
      if (body?.tool === "files_pull") return { status: 200, body: { ok: true, result: { name: "boarding-pass.pdf", data: Buffer.from("%PDF").toString("base64") } } };
      if (body?.tool === "files_push") return { status: 200, body: { ok: true, result: { saved: body.arguments.name } } };
      return { status: 404 };
    }), alice.id, 1);
    const env = (await agent.list()).envs.find((e) => e.kind === "ios")!.id;
    expect(agent.text(await agent.call("files_list", { env }))).toContain("boarding-pass.pdf");
    expect(agent.text(await agent.call("files_pull", { env, name: "boarding-pass.pdf", to: "/home/gem/workspace/tasks/t1/" }))).toContain("/home/gem/workspace/tasks/t1/boarding-pass.pdf");
    expect(saved.get("/home/gem/workspace/tasks/t1/boarding-pass.pdf")?.bytes.toString()).toBe("%PDF");
    saved.set("/home/gem/workspace/out/report.pdf", { userId: alice.id, bytes: Buffer.from("%PDF-report") });
    expect((await agent.call("files_push", { env, path: "/home/gem/workspace/out/report.pdf" })).isError).toBeUndefined();
    expect(iphone.calls().at(-1)).toEqual({ env: "IPHONE-VENDOR-ID", tool: "files_push", arguments: { name: "report.pdf", data: Buffer.from("%PDF-report").toString("base64") } });
    // Nothing outside the workspace leaves for the phone, and nothing from it lands outside.
    expect((await agent.call("files_push", { env, path: "/etc/passwd" })).isError).toBe(true);
    expect((await agent.call("files_pull", { env, name: "boarding-pass.pdf", to: "/tmp/" })).isError).toBe(true);
  });

  it("reads an iPhone app from before protocol 1 through the same tools", async () => {
    const bob = await signIn("bob");
    const runtime = runtimeFor(bob.id, 18105);
    const agent = executor(runtime);
    const iphone = await connect(oldIphone(url, await link(bob, "ios", "iPhone")), bob.id, 1);
    const env = (await agent.list()).envs.find((e) => e.kind === "ios")!;
    // Only what was turned on there, and no browser or files: the old app has neither.
    expect(env.capabilities).toEqual(["photos", "calendar"]);
    expect(agent.text(await agent.call("calendar_events", { env: env.id, from: "2026-11-09", to: "2026-11-10" }))).toContain("Dentist");
    expect(iphone.seen.find((s) => s.path === "/ios/call")?.body).toEqual({ tool: "calendar_events", arguments: { from: "2026-11-09", to: "2026-11-10" } });
    const browser = await agent.call("browser_open", { env: env.id, url: "https://example.com" });
    expect(browser.isError).toBe(true);
    expect(agent.text(browser)).toMatch(/cannot browse|no browser/i);
  });

  it("asks the person on the iPhone before paying, and says so instead of trying again", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18106);
    const agent = executor(runtime);
    await connect(newIphone(url, await link(alice, "ios", "iPhone"), { confirm: true }), alice.id, 1);
    const env = (await agent.list()).envs.find((e) => e.kind === "ios")!.id;
    const out = await agent.call("browser_click", { env, ref: "pay" });
    expect(out.isError).toBe(true);
    expect(agent.text(out)).toMatch(/waiting for the user to confirm on the device/i);
    expect(agent.text(out)).toContain("Pay $12.00 to Example");
  });
});

describe("Android, however it is connected", () => {
  it("drives the phone on a Mac's USB with the same screen tools, translated for the Mac's bridge", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18107);
    const agent = executor(runtime);
    const mac = await connect(oldMacWithPhone(url, await link(alice, "mac", "MacBook")), alice.id, 2);
    const env = (await agent.list()).envs.find((e) => e.kind === "android")!.id;
    await agent.call("screen_tap", { env, x: 120, y: 640 });
    await agent.call("app_open", { env, app: "com.tencent.mm" });
    await agent.call("screen_type", { env, text: "hello" });
    const shot = await agent.call("screen_shot", { env });
    const sent = mac.seen.filter((s) => s.path === "/mcp" && s.body.method === "tools/call").map((s) => [s.body.params.name, s.body.params.arguments]);
    expect(sent).toEqual([
      ["mobile_click_on_screen_at_coordinates", { device: "R5CT40ABCDE", x: 120, y: 640 }],
      ["mobile_launch_app", { device: "R5CT40ABCDE", packageName: "com.tencent.mm" }],
      ["mobile_type_keys", { device: "R5CT40ABCDE", text: "hello", submit: false }],
      ["mobile_take_screenshot", { device: "R5CT40ABCDE" }],
    ]);
    expect(shot.content.find((c) => c.type === "image")?.data).toBe(PNG.toString("base64"));
  });

  it("gives a Play build no hands on other apps, and tells the agent what would", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18108);
    const agent = executor(runtime);
    const pixel = await connect(androidApp(url, await link(alice, "android", "Pixel"), "play"), alice.id, 1);
    const env = (await agent.list()).envs.find((e) => e.kind === "android")!.id;
    const out = await agent.call("screen_tap", { env, x: 1, y: 1 });
    expect(out.isError).toBe(true);
    expect(agent.text(out)).toMatch(/cannot operate other apps/i);
    expect(pixel.calls()).toEqual([]);
    expect((await agent.call("browser_open", { env, url: "https://example.com" })).isError).toBeUndefined();
    expect(pixel.calls()).toEqual([{ env: "android-id-pixel", tool: "browser_open", arguments: { url: "https://example.com" } }]);
  });

  it("treats the same phone on USB and in its own app as one environment, preferring the app, falling back to USB", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18109);
    const agent = executor(runtime);
    const mac = await connect(oldMacWithPhone(url, await link(alice, "mac", "MacBook")), alice.id, 2);
    const apk = await connect(androidApp(url, await link(alice, "android", "S23"), "apk"), alice.id, 2);
    await waitFor(async () => (await registry.list(alice.id)).filter((e) => e.kind === "android").length === 1 || undefined);
    const phones = (await agent.list()).envs.filter((e) => e.kind === "android");
    expect(phones).toHaveLength(1);
    await agent.call("screen_tap", { env: phones[0]!.id, x: 5, y: 6 });
    expect(apk.calls()).toEqual([{ env: "android-id-s23", tool: "screen_tap", arguments: { x: 5, y: 6 } }]);
    apk.ws.close();
    await waitFor(async () => (await registry.list(alice.id)).find((e) => e.kind === "android" && e.online) && (await registry.list(alice.id)).length);
    await agent.call("screen_tap", { env: phones[0]!.id, x: 7, y: 8 });
    expect(mac.seen.filter((s) => s.path === "/mcp" && s.body.method === "tools/call").at(-1)?.body.params).toEqual({ name: "mobile_click_on_screen_at_coordinates", arguments: { device: "R5CT40ABCDE", x: 7, y: 8 } });
  });
});

describe("boundaries", () => {
  it("never reaches another account's devices, and says what to do when a device is away", async () => {
    const alice = await signIn("alice");
    const bob = await signIn("bob");
    const aliceRuntime = runtimeFor(alice.id, 18110);
    const bobRuntime = runtimeFor(bob.id, 18111);
    const iphone = await connect(newIphone(url, await link(alice, "ios", "iPhone")), alice.id, 1);
    const aliceEnv = (await executor(aliceRuntime).list()).envs.find((e) => e.kind === "ios")!.id;
    const bobAgent = executor(bobRuntime);
    expect((await bobAgent.list()).envs.map((e) => e.kind)).toEqual(["sandbox"]);
    const stolen = await bobAgent.call("browser_open", { env: aliceEnv, url: "https://example.com" });
    expect(stolen.isError).toBe(true);
    expect(bobAgent.text(stolen)).toMatch(/no environment/i);
    expect(iphone.calls()).toEqual([]);
    // A forged capability URL is refused outright.
    expect((await fetch(aliceRuntime.env!.url.replace(/[a-f0-9]{64}/, "0".repeat(64)), { method: "POST", body: "{}" })).status).toBe(403);

    iphone.ws.close();
    await waitFor(async () => (await registry.list(alice.id)).find((e) => e.kind === "ios" && !e.online));
    const away = await executor(aliceRuntime).call("browser_read", { env: aliceEnv });
    expect(away.isError).toBe(true);
    expect(executor(aliceRuntime).text(away)).toMatch(/open the app/i);
  });
});

describe("choosing the environment", () => {
  it("tells each turn what is online, and that the device the person is using comes first for its own things", async () => {
    const alice = await signIn("alice");
    const iphone = await connect(newIphone(url, await link(alice, "ios", "iPhone"), { foreground: false }), alice.id, 1);
    const listed = await registry.list(alice.id);
    const fromPhone = envBrief(listed, "ios");
    expect(fromPhone).toContain("Alice's iPhone");
    expect(fromPhone).not.toMatch(/using it now/i);
    // The app comes to the foreground: the device says so, and the brief puts it first.
    iphone.push("manifest", { protocol: 1, envs: [{ deviceId: "IPHONE-VENDOR-ID", kind: "ios", name: "Alice's iPhone", capabilities: ["browser", "files", "photos", "calendar"], foreground: true }] });
    await waitFor(async () => (await registry.list(alice.id)).find((e) => e.kind === "ios" && e.foreground));
    const now = envBrief(await registry.list(alice.id), "ios");
    expect(now).toMatch(/Alice's iPhone.*using it now/is);
    // A message typed on the web does not make the phone the first choice.
    expect(envBrief(await registry.list(alice.id), "web")).not.toMatch(/using it now/i);
    expect(ENV_POLICY).toMatch(/scheduled runs stay in the sandbox/i);
  });
});

describe("rollout without breaking anything", () => {
  it("wires aio_env instead of aio_ios and aio_mac_native only when PA_EXEC_ENVS is on", async () => {
    const alice = await signIn("alice");
    await link(alice, "ios", "iPhone");
    await link(alice, "mac", "MacBook");
    const off = memberConfig(h.ctx.cfg, alice.id, 18112);
    gateway.provision(off);
    expect(envThreadServers(off)).toEqual({});
    expect(off.ios?.url).toBeTruthy();
    expect(off.macNative?.url).toBeTruthy();

    const on = memberConfig({ ...h.ctx.cfg, execEnvs: true }, alice.id, 18113);
    gateway.provision(on);
    expect(Object.keys(envThreadServers(on))).toEqual(["aio_env"]);
    expect(envMcpServers(on)).toEqual({ aio_env: { type: "http", url: on.env!.url } });
    expect(on.ios).toBeUndefined();
    expect(on.macNative).toBeUndefined();
    expect(codexRequirementsToml(on)).toContain(on.env!.url);
  });
});
