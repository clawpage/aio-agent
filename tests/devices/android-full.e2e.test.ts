import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transformWithOxc } from "vite";
import WebSocket from "ws";
import { startEnvWorld, waitFor } from "../helpers/envs.js";

/**
 * The side-loaded Android app (AIO_ANDROID_DIST=full, docs/EXEC-ENVS.md) in the emulator: paired with the emulator's
 * own wireless debugging, its shell helper running, and the agent using other apps and the screen, linked to a local
 * control plane. Not part of `npm test`: it needs a booted emulator, the full debug build and the network.
 *
 *   (cd src/ui/tauri && AIO_ANDROID_DIST=full env -u NODE_ENV npm run -- tauri android build --debug --target aarch64 --apk)
 *   AIO_ANDROID_FULL_E2E=1 npx vitest run tests/devices/android-full.e2e.test.ts
 *
 * `AIO_ANDROID_FULL_APK` names another APK, `AIO_ANDROID_SERIAL` the emulator (default `emulator-5554`); it only ever
 * talks to that serial. The emulator's Wi-Fi must be one it has allowed wireless debugging on before ("Always allow on
 * this network", once by hand). Each apps and screen tool is also asked of mobile-mcp (what a Mac's USB phone answers
 * with, bin/mac-env.mjs) for the same emulator, through an adb that reaches only that serial, and the two answers are
 * compared; that part needs the Mac app's phone runtime (`AIO_MOBILE_MCP`, default the installed one).
 */
const RUN = process.env.AIO_ANDROID_FULL_E2E === "1";
const APK = process.env.AIO_ANDROID_FULL_APK ?? path.resolve("src/ui/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk");
const SERIAL = process.env.AIO_ANDROID_SERIAL ?? "emulator-5554";
const PACKAGE = process.env.AIO_ANDROID_FULL_PACKAGE ?? "ai.clawpage.agent.full";
const HOST = "10.0.2.2";
const OUT = path.resolve("var/.device-e2e/android-full");
const SDK = process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
const MOBILE_MCP = process.env.AIO_MOBILE_MCP ?? `${process.env.HOME}/Library/Application Support/ai.clawpage.agent/phone/mobile-mcp/node_modules/@mobilenext/mobile-mcp/lib/index.js`;

