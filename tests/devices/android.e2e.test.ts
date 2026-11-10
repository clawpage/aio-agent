import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { transformWithOxc } from "vite";
import WebSocket from "ws";
import { startEnvWorld, waitFor } from "../helpers/envs.js";

/**
 * The real Android app (the Play build) in the emulator, linked to a local control plane, driven as the agent
 * drives it (docs/EXEC-ENVS.md). Not part of `npm test`: it needs a booted emulator, a debug build and the
 * network (the pages are public ones).
 *
 *   (cd src/ui/tauri && env -u NODE_ENV npm run -- tauri android build --debug --target aarch64 --apk)
 *   AIO_ANDROID_E2E=1 npx vitest run tests/devices/android.e2e.test.ts
 *
 * `AIO_ANDROID_APK` names another APK, `AIO_ANDROID_SERIAL` the emulator (default `emulator-5554`). It only
 * ever talks to that serial: other devices on this adb belong to someone else. The emulator reaches this
 * machine at 10.0.2.2 (its own network, not `adb reverse`, which drops the emulator when a large answer such as
 * a screenshot goes through it); the local control plane is told that this is its host name.
 */
const RUN = process.env.AIO_ANDROID_E2E === "1";
const APK = process.env.AIO_ANDROID_APK ?? path.resolve("src/ui/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk");
const SERIAL = process.env.AIO_ANDROID_SERIAL ?? "emulator-5554";
const PACKAGE = "ai.clawpage.agent";
const HOST = "10.0.2.2";
const OUT = path.resolve("var/.device-e2e/android");

