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
  /** The screen's elements as the accessibility tree has them (what a person sees). */
  const screen = () => {
    adb("shell", "uiautomator", "dump", "/sdcard/aio-ui.xml");
    return [...adb("shell", "cat", "/sdcard/aio-ui.xml").matchAll(/<node [^>]*>/g)].map((m) => m[0]);
  };
  /** A person's tap on an element. */
  const tap = (node: string) => {
    const [x1, y1, x2, y2] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)!.slice(1).map(Number);
    adb("shell", "input", "tap", String(Math.round((x1! + x2!) / 2)), String(Math.round((y1! + y2!) / 2)));
  };
  /** The same on the first element that matches, once it shows. */
  const tapOn = async (match: RegExp, ms = 30_000) => tap(await waitFor(() => screen().find((n) => match.test(n)), ms));
  const shot = (name: string) => fs.writeFileSync(path.join(OUT, name), execFileSync(`${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`, ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }));

  /**
   * The console in the app is the deployed one, so this build's deviceTools.ts goes into that page through
   * DevTools (a debug build's web view allows it) and talks to the app's real `aioDeviceTools` listener, as the
   * settings page does.
   */
  let devtools: { ask: (message: object) => Promise<Record<string, any>>; run: (expression: string) => Promise<any>; close: () => void } | null = null;
  const consolePage = async () => {
    if (devtools) return devtools;
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
    await run(`window.__dt = (() => { ${source}; return { deviceToolsApp, askDeviceTools, listenDeviceTools, syncDeviceToolsAccount }; })();
      window.__states = []; __dt.listenDeviceTools((s) => __states.push(s.state)); true`);
    const ask = async (message: object) => JSON.parse(await run(`__dt.askDeviceTools(${JSON.stringify(message)}).then(JSON.stringify, (e) => JSON.stringify({ refused: e.message }))`)) as Record<string, any>;
    devtools = { ask, run, close: () => { cdp.close(); adb("forward", "--remove", `tcp:${forward}`); } };
    return devtools;
  };
  const capabilities = async () => (await agent.list()).envs.find((e) => e.id === env)!.capabilities;

  beforeAll(async () => {
    if (!adb("get-state").includes("device")) throw new Error(`${SERIAL} is not ready`);
    if (!fs.existsSync(APK)) throw new Error(`no debug build at ${APK}`);
    fs.mkdirSync(OUT, { recursive: true });
    world = await startEnvWorld();
    alice = await world.signIn("alice");
    const token = await world.link(alice, "android", "Pixel");
    agent = world.executor(world.runtimeFor(alice.id, 18301));
    adb("install", "-r", APK);
    // From nothing: no link, no ability on, no permission, nothing shared from an earlier run.
    adb("shell", "pm", "clear", PACKAGE);
    // A calendar on the phone (an emulator has none without an account), and two pictures for the photo picker.
    if (!adb("shell", "content", "query", "--uri", "content://com.android.calendar/calendars", "--projection", "_id:calendar_displayName").includes("calendar_displayName=E2E")) {
      adb("shell", "content", "insert", "--uri", "'content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=e2e&account_type=LOCAL'",
        "--bind", "account_name:s:e2e", "--bind", "account_type:s:LOCAL", "--bind", "name:s:e2e", "--bind", "calendar_displayName:s:E2E", "--bind", "calendar_access_level:i:700",
        "--bind", "ownerAccount:s:e2e", "--bind", "visible:i:1", "--bind", "sync_events:i:1", "--bind", "calendar_timezone:s:UTC");
    }
    adb("shell", "mkdir", "-p", "/sdcard/Pictures/aio-e2e");
    for (const n of [1, 2]) adb("shell", "screencap", "-p", `/sdcard/Pictures/aio-e2e/shot-${n}.png`);
    adb("shell", "content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary");
    // Device links are taken only on the control plane's own host name: here, the address the emulator dials.
    const port = new URL(world.url).port;
    world.h.ctx.cfg.allowedHosts.push(`${HOST}:${port}`);
    world.h.ctx.cfg.primaryHost = HOST;
    launch("--es", "AIODeviceToolsLinkURL", world.url.replace("localhost", HOST), "--es", "AIODeviceToolsLinkToken", token, "--es", "AIOConfirmSeconds", "4");
    const listed = await waitFor(async () => (await agent.list()).envs.find((e) => e.kind === "android" && e.online), 60_000);
    env = listed.id;
  }, 180_000);

  afterAll(async () => {
    try { devtools?.close(); } catch { /* gone */ }
    try { adb("shell", "am", "force-stop", PACKAGE); } catch { /* gone */ }
    await world?.close();
  });

  it("says what it offers: its browser and folder, photos (nothing to allow), and is on screen", async () => {
    const listed = (await agent.list()).envs.find((e) => e.id === env)!;
    expect(listed).toMatchObject({ kind: "android", online: true, foreground: true });
    // No calendar yet: Android has not been asked.
    expect(listed.capabilities).toEqual(["browser", "files", "photos"]);
  });

  it("opens, reads and follows a page", async () => {
    const opened = await agent.call("browser_open", { env, url: "https://example.com/" });
    expect(agent.text(opened)).toContain("Example Domain");
    const read = await agent.call("browser_read", { env });
    expect(read.isError).toBeUndefined();
    const page = json(read) as { text: string; elements: Array<{ ref: string; role: string; name: string }> };
    expect(page.text).toContain("documentation examples");
    // example.com no longer has a link to follow (2026-11): one of this machine's pages has.
    const site = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/next"
      ? "<!doctype html><title>Next</title><p>The next page</p>" : "<!doctype html><title>Start</title><a href=\"/next\">More information</a>"));
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    try {
      const start = `http://${HOST}:${(site.address() as AddressInfo).port}/`;
      json(await agent.call("browser_open", { env, url: start }));
      const more = (json(await agent.call("browser_read", { env })) as { elements: Array<{ ref: string; role: string; name: string }> }).elements.find((e) => e.role === "link")!;
      expect(more).toMatchObject({ ref: expect.stringMatching(/^e\d+$/), name: "More information" });
      expect((await agent.call("browser_click", { env, ref: more.ref })).isError).toBeUndefined();
      const after = await waitFor(async () => { const read = json(await agent.call("browser_read", { env })) as { url: string; text: string }; return read.url !== start && read; }, 15_000);
      expect(after).toMatchObject({ url: `${start}next`, text: expect.stringContaining("The next page") });
    } finally { site.close(); }
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

    // Larger than one message from the phone: it comes back in parts, whole.
    const big = Buffer.alloc(13 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32BE(i, i);
    world.saved.set("/home/gem/workspace/out/video.bin", { userId: alice.id, bytes: big });
    const name = (json(await agent.call("files_push", { env, path: "/home/gem/workspace/out/video.bin" })) as { saved: string }).saved;
    expect(agent.text(await agent.call("files_pull", { env, name, to: "/home/gem/workspace/back/" }))).toContain(`(${big.length} bytes)`);
    expect(world.saved.get(`/home/gem/workspace/back/${name}`)?.bytes.equals(big)).toBe(true);
  }, 120_000);

  it("shows its folder in the system Files app, under the app's name", async () => {
    adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-t", "vnd.android.document/root", "-d", `content://${PACKAGE}.documents/root/ai-files`);
    const shown = await waitFor(() => { const all = screen(); return all.some((n) => /text="note[^"]*\.txt"/.test(n)) && all; }, 30_000);
    shot("files-app.png");
    expect(shown.some((n) => /text="video[^"]*\.bin"/.test(n))).toBe(true);
    launch();
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && e.online && e.foreground), 30_000);
  }, 90_000);

  it("turns the calendar on from the console, which is when Android asks, then reads and adds events", async () => {
    const { ask } = await consolePage();
    expect((await ask({ type: "status" })).abilities.calendar).toEqual({ enabled: false, permission: "notDetermined" });
    // Android's own prompt, answered as a person would.
    const asked = ask({ type: "enable", ability: "calendar" });
    await tapOn(/resource-id="com\.android\.permissioncontroller:id\/permission_allow_button"/);
    expect((await asked).abilities.calendar).toEqual({ enabled: true, permission: "authorized" });
    await waitFor(async () => (await capabilities()).includes("calendar"), 15_000);

    const calendars = (json(await agent.call("calendar_calendars", { env })) as { calendars: Array<{ id: string; title: string; writable: boolean }> }).calendars;
    const e2e = calendars.find((c) => c.title === "E2E")!;
    expect(e2e).toMatchObject({ writable: true });
    const day = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
    const title = `AIO e2e dentist ${Date.now()}`;
    const made = json(await agent.call("calendar_create_event", { env, title, start: `${day}T15:00`, location: "Main St", calendar_id: e2e.id })) as Record<string, unknown>;
    expect(made).toMatchObject({ title, all_day: false, location: "Main St", calendar: "E2E", calendar_id: e2e.id });
    expect(made.start).toMatch(new RegExp(`^${day}T15:00:00([+-]\\d\\d:\\d\\d|Z)$`));
    expect(made.end).toMatch(new RegExp(`^${day}T16:00:00`));
    const allDay = json(await agent.call("calendar_create_event", { env, title: `${title} (all day)`, start: day, calendar_id: e2e.id })) as Record<string, unknown>;
    expect(allDay).toMatchObject({ all_day: true, start: expect.stringMatching(new RegExp(`^${day}T00:00:00`)), end: expect.stringMatching(new RegExp(`^${day}T23:59:59`)) });
    const listed = json(await agent.call("calendar_events", { env, from: day, to: day })) as { events: Array<Record<string, unknown>> };
    expect(listed.events.filter((e) => String(e.title).startsWith(title)).map((e) => [e.title, e.all_day])).toEqual([[`${title} (all day)`, true], [title, false]]);
    expect(agent.text(await agent.call("calendar_events", { env, from: day, to: "2099-01-01" }))).toMatch(/at most 366 days/);
    expect(agent.text(await agent.call("calendar_create_event", { env, title, start: day, calendar_id: "999999" }))).toMatch(/Not found/);
  }, 120_000);

  it("shares only the photos the person picks in the system picker, and they can take them back", async () => {
    const { ask } = await consolePage();
    expect((await ask({ type: "status" })).abilities.photos).toEqual({ enabled: true, permission: "authorized", shared: 0 });
    expect(json(await agent.call("photos_list", { env, media: "any" }))).toEqual({ photos: [], total: 0, offset: 0 });
    // The system photo picker: two pictures, picked as a person would, then "Add".
    const picked = ask({ type: "photosAdd" });
    const items = await waitFor(() => { const all = screen().filter((n) => /content-desc="Photo taken on/.test(n)); return all.length >= 2 && all; }, 30_000);
    tap(items[0]!);
    tap(items[1]!);
    shot("photo-picker.png");
    await tapOn(/text="Add[^"]*"/);
    expect((await picked).abilities.photos).toMatchObject({ enabled: true, shared: 2 });

    expect(json(await agent.call("photos_albums", { env }))).toEqual({ albums: [{ id: "shared", title: "Shared with AI", count: 2, kind: "album" }] });
    const found = json(await agent.call("photos_list", { env })) as { photos: Array<{ id: string; width: number; height: number; mediaType: string }>; total: number };
    expect(found.total).toBe(2);
    expect(found.photos[0]).toMatchObject({ mediaType: "image", width: expect.any(Number), height: expect.any(Number) });
    const fetched = await agent.call("photos_get", { env, ids: [found.photos[0]!.id, "not-shared"], max_size: 400 });
    const image = fetched.content.find((c) => c.type === "image")!;
    expect(image.mimeType).toBe("image/jpeg");
    fs.writeFileSync(path.join(OUT, "photo.jpg"), Buffer.from(image.data!, "base64"));
    expect(agent.text(fetched)).toMatch(/not-shared: not found on the device/);
    expect([...world.saved.keys()].some((f) => f.startsWith("/home/gem/workspace/device-photos/IMG-"))).toBe(true);
    // An album nobody shared is not there for the agent, whatever it names.
    expect(agent.text(await agent.call("photos_list", { env, album_id: "Camera" }))).toMatch(/Not found/);

    // The console's list, with small copies; taking one back takes it from the agent too.
    const shared = (await ask({ type: "photosShared" })).photos as Array<{ id: string; thumb: string }>;
    expect(shared.map((p) => p.id).sort()).toEqual(found.photos.map((p) => p.id).sort());
    expect(shared[0]!.thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect((await ask({ type: "photosRemove", ids: [found.photos[0]!.id] })).abilities.photos.shared).toBe(1);
    expect((json(await agent.call("photos_list", { env })) as { total: number }).total).toBe(1);
    // Photos off: the agent loses them and is told why.
    await ask({ type: "disable", ability: "photos" });
    await waitFor(async () => !(await capabilities()).includes("photos"), 15_000);
    expect(agent.text(await agent.call("photos_list", { env }))).toMatch(/has no photos for you/);
  }, 180_000);

  it("goes offline in the background, and comes back on screen", async () => {
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && !e.online), 30_000);
    expect((await agent.call("browser_read", { env })).isError).toBe(true);
    launch();
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && e.online && e.foreground), 30_000);
  }, 90_000);

  it("is linked and unlinked by the console's own bridge code, as its settings page does it", async () => {
    const { ask, run } = await consolePage();
    expect(await run("__dt.deviceToolsApp()")).toBe("android");

    // On: a link of kind android named after the phone, handed to the app; the agent sees the phone.
    const state = await ask({ type: "status" });
    expect(state).toMatchObject({ linked: true, abilities: { calendar: { enabled: true } } });
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
    // What Android does not have, or does not know, comes back as a refusal.
    expect(await ask({ type: "enable", ability: "reminders" })).toEqual({ refused: "invalid" });
    expect(await ask({ type: "nonsense" })).toEqual({ refused: "unknown" });

    // Off: the link goes on the server and the app forgets it, with every ability and what was shared.
    await world.h.request(`/api/device-links/${created.link.id}`, { method: "DELETE", headers: alice.headers });
    const off = await ask({ type: "unlink" });
    expect(off).toMatchObject({ linked: false, linkId: null, state: "off", abilities: { calendar: { enabled: false }, photos: { enabled: false, shared: 0 } } });
    await waitFor(async () => !(await agent.list()).envs.some((e) => e.kind === "android" && e.online), 30_000);
  }, 120_000);
});
