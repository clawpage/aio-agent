import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startEnvWorld, waitFor } from "../helpers/envs.js";
// @ts-expect-error plain ESM script without types
import { findTmux } from "../../bin/mac-shell.mjs";

/**
 * The Mac app's bridge speaking device protocol 1 (docs/EXEC-ENVS.md) end to end: the real
 * bin/phone-bridge.mjs, linked to a local control plane over a real device-link socket, with fakes
 * only at the edge (adb, mobile-mcp, Chrome and chrome-devtools-mcp, a tmux server of the test's own).
 * The executor's side is aio_env, as the agent calls it.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures");
const BRIDGE = path.join(ROOT, "bin/phone-bridge.mjs");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("phone-pixels")]);
const S23 = { serial: "R5CT40ABCDE", model: "SM-S918", name: "Galaxy S23" };
const PIXEL = { serial: "37151FDJH00ABC", model: "Pixel 8", name: "null" };
// The bridge checks every 3 s what it offers; a manifest event follows within that.
const CHANGE_MS = 15_000;
const tmux = findTmux() as string | null;

let world: Awaited<ReturnType<typeof startEnvWorld>>;
let dir: string;
let tmuxDir: string;
const bridges: ChildProcess[] = [];

beforeEach(async () => {
  world = await startEnvWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-env-"));
  // tmux's socket path must stay short: a directory of its own.
  tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-"));
  for (const sub of ["home", "tmp", "runtime"]) fs.mkdirSync(path.join(dir, sub));
  // The phone runtime as the Mac app installs it, with the fakes in place of mobile-mcp and chrome-devtools-mcp.
  const entry = (rel: string, fixture: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, "runtime/mobile-mcp/node_modules", rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "runtime/mobile-mcp/node_modules", rel), `import ${JSON.stringify(path.join(FIXTURES, fixture))};\n`);
  };
  entry("@mobilenext/mobile-mcp/lib/index.js", "fake-mobile-mcp.mjs");
  entry("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", "fake-devtools-mcp.mjs");
  fs.writeFileSync(path.join(dir, "adb"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, "fake-adb.mjs")}" "$@"\n`, { mode: 0o755 });
  // Never the bridge's real tmux server (socket aio-agent): the same name, in a directory of the test's own.
  if (tmux) fs.writeFileSync(path.join(dir, "tmux"), `#!/bin/sh\nTMUX_TMPDIR="${tmuxDir}" exec "${tmux}" "$@"\n`, { mode: 0o755 });
  plug([S23]);
});

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(stop));
  await world.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmuxDir, { recursive: true, force: true });
});

/** The phones on the Mac's USB from now on. */
function plug(phones: Array<{ serial: string; model: string; name: string }>) {
  fs.writeFileSync(path.join(dir, "adb.json"), JSON.stringify({ phones }));
}

/** Chrome installed on the Mac (or not). */
function chrome(installed: boolean) {
  const file = path.join(dir, "chrome");
  if (installed) fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, "fake-chrome.mjs")}" "$@"\n`, { mode: 0o755 });
  else fs.rmSync(file, { force: true });
}

/** The bridge as the Mac app runs it (phone_link.rs), linked with `token`. */
function bridge(token: string, shell = false) {
  const { PA_PHONE_SERIAL: _serial, ...inherited } = process.env;
  const proc = spawn(process.execPath, [BRIDGE], {
    env: {
      ...inherited,
      PA_PHONE_DIR: path.join(dir, "runtime"),
      PA_ADB: path.join(dir, "adb"),
      PA_PHONE_BRIDGE_PORT: "0",
      PA_PHONE_BRIDGE_BIND: "127.0.0.1",
      PHONE_BRIDGE_TOKEN: crypto.randomBytes(16).toString("hex"),
      PA_DEVICE_LINK_URL: world.url,
      PA_DEVICE_LINK_TOKEN: token,
      PA_DEVICE_NAME: "Alice's MacBook",
      PA_MAC_SHELL: shell ? "1" : "0",
      PA_AI_CHROME_PATH: path.join(dir, "chrome"),
      ...(tmux ? { PA_TMUX: path.join(dir, "tmux") } : {}),
      HOME: path.join(dir, "home"),
      TMPDIR: path.join(dir, "tmp"),
      FAKE_ADB_STATE: path.join(dir, "adb.json"),
      FAKE_MOBILE_LOG: path.join(dir, "mobile.jsonl"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  bridges.push(proc);
  return proc;
}

function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { proc.once("exit", () => resolve()); proc.kill("SIGTERM"); });
}

/** A Mac app from before protocol 1 on the same link: no manifest, its phone from /status. */
function oldBridge(token: string) {
  const ws = new WebSocket(world.url, { headers: { authorization: `Bearer ${token}`, "x-aio-device-name": encodeURIComponent("Alice's MacBook") } });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as { t: string; id: number; path: string };
    if (msg.t !== "req") return;
    const answer = msg.path === "/status" ? { status: 200, body: { device: { serial: S23.serial, model: S23.model, name: S23.name } } }
      : msg.path === "/shell/status" ? { status: 200, body: { enabled: false, tmux: true } }
      : { status: 404, body: {} };
    ws.send(JSON.stringify({ t: "res", id: msg.id, status: answer.status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(answer.body)).toString("base64") }));
  });
  world.devices.push(ws);
  return ws;
}