const adb = (...args: string[]) => execFileSync(`${SDK}/platform-tools/adb`, ["-s", SERIAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const sh = (command: string) => adb("shell", command);

/** mobile-mcp as the Mac app's bridge runs it, on this emulator only: its adb is a wrapper that refuses any other serial. */
function macAdapter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-guard-adb-"));
  fs.mkdirSync(path.join(dir, "platform-tools"));
  const wrapper = path.join(dir, "platform-tools", "adb");
  fs.writeFileSync(wrapper, `#!/bin/bash
REAL='${SDK}/platform-tools/adb'
if [ "$1" = "-s" ]; then [ "$2" = '${SERIAL}' ] || { echo "refused $2" >&2; exit 1; }; exec "$REAL" "$@"; fi
case "$1" in devices) "$REAL" devices "\${@:2}" | grep -E '^(List|${SERIAL}[[:space:]])'; exit 0 ;; version|start-server) exec "$REAL" "$@" ;; esac
exec "$REAL" -s '${SERIAL}' "$@"
`, { mode: 0o755 });
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [MOBILE_MCP], {
    env: { ...process.env, PATH: `${path.dirname(wrapper)}:${process.env.PATH}`, ANDROID_HOME: dir, ANDROID_SDK_ROOT: dir, MOBILEMCP_DISABLE_TELEMETRY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => {
    buffer += d;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try { const m = JSON.parse(line) as { id: number }; waiting.get(m.id)?.(m); } catch { /* a log line */ }
    }
  });
  let id = 0;
  const rpc = (method: string, params: object) => new Promise<any>((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
  // mobilecli names an emulator by its AVD, a phone by its serial.
  const device = sh("getprop ro.boot.qemu.avd_name").trim() || SERIAL;
  const ready = rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } })
    .then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`));
  return {
    /** One mobile-mcp tool, its answer as the Mac's adapter passes it on (fromRpc: the text, or an image and its text). */
    async call(name: string, args: object = {}) {
      await ready;
      const reply = await rpc("tools/call", { name, arguments: { device, ...args } });
      const content = (reply.result?.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      // mobilecli's own server holds the accessibility service; the app's screen_read needs it back.
      try { sh("pkill -f '[D]eviceServer'"); } catch { /* not running */ }
      return { isError: Boolean(reply.result?.isError || reply.error), text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), image: content.find((c) => c.type === "image") };
    },
    close() { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

describe.skipIf(!RUN)("the side-loaded Android app runs the phone's apps and screen, on the emulator", () => {
  let world: Awaited<ReturnType<typeof startEnvWorld>>;
  let agent: ReturnType<typeof world.executor>;
  let env: string;
  let mac: ReturnType<typeof macAdapter> | null = null;
  const launch = (...extras: string[]) => adb("shell", "am", "start", "-W", "-n", `${PACKAGE}/ai.clawpage.agent.MainActivity`, ...extras);
  /** Every window's elements (a heads-up notification is a window of its own, and would hide the app's from a plain dump). */
  const screen = () => {
    adb("shell", "uiautomator", "dump", "--windows", "/sdcard/aio-ui.xml");
    return [...adb("shell", "cat", "/sdcard/aio-ui.xml").matchAll(/<node [^>]*>/g)].map((m) => m[0]);
  };
  const center = (node: string) => {
    const [x1, y1, x2, y2] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)!.slice(1).map(Number);
    return [Math.round((x1! + x2!) / 2), Math.round((y1! + y2!) / 2)] as const;
  };
  const tapOn = async (match: RegExp, ms = 30_000) => {
    const [x, y] = center(await waitFor(() => screen().find((n) => match.test(n)), ms));
    adb("shell", "input", "tap", String(x), String(y));
  };
  /** Scrolls down a list until an element shows, and taps it. */
  const scrollToAndTap = async (match: RegExp) => {
    for (let i = 0; i < 15; i++) {
      const node = screen().find((n) => match.test(n));
      if (node) { const [x, y] = center(node); adb("shell", "input", "tap", String(x), String(y)); return; }
      adb("shell", "input", "swipe", "540", "1800", "540", "800", "300");
    }
    throw new Error(`${match} never showed`);
  };
  const shot = (name: string) => fs.writeFileSync(path.join(OUT, name), execFileSync(`${SDK}/platform-tools/adb`, ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }));
  const text = (out: Parameters<typeof agent.text>[0] & { isError?: boolean }) => {
    if (out.isError) throw new Error(agent.text(out));
    return agent.text(out);
  };
  const capabilities = async () => (await agent.list()).envs.find((e) => e.id === env)!.capabilities;

  /** The console in the app (the deployed one), with this build's deviceTools.ts, talking to the app's real listener. */
  let devtools: { ask: (message: object) => Promise<Record<string, any>>; close: () => void } | null = null;
  const ask = async (message: object) => {
    if (!devtools) {
      const pid = adb("shell", "pidof", PACKAGE).trim();
      const forward = adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`).trim();
      const page = await waitFor(async () => ((await (await fetch(`http://127.0.0.1:${forward}/json`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>)
        .find((p) => p.type === "page" && p.url.startsWith("https://agent.clawpage.ai/")), 60_000);
      const cdp = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((done) => cdp.once("open", done));
      let id = 0;
      const run = (expression: string) => new Promise<any>((resolve, reject) => {
        const mine = ++id;
        cdp.on("message", function answer(raw) {
          const m = JSON.parse(String(raw)) as { id: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
          if (m.id !== mine) return;
          cdp.off("message", answer);
          if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails))); else resolve(m.result?.result?.value);
        });
        cdp.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      const source = (await transformWithOxc(fs.readFileSync(path.resolve("src/ui/src/deviceTools.ts"), "utf8"), "deviceTools.ts")).code.replace(/^export /gm, "");
      devtools = {
        // The console reloads now and then (a fresh install signs out): the app's listener comes back with each page, this copy of deviceTools.ts is put in again.
        ask: async (m) => {
          await waitFor(() => run("Boolean(window.aioDeviceTools)"), 60_000);
          return JSON.parse(await run(`(window.__dt ??= (() => { ${source}; return { askDeviceTools }; })()).askDeviceTools(${JSON.stringify(m)}).then(JSON.stringify, (e) => JSON.stringify({ refused: e.message }))`)) as Record<string, any>;
        },
        close: () => { cdp.close(); adb("forward", "--remove", `tcp:${forward}`); },
      };
    }
    return devtools.ask(message);
  };
  /** The app's state for the console's Android settings, whatever page the app shows. */
  const control = async () => {
    const state = await ask({ type: "status" });
    if (!state.control) throw new Error(`no control in ${JSON.stringify(state)}`);
    return state.control as { state: string; paired: boolean; error: string | null; shellUid: number | null; wirelessDebugging: boolean };
  };
  const helperRunning = () => sh("ps -A -o ARGS").includes("ai.clawpage.agent.ShellHelper");

  beforeAll(async () => {
    if (!adb("get-state").includes("device")) throw new Error(`${SERIAL} is not ready`);
    if (!fs.existsSync(APK)) throw new Error(`no full debug build at ${APK}`);
    fs.mkdirSync(OUT, { recursive: true });
    world = await startEnvWorld();
    const alice = await world.signIn("alice");
    const token = await world.link(alice, "android", "Pixel");
    agent = world.executor(world.runtimeFor(alice.id, 18311));
    adb("install", "-r", APK);
    adb("shell", "pm", "clear", PACKAGE);
    adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS");
    // Developer options on, wireless debugging off and no helper left from an earlier run.
    sh("settings put global development_settings_enabled 1; settings put global adb_wifi_enabled 0; pkill -f '[a]i.clawpage.agent.ShellHelper'; cmd statusbar collapse; true");
    const port = new URL(world.url).port;
    world.h.ctx.cfg.allowedHosts.push(`${HOST}:${port}`);
    world.h.ctx.cfg.primaryHost = HOST;
    launch("--es", "AIODeviceToolsLinkURL", world.url.replace("localhost", HOST), "--es", "AIODeviceToolsLinkToken", token);
    env = (await waitFor(async () => (await agent.list()).envs.find((e) => e.kind === "android" && e.online), 60_000)).id;
  }, 180_000);

  afterAll(async () => {
    mac?.close();
    try { devtools?.close(); } catch { /* gone */ }
    try { sh("settings put global adb_wifi_enabled 0; pkill -f '[a]i.clawpage.agent.ShellHelper'; true"); adb("shell", "am", "force-stop", PACKAGE); } catch { /* gone */ }
    await world?.close();
  });

  it("offers only the Play build's tools until the phone is paired", async () => {
    expect(await capabilities()).toEqual(["browser", "files", "photos"]);
    expect(await control()).toMatchObject({ state: "off", paired: false });
  });

  it("pairs with the code from the phone's own wireless debugging, and its adb is the shell user", async () => {
    expect((await ask({ type: "control", action: "pair" })).control).toMatchObject({ state: "pairing" });
    // The app opened Developer options; this network was allowed before, so wireless debugging can be switched on here.
    await waitFor(() => screen().some((n) => /text="Use developer options"/.test(n)), 30_000);
    await scrollToAndTap(/text="Wireless debugging"/);
    sh("settings put global adb_wifi_enabled 1");
    await tapOn(/text="Pair device with pairing code"/);
    const code = /text="(\d{6})"/.exec(await waitFor(() => screen().find((n) => /text="\d{6}"/.test(n)), 30_000))![1]!;
    shot("pairing-dialog.png");
    // The notification's reply, in a debug build: the dialog stays open meanwhile. Android lets an app start its
    // foreground service from a notification's action; a broadcast from adb needs the same allowance by hand.
    sh(`cmd deviceidle tempwhitelist -d 10000 ${PACKAGE}`);
    sh(`am broadcast -a ai.clawpage.agent.DEBUG_PAIR -p ${PACKAGE} --es code ${code}`);
    const state = await waitFor(async () => { const c = await control(); return c?.shellUid === 2000 && c.state === "running" && c; }, 90_000);
    expect(state).toMatchObject({ paired: true, error: null, wirelessDebugging: true });
    expect(sh(`dumpsys package ${PACKAGE}`)).toMatch(/android\.permission\.WRITE_SECURE_SETTINGS: granted=true/);
    expect(helperRunning()).toBe(true);
    // The helper is the shell user, started from the app's own APK.
    expect(sh("ps -A -o USER,ARGS | grep '[a]i.clawpage.agent.ShellHelper'")).toMatch(/^shell\s/m);
  }, 180_000);

  it("then offers apps and screen, in the background too", async () => {
    await waitFor(async () => (await capabilities()).includes("screen"), 30_000);
    expect(await capabilities()).toEqual(expect.arrayContaining(["files", "apps", "screen"]));
    launch();
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && e.foreground && e.capabilities.includes("browser")), 30_000);
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    const away = await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && !e.foreground), 30_000);
    // Still online, with the screen and without the browser (a panel over the console that is not on screen).
    expect(away).toMatchObject({ online: true });
    expect(away.capabilities).toEqual(expect.arrayContaining(["apps", "screen"]));
    expect(away.capabilities).not.toContain("browser");
  }, 90_000);

  it.skipIf(!fs.existsSync(MOBILE_MCP))("answers every apps and screen tool in the words the Mac's adapter passes on for the same phone", async () => {
    mac = macAdapter();
    const both = async (tool: string, args: Record<string, unknown>, mobile: string, mobileArgs: Record<string, unknown> = args) => {
      const mine = await agent.call(tool, { env, ...args });
      const theirs = await mac!.call(mobile, mobileArgs);
      expect(mine.isError, agent.text(mine)).toBeUndefined();
      expect(theirs.isError, theirs.text).toBe(false);
      return { mine: agent.text(mine), theirs: theirs.text, image: mine.content.find((c) => c.type === "image"), theirImage: theirs.image };
    };
    const same = async (tool: string, args: Record<string, unknown>, mobile: string, mobileArgs: Record<string, unknown> = args) => {
      const { mine, theirs } = await both(tool, args, mobile, mobileArgs);
      expect(mine).toBe(theirs);
      return mine;
    };
    await same("screen_key", { key: "HOME" }, "mobile_press_button", { button: "HOME" });
    // The same apps in the same words; mobilecli's order is its own (not the package manager's), so the entries are compared as a set.
    const apps = await both("apps_list", {}, "mobile_list_apps");
    const entries = (s: string) => s.replace(/^Found these apps on device: /, "").split(", ").sort();
    expect(apps.mine.startsWith("Found these apps on device: ")).toBe(true);
    expect(entries(apps.mine)).toEqual(entries(apps.theirs));
    expect(apps.mine).toContain("Settings (com.android.settings)");
    // Settings from its start page (pairing left it at Wireless debugging).
    sh("am force-stop com.android.settings");
    await same("app_open", { app: "com.android.settings" }, "mobile_launch_app", { packageName: "com.android.settings" });
    await waitFor(() => screen().some((n) => /text="Network &amp; internet"/.test(n)), 15_000);
    // The same screen read both ways (the status bar's clock may tick in between).
    const clockless = (s: string) => s.replace(/^@e\d+ TextView text="[^"]*" label="[^"]*" id="com\.android\.systemui:id\/clock".*$/m, "");
    const read = await both("screen_read", {}, "mobile_list_elements_on_screen");
    expect(clockless(read.mine)).toBe(clockless(read.theirs));
    expect(read.mine).toContain('text="Network & internet"');
    fs.writeFileSync(path.join(OUT, "screen-read.txt"), read.mine);
    // Taps on the status bar change nothing on screen.
    await same("screen_tap", { x: 540, y: 30 }, "mobile_click_on_screen_at_coordinates");
    await same("screen_tap", { x: 540, y: 30, mode: "double" }, "mobile_double_tap_on_screen", { x: 540, y: 30 });
    await same("screen_tap", { x: 540, y: 30, mode: "long" }, "mobile_long_press_on_screen_at_coordinates", { x: 540, y: 30 });
    await same("screen_swipe", { direction: "up" }, "mobile_swipe_on_screen");
    await same("screen_swipe", { direction: "down", x: 540, y: 900, distance: 300 }, "mobile_swipe_on_screen");
    // Nothing has the focus here, so the keys go nowhere.
    await same("screen_type", { text: "abc" }, "mobile_type_keys");
    const pictures = await both("screen_shot", {}, "mobile_take_screenshot");
    // The control plane adds where it kept the picture, for either kind of phone.
    expect(pictures.mine.replace(/^Saved \/home\/gem\/workspace\/device-shots\/\S+\.jpg\.\n/, "")).toBe(pictures.theirs);
    expect(pictures.theirs).toMatch(/^Screenshot is \d+x\d+\. Screen coordinates are \d+x\d+\./);
    expect(pictures.image?.mimeType).toBe("image/jpeg");
    expect(pictures.theirImage?.mimeType).toBe("image/jpeg");
    fs.writeFileSync(path.join(OUT, "screen.jpg"), Buffer.from(pictures.image!.data!, "base64"));
    await same("app_close", { app: "com.android.settings" }, "mobile_terminate_app", { packageName: "com.android.settings" });
  }, 240_000);

  it("types what it is asked, Chinese too, but not into a password field", async () => {
    // The console's own sign-in form (a fresh install is signed out): an email field, then a password field.
    launch();
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && e.foreground), 30_000);
    const read = async () => text(await agent.call("screen_read", { env }));
    /** The middle of the first field listed after the line with `label`. */
    const fieldAfter = (screenText: string, label: string) => {
      const lines = screenText.split("\n");
      const field = lines.slice(lines.findIndex((l) => l.includes(label)) + 1).find((l) => / EditText /.test(l));
      if (!field) throw new Error(`no field after ${label}:\n${screenText}`);
      const [x, y, w, h] = / at=(\d+),(\d+) size=(\d+)x(\d+)/.exec(field)!.slice(1).map(Number);
      return { x: x! + Math.round(w! / 2), y: y! + Math.round(h! / 2) };
    };
    let last = "";
    const form = await waitFor(async () => { last = await read(); return /TextView text="Password"/.test(last) && last; }, 60_000)
      .catch(() => { throw new Error(`no sign-in form on screen:\n${last}`); });
    text(await agent.call("screen_tap", { env, ...fieldAfter(form, 'TextView text="Email"') }));
    expect(text(await agent.call("screen_type", { env, text: "爱丽丝 Alice" }))).toBe("Typed text: 爱丽丝 Alice");
    await waitFor(async () => (await read()).includes('EditText text="爱丽丝 Alice"'), 15_000);
    text(await agent.call("screen_tap", { env, ...fieldAfter(await read(), 'TextView text="Password"') }));
    const refused = await agent.call("screen_type", { env, text: "hunter2" });
    expect(refused.isError).toBe(true);
    expect(agent.text(refused)).toMatch(/password field/i);
    shot("password-refused.png");
  }, 120_000);

  it("lets no other user of the phone use its helper, not even with the token", async () => {
    const { port, token } = JSON.parse(adb("shell", "run-as", PACKAGE, "cat", "no_backup/control.json")) as { port: number; token: string };
    const apk = sh(`pm path ${PACKAGE}`).trim().replace(/^package:/, "");
    const probe = `CLASSPATH=${apk} app_process /system/bin ai.clawpage.agent.HelperProbe ${port} ${token}`;
    // The shell user (the helper's own uid, not the app's), holding the right token, is turned away before the handshake.
    // Another app's uid cannot be tried this way: app_process does not run under run-as. The app's own use of the
    // helper is every other test here.
    expect(sh(probe).trim()).toBe("refused uid");
  }, 60_000);

  it("stops from its notification: the helper ends and wireless debugging goes off", async () => {
    sh("cmd statusbar expand-notifications");
    await tapOn(/text="Stop"/);
    sh("cmd statusbar collapse");
    await waitFor(async () => (await control())?.state === "stopped", 30_000);
    expect(sh("settings get global adb_wifi_enabled").trim()).toBe("0");
    await waitFor(() => !helperRunning(), 15_000);
    await waitFor(async () => !(await capabilities()).includes("screen"), 30_000);
  }, 90_000);

  it("starts again by itself, and unlinking deletes its adb key and gives the permission back", async () => {
    // From the console, with the app on screen (no allowance needed for its foreground service).
    launch();
    expect((await ask({ type: "control", action: "start" })).control).toMatchObject({ state: "connecting" });
    await waitFor(async () => (await control())?.state === "running", 90_000);
    expect(sh("settings get global adb_wifi_enabled").trim()).toBe("1");
    expect(adb("shell", "run-as", PACKAGE, "ls", "no_backup/adb")).toContain("adbkey.pem");
    await ask({ type: "unlink" });
    await waitFor(() => !adb("shell", "run-as", PACKAGE, "ls", "no_backup/adb").includes("adbkey.pem"), 15_000);
    await waitFor(() => !helperRunning(), 15_000);
    await waitFor(() => sh("settings get global adb_wifi_enabled").trim() === "0", 15_000);
    await waitFor(() => /android\.permission\.WRITE_SECURE_SETTINGS: granted=false/.test(sh(`dumpsys package ${PACKAGE}`)) || !/WRITE_SECURE_SETTINGS: granted=true/.test(sh(`dumpsys package ${PACKAGE}`)), 20_000);
  }, 180_000);
});