const adb = (...args: string[]) => execFileSync(`${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`, ["-s", SERIAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

describe.skipIf(!RUN)("the Android app as an execution environment, on the emulator", () => {
  let world: Awaited<ReturnType<typeof startEnvWorld>>;
  let alice: Awaited<ReturnType<typeof world.signIn>>;
  let agent: ReturnType<typeof world.executor>;
  let env: string;
  /** What a call answered, or the device's words when it refused. */
  const json = (out: Parameters<typeof agent.text>[0] & { isError?: boolean }) => {
    if (out.isError) throw new Error(agent.text(out));
    return JSON.parse(agent.text(out)) as unknown;
  };
  const launch = (...extras: string[]) => adb("shell", "am", "start", "-W", "-n", `${PACKAGE}/.MainActivity`, ...extras);

  beforeAll(async () => {
    if (!adb("get-state").includes("device")) throw new Error(`${SERIAL} is not ready`);
    if (!fs.existsSync(APK)) throw new Error(`no debug build at ${APK}`);
    fs.mkdirSync(OUT, { recursive: true });
    world = await startEnvWorld();
    alice = await world.signIn("alice");
    const token = await world.link(alice, "android", "Pixel");
    agent = world.executor(world.runtimeFor(alice.id, 18301));
    adb("install", "-r", APK);
    adb("shell", "am", "force-stop", PACKAGE);
    // Device links are taken only on the control plane's own host name: here, the address the emulator dials.
    const port = new URL(world.url).port;
    world.h.ctx.cfg.allowedHosts.push(`${HOST}:${port}`);
    world.h.ctx.cfg.primaryHost = HOST;
    launch("--es", "AIODeviceToolsLinkURL", world.url.replace("localhost", HOST), "--es", "AIODeviceToolsLinkToken", token, "--es", "AIOConfirmSeconds", "4");
    const listed = await waitFor(async () => (await agent.list()).envs.find((e) => e.kind === "android" && e.online), 60_000);
    env = listed.id;
  }, 180_000);

  afterAll(async () => {
    try { adb("shell", "am", "force-stop", PACKAGE); } catch { /* gone */ }
    await world?.close();
  });

  it("says what it offers: its browser and folder, and is on screen", async () => {
    const listed = (await agent.list()).envs.find((e) => e.id === env)!;
    expect(listed).toMatchObject({ kind: "android", online: true, foreground: true });
    expect(listed.capabilities).toEqual(expect.arrayContaining(["browser", "files"]));
  });

  it("opens, reads and follows a page", async () => {
    const opened = await agent.call("browser_open", { env, url: "https://example.com/" });
    expect(agent.text(opened)).toContain("Example Domain");
    const read = await agent.call("browser_read", { env });
    expect(read.isError).toBeUndefined();
    const page = json(read) as { text: string; elements: Array<{ ref: string; role: string; name: string }> };
    expect(page.text).toContain("documentation examples");
    const more = page.elements.find((e) => e.role === "link")!;
    expect(more.ref).toMatch(/^e\d+$/);
    expect((await agent.call("browser_click", { env, ref: more.ref })).isError).toBeUndefined();
    const after = json(await agent.call("browser_read", { env })) as { url: string };
    expect(after.url).not.toBe("https://example.com/");
    const shot = await agent.call("browser_screenshot", { env });
    const image = shot.content.find((c) => c.type === "image")!;
    expect(image.mimeType).toBe("image/png");
    fs.writeFileSync(path.join(OUT, "browser.png"), Buffer.from(image.data!, "base64"));
    expect([...world.saved.keys()].some((f) => f.startsWith("/home/gem/workspace/device-shots/android-browser_screenshot-"))).toBe(true);
    expect((await agent.call("browser_back", { env })).isError).toBeUndefined();
  }, 90_000);

  it("leaves nothing a page can see, and its clicks and typing are real input", async () => {
    // A page that watches itself the way anti-bot scripts do, and writes what it saw into its own text.
    const probe = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Probe</title>
      <button id="b">Press here</button><input id="i" placeholder="Name"><pre id="out">waiting</pre>
      <script>
        const seen = { attrs: 0, nodes: 0, click: "none" };
        new MutationObserver((all) => { for (const m of all) { if (m.target.id === "out" || m.target.parentNode?.id === "out") continue; if (m.type === "attributes") seen.attrs++; else seen.nodes++; } })
          .observe(document.documentElement, { attributes: true, childList: true, subtree: true });
        const report = () => { out.textContent = "attrs=" + seen.attrs + " nodes=" + seen.nodes + " global=" + (Object.keys(window).some((k) => /aio/i.test(k)) || "__aio" in window) + " marked=" + !!document.querySelector("[data-aio-ref]") + " click=" + seen.click + " value=" + i.value + " input=" + seen.input + " ua=" + navigator.userAgent + " webdriver=" + navigator.webdriver; };
        b.addEventListener("click", (e) => { seen.click = e.isTrusted ? "trusted" : "script"; setTimeout(report, 50); });
        i.addEventListener("input", (e) => { seen.input = e.isTrusted ? "trusted" : "script"; setTimeout(report, 50); });
      </script>`));
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    try {
      json(await agent.call("browser_open", { env, url: `http://${HOST}:${(probe.address() as AddressInfo).port}/` }));
      const page = json(await agent.call("browser_read", { env })) as { elements: Array<{ ref: string; role: string; name: string }> };
      expect((await agent.call("browser_type", { env, ref: page.elements.find((e) => e.name === "Name")!.ref, text: "Alice" })).isError).toBeUndefined();
      expect((await agent.call("browser_click", { env, ref: page.elements.find((e) => e.name === "Press here")!.ref })).isError).toBeUndefined();
      const after = json(await agent.call("browser_read", { env })) as { text: string };
      fs.writeFileSync(path.join(OUT, "probe.txt"), `${/attrs=.*/.exec(after.text)?.[0]}\n`);
      expect(after.text).toContain("attrs=0 nodes=0 global=false marked=false click=trusted value=Alice input=trusted");
      expect(after.text).toContain("webdriver=false");
    } finally { probe.close(); }
  }, 90_000);

  it("types non-ASCII text, and asks the person before submitting an order", async () => {
    await agent.call("browser_open", { env, url: "https://httpbin.org/forms/post" });
    const page = json(await agent.call("browser_read", { env })) as { elements: Array<{ ref: string; role: string; name: string }> };
    const name = page.elements.find((e) => e.role === "text" || e.role === "tel" || e.role === "email")!;
    expect((await agent.call("browser_type", { env, ref: name.ref, text: "爱丽丝 Alice" })).isError).toBeUndefined();
    const typed = json(await agent.call("browser_read", { env })) as { elements: Array<{ ref: string; name: string }> };
    expect(typed.elements.find((e) => e.ref === name.ref)?.name).toBe("爱丽丝 Alice");
    const submit = page.elements.find((e) => /submit order/i.test(e.name))!;
    fs.writeFileSync(path.join(OUT, "before-confirm.png"), execFileSync(`${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`, ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }));
    // Nobody taps in the emulator: the dialog goes after its (shortened) wait and the agent is told.
    const out = await agent.call("browser_click", { env, ref: submit.ref });
    expect(out.isError).toBe(true);
    expect(agent.text(out)).toMatch(/waiting for the user to confirm on the device/i);
  }, 90_000);

  it("moves files between the workspace and the app's folder", async () => {
    world.saved.set("/home/gem/workspace/out/note.txt", { userId: (await world.h.ctx.db.prepare("SELECT id FROM owners WHERE username='alice'").get() as { id: string }).id, bytes: Buffer.from("hello from the sandbox") });
    const pushed = await agent.call("files_push", { env, path: "/home/gem/workspace/out/note.txt" });
    expect(pushed.isError).toBeUndefined();
    const saved = (json(pushed) as { saved: string }).saved;
    expect(agent.text(await agent.call("files_list", { env }))).toContain(saved);
    const back = /Saved (\/home\/gem\/workspace\/back\/note[^\n]*\.txt) /.exec(agent.text(await agent.call("files_pull", { env, name: saved, to: "/home/gem/workspace/back/" })))?.[1];
    expect(world.saved.get(back!)?.bytes.toString()).toBe("hello from the sandbox");
    expect((await agent.call("files_pull", { env, name: "../../shared_prefs/x.xml" })).isError).toBe(true);
  }, 60_000);

  it("goes offline in the background, and comes back on screen", async () => {
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && !e.online), 30_000);
    expect((await agent.call("browser_read", { env })).isError).toBe(true);
    launch();
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && e.online && e.foreground), 30_000);
  }, 90_000);

  it("is linked and unlinked by the console's own bridge code, as its settings page does it", async () => {
    // The console in the app is the deployed one, so this build's deviceTools.ts goes into that page through
    // DevTools (a debug build's web view allows it) and talks to the app's real `aioDeviceTools` listener.
    const pid = adb("shell", "pidof", PACKAGE).trim();
    const forward = adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`).trim();
    try {
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
      await run(`window.__dt = (() => { ${source}; return { deviceToolsApp, askDeviceTools, listenDeviceTools, syncDeviceToolsAccount }; })();
        window.__states = []; __dt.listenDeviceTools((s) => __states.push(s.state)); true`);
      const ask = async (message: object) => JSON.parse(await run(`__dt.askDeviceTools(${JSON.stringify(message)}).then(JSON.stringify, (e) => JSON.stringify({ refused: e.message }))`)) as Record<string, unknown>;
      expect(await run("__dt.deviceToolsApp()")).toBe("android");

      // On: a link of kind android named after the phone, handed to the app; the agent sees the phone.
      const state = await ask({ type: "status" });
      expect(state).toMatchObject({ linked: true, abilities: {} });
      expect(state.seq).toBeUndefined();
      const res = await world.h.request("/api/device-links", { method: "POST", headers: alice.headers, body: JSON.stringify({ name: state.name, kind: "android" }) });
      const created = (await res.json()) as { link: { id: string }; token: string };
      expect(await ask({ type: "link", token: created.token, linkId: created.link.id, account: "alice" })).toMatchObject({ linked: true, linkId: created.link.id });
      await waitFor(() => world.links.list(alice.id, "android").find((l) => l.id === created.link.id && l.online), 30_000);
      await waitFor(async () => (await agent.list()).envs.find((e) => e.kind === "android" && e.online && e.name === state.name), 30_000);
      await waitFor(async () => ((await run("__states")) as string[]).includes("online"), 10_000);
      // Who is signed in, as the console says it on every start: the same account keeps the link.
      await run(`__dt.syncDeviceToolsAccount("alice")`);
      expect(await ask({ type: "status" })).toMatchObject({ linked: true, state: "online" });
      // What Android does not do comes back as a refusal.
      expect(await ask({ type: "enable", ability: "photos" })).toEqual({ refused: "unknown" });

      // Off: the link goes on the server and the app forgets it.
      await world.h.request(`/api/device-links/${created.link.id}`, { method: "DELETE", headers: alice.headers });
      expect(await ask({ type: "unlink" })).toMatchObject({ linked: false, linkId: null, state: "off" });
      await waitFor(async () => !(await agent.list()).envs.some((e) => e.kind === "android" && e.online), 30_000);
      cdp.close();
    } finally {
      adb("forward", "--remove", `tcp:${forward}`);
    }
  }, 120_000);
});