const mobileCalls = () => {
  try { return fs.readFileSync(path.join(dir, "mobile.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as [string, Record<string, unknown>]); } catch { return []; }
};

async function aliceWithMac() {
  const alice = await world.signIn("alice");
  const agent = world.executor(world.runtimeFor(alice.id, 18301), { "X-AIO-Task": "task_mac_1" });
  const token = await world.link(alice, "mac", "MacBook");
  return { alice, agent, token };
}

const envs = async (agent: ReturnType<typeof world.executor>) => (await agent.list()).envs;

describe("the Mac app's bridge speaks protocol 1", () => {
  it("ships in the Mac app with every module it imports", () => {
    const resources = (JSON.parse(fs.readFileSync(path.join(ROOT, "src/ui/tauri/src-tauri/tauri.macos.conf.json"), "utf8")) as { bundle: { resources: Record<string, string> } }).bundle.resources;
    const bundled = new Set(Object.values(resources));
    const local = (file: string) => [...fs.readFileSync(path.join(ROOT, "bin", file), "utf8").matchAll(/^import .* from "\.\/([^"]+)";$/gm)].map((m) => m[1]!);
    const needed = new Set(["phone-bridge.mjs"]);
    for (const file of needed) for (const dep of local(file)) needed.add(dep);
    for (const file of needed) expect(bundled).toContain(`phone/${file}`);
  });

  it("lists the Mac and the phone on its USB by what they can do, with the ids they had before", async () => {
    const { alice, agent, token } = await aliceWithMac();
    // The same Mac and phone read through the old adapter first.
    const old = oldBridge(token);
    const before = await waitFor(async () => { const l = await envs(agent); return l.filter((e) => e.online).length === 3 && l; });
    old.close();
    await waitFor(async () => (await envs(agent)).every((e) => e.kind === "sandbox" || !e.online) || undefined);

    chrome(false);
    bridge(token);
    const listed = await waitFor(async () => { const l = await envs(agent); return l.filter((e) => e.online).length === 3 && l; }, CHANGE_MS);
    const mac = listed.find((e) => e.kind === "mac")!;
    const phone = listed.find((e) => e.kind === "android")!;
    // Updating the app keeps both ids: one environment each, not a second one beside the old.
    expect(listed).toHaveLength(3);
    expect(mac.id).toBe(before.find((e) => e.kind === "mac")!.id);
    expect(phone.id).toBe(before.find((e) => e.kind === "android")!.id);
    expect(phone).toMatchObject({ name: "Galaxy S23", online: true, capabilities: ["apps", "screen"] });
    // No Chrome on this Mac and the terminal off: nothing the agent can do there yet, and it is told why.
    expect(mac).toMatchObject({ name: "Alice's MacBook", online: true, capabilities: [] });
    const off = await agent.call("shell_bash", { env: mac.id, command: "touch should-not-exist" });
    expect(off.isError).toBe(true);
    expect(agent.text(off)).toMatch(/turns it on in the Mac app/);
    expect(fs.existsSync(path.join(dir, "home/should-not-exist"))).toBe(false);

    // The phone is a standard Android environment: aio_env's tools, mobile-mcp's on the Mac, by its serial.
    await agent.call("screen_tap", { env: phone.id, x: 120, y: 640 });
    await agent.call("app_open", { env: phone.id, app: "com.tencent.mm" });
    await agent.call("screen_type", { env: phone.id, text: "你好", submit: true });
    const shot = await agent.call("screen_shot", { env: phone.id });
    expect(shot.content.find((c) => c.type === "image")?.data).toBe(PNG.toString("base64"));
    expect(mobileCalls()).toEqual([
      ["mobile_click_on_screen_at_coordinates", { device: S23.serial, x: 120, y: 640 }],
      ["mobile_launch_app", { device: S23.serial, packageName: "com.tencent.mm" }],
      ["mobile_type_keys", { device: S23.serial, text: "你好", submit: true }],
      ["mobile_take_screenshot", { device: S23.serial }],
    ]);
    expect([...world.saved.keys()].some((k) => k.includes("/device-shots/android-screen_shot-"))).toBe(true);

    // Chrome installed: the Mac says so at once, and the agent browses in it.
    chrome(true);
    await waitFor(async () => (await envs(agent)).find((e) => e.id === mac.id)?.capabilities.includes("browser") || undefined, CHANGE_MS);
    const opened = await agent.call("browser_open", { env: mac.id, url: "https://example.com/" });
    expect(opened.isError).toBeUndefined();
    expect(JSON.parse(agent.text(opened))).toMatchObject({ page: expect.any(Number) });
    // The task's page is on its card, for the person to watch and take over.
    expect(world.mac.browser.view(alice.id, "task_mac_1")).toMatchObject({ page: true, holder: "ai" });
    const read = await agent.call("browser_read", { env: mac.id });
    expect(agent.text(read)).toMatch(/take_snapshot/);
    await world.mac.browser.control(alice.id, "task_mac_1", "take");
    const held = await agent.call("browser_read", { env: mac.id });
    expect(held.isError).toBe(true);
    await world.mac.browser.control(alice.id, "task_mac_1", "release");
  }, 90_000);

  it("adds and drops phones as they are plugged in and out", async () => {
    const { agent, token } = await aliceWithMac();
    bridge(token);
    await waitFor(async () => (await envs(agent)).filter((e) => e.online).length === 3 || undefined, CHANGE_MS);
    plug([S23, PIXEL]);
    const two = await waitFor(async () => { const l = (await envs(agent)).filter((e) => e.kind === "android" && e.online); return l.length === 2 && l; }, CHANGE_MS);
    // A phone without a name of its own is called by its model.
    expect(two.map((e) => e.name).sort()).toEqual(["Galaxy S23", "Pixel 8"]);
    plug([PIXEL]);
    const gone = two.find((e) => e.name === "Galaxy S23")!;
    await waitFor(async () => (await envs(agent)).find((e) => e.id === gone.id)?.online === false || undefined, CHANGE_MS);
    const out = await agent.call("screen_tap", { env: gone.id, x: 1, y: 1 });
    expect(out.isError).toBe(true);
    expect(agent.text(out)).toMatch(/not reachable/);
  }, 90_000);

  it.skipIf(!tmux)("runs the task's commands in its own shell once the person turned the terminal on, and keeps the old endpoints", async () => {
    const { alice, agent, token } = await aliceWithMac();
    bridge(token, true);
    const mac = await waitFor(async () => (await envs(agent)).find((e) => e.kind === "mac" && e.online && e.capabilities.includes("shell")), CHANGE_MS);
    const ran = await agent.call("shell_bash", { env: mac.id, command: "cd /tmp && export GREETING=hi && echo $GREETING" });
    expect(ran.isError).toBeUndefined();
    expect(agent.text(ran)).toMatch(/hi/);
    // The same task, the same shell: its directory and variables stay.
    expect(agent.text(await agent.call("shell_bash", { env: mac.id, command: "echo $GREETING in $(pwd)" }))).toMatch(/hi in (\/private)?\/tmp/);
    await agent.call("shell_write", { env: mac.id, path: "~/note.txt", content: "one\n" });
    await agent.call("shell_edit", { env: mac.id, path: "~/note.txt", old_text: "one", new_text: "two" });
    expect(fs.readFileSync(path.join(dir, "home/note.txt"), "utf8")).toBe("two\n");

    // An old control plane (or one with the environments off) still reaches what it did.
    const tunnel = world.links.tunnelFor(alice.id)!;
    const status = JSON.parse((await tunnel.request("GET", "/status", { timeoutMs: 15_000 })).body.toString("utf8"));
    expect(status.device).toMatchObject({ serial: S23.serial, name: "Galaxy S23" });
    expect(JSON.parse((await tunnel.request("GET", "/shell/status", { timeoutMs: 15_000 })).body.toString("utf8"))).toEqual({ enabled: true, tmux: true });
  }, 90_000);
});
