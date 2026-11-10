import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { login } from "../helpers/harness.js";
import { startEnvWorld, waitFor } from "../helpers/envs.js";
import { callTimeoutMs, HUMAN_WAIT_MS, type EnvRegistry } from "../../src/control/envs/registry.js";
import { ENV_TOOLS, envMcpServers, envThreadServers } from "../../src/control/envs/gateway.js";
import { ENV_POLICY, envBrief } from "../../src/control/envs/policy.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { memberConfig } from "../../src/control/tenants.js";

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

let world: Awaited<ReturnType<typeof startEnvWorld>>;
let h: typeof world.h;
let gateway: typeof world.gateway;
let registry: EnvRegistry;
let saved: typeof world.saved;
let url: string;
const signIn = (username: string) => world.signIn(username);
const link = (who: { headers: Record<string, string> }, kind: "mac" | "ios" | "android", name: string) => world.link(who, kind, name);
const runtimeFor = (userId: string, port: number) => world.runtimeFor(userId, port);
const executor = (runtime: { env?: { url: string } }) => world.executor(runtime);
const local = (address: string) => world.local(address);

beforeEach(async () => {
  world = await startEnvWorld();
  ({ h, gateway, registry, saved, url } = world);
});

afterEach(async () => {
  await world.close();
});

/** Connect a stand-in and wait until the registry has read what it offers. */
async function connect(stand: ReturnType<typeof device>, userId: string, count: number) {
  world.devices.push(stand.ws);
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

  it("makes the side-loaded app and the same phone on a Mac's USB (protocol 1) one environment by its adb serial", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18113);
    const agent = executor(runtime);
    // The Mac app's bridge (bin/mac-env.mjs) names a USB phone by its serial; the APK (PhoneControl.kt) gives the same serial as an alias.
    const mac = await connect(device(url, await link(alice, "mac", "MacBook"), "Alice's MacBook", ({ method, path, body }) => {
      if (method === "GET" && path === "/env/manifest") {
        return { status: 200, body: { protocol: 1, envs: [
          { deviceId: "MAC-HW-ID", kind: "mac", name: "Alice's MacBook", capabilities: ["browser"], foreground: false },
          { deviceId: "R5CT40ABCDE", kind: "android", name: "Galaxy S23", capabilities: ["apps", "screen"], foreground: false },
        ] } };
      }
      if (method === "POST" && path === "/env/call") return { status: 200, body: { ok: true, result: { text: `Mac did ${body.tool}` } } };
      return { status: 404 };
    }), alice.id, 2);
    const apk = await connect(androidApp(url, await link(alice, "android", "S23"), "apk"), alice.id, 2);
    await waitFor(async () => (await registry.list(alice.id)).filter((e) => e.kind === "android").length === 1 || undefined);
    const phones = (await agent.list()).envs.filter((e) => e.kind === "android");
    expect(phones).toHaveLength(1);
    expect(phones[0]!.capabilities).toEqual(expect.arrayContaining(["browser", "files", "apps", "screen"]));
    await agent.call("screen_read", { env: phones[0]!.id });
    expect(apk.calls()).toEqual([{ env: "android-id-s23", tool: "screen_read", arguments: {} }]);
    expect(mac.calls()).toEqual([]);
    // The app goes (Stop, uninstalled): the same environment carries on over the Mac's USB.
    apk.ws.close();
    await waitFor(async () => (await registry.list(alice.id)).find((e) => e.kind === "android" && e.online && !e.capabilities.includes("browser")) || undefined);
    expect(agent.text(await agent.call("screen_read", { env: phones[0]!.id }))).toContain("Mac did screen_read");
    expect(mac.calls()).toEqual([{ env: "R5CT40ABCDE", tool: "screen_read", arguments: {} }]);
    expect((await agent.list()).envs.filter((e) => e.kind === "android").map((e) => e.id)).toEqual([phones[0]!.id]);
  });

  it("takes a file larger than one device message in parts, up to the workspace's limit", async () => {
    const alice = await signIn("alice");
    const runtime = runtimeFor(alice.id, 18112);
    const agent = executor(runtime);
    const MB = 1024 * 1024;
    const files: Record<string, Buffer> = { "video.mp4": Buffer.alloc(13 * MB, 7), "huge.zip": Buffer.alloc(21 * MB) };
    files["video.mp4"]!.write("start", 0);
    files["video.mp4"]!.write("end", 13 * MB - 3);
    const pixel = await connect(device(url, await link(alice, "android", "Pixel"), "Pixel 8", ({ path, body }) => {
      if (path === "/env/manifest") return { status: 200, body: { protocol: 1, envs: [{ deviceId: "android-id-pixel", kind: "android", name: "Pixel 8", capabilities: ["files"], foreground: true }] } };
      const { name, offset, length } = body.arguments as { name: string; offset: number; length: number };
      const file = files[name]!;
      return { status: 200, body: { ok: true, result: { name, data: file.subarray(offset, offset + length).toString("base64"), offset, size: file.length } } };
    }), alice.id, 1);
    const env = (await agent.list()).envs.find((e) => e.kind === "android")!.id;

    const out = await agent.call("files_pull", { env, name: "video.mp4", to: "/home/gem/workspace/in/" });
    expect(agent.text(out)).toContain(`Saved /home/gem/workspace/in/video.mp4 (${13 * MB} bytes)`);
    expect(saved.get("/home/gem/workspace/in/video.mp4")?.bytes.equals(files["video.mp4"]!)).toBe(true);
    // Each part fits in one message from a phone; the device is asked for the next one where the last ended.
    expect(pixel.calls().map((c) => c.arguments)).toEqual([0, 6, 12].map((at) => ({ name: "video.mp4", offset: at * MB, length: 6 * MB })));

    const big = await agent.call("files_pull", { env, name: "huge.zip" });
    expect(big.isError).toBe(true);
    expect(agent.text(big)).toMatch(/larger than 20 MB/);
    expect(pixel.calls()).toHaveLength(4);
  });
});

