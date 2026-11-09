import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { startEnvWorld, waitFor } from "../helpers/envs.js";

/**
 * The real iPhone app in the simulator, linked to a local control plane, driven as the agent drives it
 * (docs/EXEC-ENVS.md). Not part of `npm test`: it needs a booted iOS simulator, a debug simulator build
 * and the network (the pages are public ones, outside the app's bound domains on purpose).
 *
 *   (cd src/ui/tauri && env -u NODE_ENV npm run -- tauri ios build --debug --target aarch64-sim)
 *   AIO_IOS_E2E=1 npx vitest run tests/devices/ios.e2e.test.ts
 *
 * `AIO_IOS_APP` names another .app, `AIO_IOS_SIM` a simulator (default: the booted one).
 */
const RUN = process.env.AIO_IOS_E2E === "1";
const APP = process.env.AIO_IOS_APP ?? path.resolve("src/ui/tauri/src-tauri/gen/apple/build/arm64-sim/AIOAgent.app");
const BUNDLE = "ai.clawpage.agent";
const OUT = path.resolve("var/.device-e2e/ios");

const simctl = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const booted = () => process.env.AIO_IOS_SIM ?? /\(([0-9A-F-]{36})\) \(Booted\)/.exec(simctl("list", "devices", "booted"))?.[1];

describe.skipIf(!RUN)("the iPhone app as an execution environment, on the simulator", () => {
  let world: Awaited<ReturnType<typeof startEnvWorld>>;
  let agent: ReturnType<typeof world.executor>;
  let env: string;
  let sim: string;
  /** What a call answered, or the device's words when it refused. */
  const json = (out: Parameters<typeof agent.text>[0] & { isError?: boolean }) => {
    if (out.isError) throw new Error(agent.text(out));
    return JSON.parse(agent.text(out)) as unknown;
  };

  beforeAll(async () => {
    sim = booted() ?? "";
    if (!sim) throw new Error("no booted iOS simulator (xcrun simctl boot <id>)");
    if (!fs.existsSync(APP)) throw new Error(`no simulator build at ${APP}`);
    fs.mkdirSync(OUT, { recursive: true });
    world = await startEnvWorld();
    const alice = await world.signIn("alice");
    const token = await world.link(alice, "ios", "iPhone");
    agent = world.executor(world.runtimeFor(alice.id, 18201));
    simctl("install", sim, APP);
    try { simctl("terminate", sim, BUNDLE); } catch { /* not running */ }
    simctl("launch", sim, BUNDLE, "-AIODeviceToolsLinkURL", world.url, "-AIODeviceToolsLinkToken", token, "-AIOConfirmSeconds", "4");
    const listed = await waitFor(async () => (await agent.list()).envs.find((e) => e.kind === "ios" && e.online), 60_000);
    env = listed.id;
  }, 120_000);

  afterAll(async () => {
    if (sim) { try { simctl("terminate", sim, BUNDLE); } catch { /* gone */ } }
    await world?.close();
  });

  it("says what it offers: its browser and folder, and is on screen", async () => {
    const listed = (await agent.list()).envs.find((e) => e.id === env)!;
    expect(listed).toMatchObject({ kind: "ios", online: true, foreground: true });
    expect(listed.capabilities).toEqual(expect.arrayContaining(["browser", "files"]));
  });

  it("opens, reads and follows a page outside the app's own domains", async () => {
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
    expect([...world.saved.keys()].some((f) => f.startsWith("/home/gem/workspace/device-shots/ios-browser_screenshot-"))).toBe(true);
    expect((await agent.call("browser_back", { env })).isError).toBeUndefined();
  }, 90_000);

  it("leaves nothing a page can see: no marks on its elements, none of its code", async () => {
    // A page that watches itself the way anti-bot scripts do, and writes what it saw into its own text.
    const probe = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Probe</title>
      <button id="b">Press here</button><input id="i" placeholder="Name"><pre id="out">waiting</pre>
      <script>
        const seen = { attrs: 0, nodes: 0, click: "none" };
        new MutationObserver((all) => { for (const m of all) { if (m.target.id === "out" || m.target.parentNode?.id === "out") continue; if (m.type === "attributes") seen.attrs++; else seen.nodes++; } })
          .observe(document.documentElement, { attributes: true, childList: true, subtree: true });
        const report = () => { out.textContent = "attrs=" + seen.attrs + " nodes=" + seen.nodes + " global=" + (Object.keys(window).some((k) => /aio/i.test(k)) || "__aio" in window) + " marked=" + !!document.querySelector("[data-aio-ref]") + " click=" + seen.click + " value=" + i.value; };
        b.addEventListener("click", (e) => { seen.click = e.isTrusted ? "trusted" : "script"; setTimeout(report, 50); });
        i.addEventListener("input", () => setTimeout(report, 50));
      </script>`));
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    try {
      json(await agent.call("browser_open", { env, url: `http://localhost:${(probe.address() as AddressInfo).port}/` }));
      const page = json(await agent.call("browser_read", { env })) as { elements: Array<{ ref: string; role: string; name: string }> };
      expect((await agent.call("browser_type", { env, ref: page.elements.find((e) => e.name === "Name")!.ref, text: "Alice" })).isError).toBeUndefined();
      expect((await agent.call("browser_click", { env, ref: page.elements.find((e) => e.name === "Press here")!.ref })).isError).toBeUndefined();
      const after = json(await agent.call("browser_read", { env })) as { text: string };
      fs.writeFileSync(path.join(OUT, "probe.txt"), `${/attrs=.*/.exec(after.text)?.[0]}\n`);
      expect(after.text).toContain("attrs=0 nodes=0 global=false marked=false");
      expect(after.text).toContain("value=Alice");
    } finally { probe.close(); }
  }, 90_000);

  it("types into a form, and asks the person before submitting an order", async () => {
    await agent.call("browser_open", { env, url: "https://httpbin.org/forms/post" });
    const page = json(await agent.call("browser_read", { env })) as { elements: Array<{ ref: string; role: string; name: string }> };
    const name = page.elements.find((e) => e.role === "text" || e.role === "tel" || e.role === "email")!;
    expect((await agent.call("browser_type", { env, ref: name.ref, text: "Alice" })).isError).toBeUndefined();
    const submit = page.elements.find((e) => /submit order/i.test(e.name))!;
    simctl("io", sim, "screenshot", path.join(OUT, "before-confirm.png"));
    // Nobody taps in the simulator: the alert goes after its (shortened) wait and the agent is told.
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
    expect((await agent.call("files_pull", { env, name: "../../Library/Preferences/x.plist" })).isError).toBe(true);
  }, 60_000);

  it("goes offline in the background, and comes back on screen", async () => {
    simctl("launch", sim, "com.apple.Preferences");
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && !e.online), 30_000);
    expect((await agent.call("browser_read", { env })).isError).toBe(true);
    simctl("launch", sim, BUNDLE);
    await waitFor(async () => (await agent.list()).envs.find((e) => e.id === env && e.online && e.foreground), 30_000);
  }, 90_000);
});