describe("patience", () => {
  it("waits for the person as long as the device does, and the executor waits longer than any call", () => {
    // The apps wait ten minutes in browser_request_human; hanging up before them would lose the person's work.
    expect(callTimeoutMs("browser_request_human", {})).toBeGreaterThan(HUMAN_WAIT_MS);
    expect(callTimeoutMs("shell_bash", { timeout_sec: 240 })).toBeGreaterThan(240_000);
    expect(callTimeoutMs("shell_bash", { timeout_sec: 99_999 })).toBe(callTimeoutMs("shell_bash", { timeout_sec: 240 }));
    expect(callTimeoutMs("browser_read", {})).toBe(120_000);
    const wired = envThreadServers({ env: { url: "http://gateway/env" } } as never) as { aio_env: { tool_timeout_sec: number } };
    for (const [tool, args] of [["browser_request_human", {}], ["shell_bash", { timeout_sec: 240 }], ["photos_get", {}]] as const) {
      expect(wired.aio_env.tool_timeout_sec * 1000).toBeGreaterThan(callTimeoutMs(tool, args));
    }
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
    expect((await fetch(local(aliceRuntime.env!.url).replace(/[a-f0-9]{64}/, "0".repeat(64)), { method: "POST", body: "{}" })).status).toBe(403);

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

describe("the brief at the start of a turn", () => {
  it("reaches the executor, with the device the message was typed on first", async () => {
    const owner = await login(h);
    const headers = { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" };
    Object.assign(h.ctx.cfg, { execEnvs: true, env: { url: "http://host.docker.internal:0/env/x/mcp" } });
    h.ctx.tasks.setEnvs((id) => registry.snapshot(id));
    Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "照片", related: [], dependencies: [], resources: [] }) });
    const ownerId = h.ctx.cfg.runtimeUserId!;
    await connect(newIphone(url, await link({ headers }, "ios", "iPhone")), ownerId, 1);
    const sent = await h.request("/api/tasks", { method: "POST", headers: { ...headers, "x-client-platform": "ios" }, body: JSON.stringify({ text: "把这张照片发给我", clientMessageId: "from-phone" }) });
    expect(sent.status).toBe(202);
    const turn = await waitFor(() => h.codex.startedTurns.at(-1));
    expect(turn.text).toContain("Execution environments now");
    expect(turn.text).toMatch(/Alice's iPhone \(ios:[a-z0-9]{8}, ios\): online, app on screen; browser, files, photos, calendar — the user is using it now/);
    // A message from the web lists the phone without putting it first.
    await h.request("/api/tasks", { method: "POST", headers: { ...headers, "x-client-platform": "web" }, body: JSON.stringify({ text: "查一下天气", clientMessageId: "from-web" }) });
    const second = await waitFor(() => h.codex.startedTurns.length > 1 ? h.codex.startedTurns.at(-1) : undefined);
    expect(second.text).toContain("Alice's iPhone");
    expect(second.text).not.toMatch(/using it now/);
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

    // PA_EXEC_ENVS=owner: the owner's runtime has them, every other account stays as it was.
    const ownerOnly = memberConfig({ ...h.ctx.cfg, execEnvs: true, execEnvsOwnerOnly: true }, alice.id, 18114);
    expect(ownerOnly.execEnvs).toBe(false);
    gateway.provision(ownerOnly);
    expect(envThreadServers(ownerOnly)).toEqual({});
    expect(ownerOnly.ios?.url).toBeTruthy();
  });
});
