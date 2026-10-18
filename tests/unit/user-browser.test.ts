import { it, expect } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain ESM script without types
import { chromeArgs, createUserBrowser, filterTools, macLanguages, refused, UNAVAILABLE } from "../../bin/user-browser.mjs";

const call = (name: string, args: Record<string, unknown> = {}, id: unknown = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const result = (a: unknown) => (a as { result: Result }).result;
const textOf = (a: unknown) => result(a).content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const until = async (check: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

it("lets through only tools that act inside the browser, never a file on the Mac or a non-web page", () => {
  expect(refused(call("list_pages"))).toBeNull();
  expect(refused(call("navigate_page", { pageId: 1, url: "https://example.com/a" }))).toBeNull();
  expect(refused(call("navigate_page", { pageId: 1, type: "back" }))).toBeNull();
  expect(refused(call("new_page", { url: "about:blank" }))).toBeNull();
  for (const url of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,x", ""]) {
    expect(refused(call("new_page", { url }))).toMatch(/http\(s\)/);
    expect(refused(call("navigate_page", { pageId: 1, url }))).toMatch(/http\(s\)/);
  }
  for (const name of ["upload_file", "emulate", "resize_page", "lighthouse_audit", "performance_start_trace", "take_heapsnapshot"]) expect(refused(call(name))).toMatch(/not available/);
  expect(refused(call("take_screenshot", { pageId: 1, filePath: "/tmp/x.png" }))).toMatch(/Files on the user's Mac/);
  expect(refused(call("get_network_request", { pageId: 1, responseFilePath: "/tmp/x" }))).toMatch(/Files on the user's Mac/);
  expect(refused({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeNull();

  const tools = filterTools([
    { name: "take_screenshot", inputSchema: { type: "object", properties: { pageId: {}, filePath: {} }, required: ["pageId"] } },
    { name: "upload_file", inputSchema: { type: "object", properties: { filePaths: {} }, required: ["filePaths"] } },
    // Every page opens in a window of its own, in the AI's own profile: these choices are not the agent's.
    { name: "new_page", inputSchema: { type: "object", properties: { url: {}, background: {}, isolatedContext: {} }, required: ["url"] } },
  ]);
  expect(tools).toEqual([
    { name: "take_screenshot", inputSchema: { type: "object", properties: { pageId: {} }, required: ["pageId"] } },
    { name: "new_page", inputSchema: { type: "object", properties: { url: {} }, required: ["url"] } },
  ]);
});

it("starts Chrome headless in its own profile, speaking the Mac's languages", () => {
  const args = chromeArgs("/p/ai-chrome", "UA", ["zh-CN", "en-US"]);
  expect(args).toEqual(expect.arrayContaining(["--user-data-dir=/p/ai-chrome", "--remote-debugging-port=0", "--headless=new", "--user-agent=UA", "--lang=zh-CN", "--accept-lang=zh-CN,en-US"]));
  expect(args.join(" ")).not.toMatch(/Library\/Application Support\/Google\/Chrome/);
  expect(macLanguages(() => '(\n    "zh-Hans-CN",\n    "en-US",\n    "zh-Hant-TW",\n    ja\n)\n')).toEqual(["zh-CN", "en-US", "zh-TW", "ja"]);
  expect(macLanguages(() => { throw new Error("no defaults"); })).toEqual([]);
});

/** A live-view socket as phone-bridge.mjs hands it over. */
function viewer() {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, frames: [] as string[], texts: [] as Array<Record<string, unknown>> }) as EventEmitter & {
    OPEN: number; readyState: number; bufferedAmount: number; frames: string[]; texts: Array<Record<string, unknown>>;
    send(data: unknown, opts?: { binary?: boolean }): void; close(): void; terminate(): void; input(msg: unknown): void;
  };
  ws.send = (data, opts) => { if (opts?.binary) ws.frames.push(String(data)); else ws.texts.push(JSON.parse(String(data))); };
  ws.close = () => { if (ws.readyState === 3) return; ws.readyState = 3; ws.emit("close"); };
  ws.terminate = ws.close;
  ws.input = (msg) => ws.emit("message", Buffer.from(JSON.stringify(msg)), false);
  return ws;
}

it("runs the AI's own Chrome on first use: a window per page, a screencast and the person's input, and a new Chrome after a crash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-browser-"));
  const profileDir = path.join(dir, "profile");
  const chromePath = path.join(dir, "chrome");
  fs.writeFileSync(chromePath, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, "fake-chrome.mjs")}" "$@"\n`, { mode: 0o755 });
  const logs: string[] = [];
  const browser = createUserBrowser({ entry: path.join(FIXTURES, "fake-devtools-mcp.mjs"), profileDir, chromePath, log: (m: string) => logs.push(m) });
  const calls = () => fs.readFileSync(path.join(profileDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown>; sessionId?: string });
  try {
    // The handshake and the tool list need no Chrome: nothing starts until a tool is called.
    expect(result(await browser.handle({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-06-18" } }))).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "chrome_devtools" } });
    expect((result(await browser.handle({ jsonrpc: "2.0", id: 8, method: "tools/list" })) as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["list_pages", "new_page"]);
    expect(fs.existsSync(path.join(profileDir, "DevToolsActivePort"))).toBe(false);
    expect(await browser.status()).toEqual({ available: true, connected: false });

    // A stale port file from a Chrome that is gone is not mistaken for this one.
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "DevToolsActivePort"), "9\n/devtools/browser/gone\n");
    const opened = await browser.handle(call("new_page", { url: "https://example.com/", background: false }, "req-1"));
    expect((opened as { id: unknown }).id).toBe("req-1");
    expect(JSON.parse(fs.readFileSync(path.join(profileDir, "args.json"), "utf8"))).toEqual(expect.arrayContaining(["--headless=new", `--user-data-dir=${profileDir}`]));
    // The page got a window of its own, in the background, and the gateway reads it as the selected page; only the final page list is kept.
    expect(calls().find((c) => c.method === "Target.createTarget")!.params).toMatchObject({ newWindow: true, background: true, width: 1280, height: 800 });
    expect(textOf(opened)).toMatch(/^Successfully navigated to https:\/\/example.com\/\.$/m);
    expect(textOf(opened).match(/## Pages/g)).toHaveLength(1);
    expect(textOf(opened)).toMatch(/^2: \(https:\/\/example.com\/\) \[selected\]$/m);
    expect(await browser.status()).toEqual({ available: true, connected: true });

    // Nothing the agent asks brings a page forward.
    expect(textOf(await browser.handle(call("select_page", { pageId: 2, bringToFront: true })))).toBe("selected 2 bringToFront=false");
    expect(result(await browser.handle(call("upload_file")))).toEqual({ content: [{ type: "text", text: expect.stringMatching(/not available/) }], isError: true });

    // The live view: the page as it is, then what Chrome paints; the person's input goes in as real mouse, wheel and keys.
    const ws = viewer();
    browser.stream(ws, 2);
    await until(() => ws.frames.length === 2);
    expect(ws.frames).toEqual(["first", "frame"]);
    expect(ws.texts).toEqual([{ type: "size", width: 1280, height: 700 }, { type: "size", width: 1280, height: 640 }]);
    ws.input({ t: "pointer", phase: "down", x: 0.5, y: 0.5 });
    ws.input({ t: "pointer", phase: "move", x: 0.6, y: 0.5 });
    ws.input({ t: "pointer", phase: "up", x: 0.6, y: 0.5 });
    ws.input({ t: "wheel", x: 0.5, y: 0.5, dx: 30, dy: -400 });
    ws.input({ t: "key", k: "Enter" });
    ws.input({ t: "key", k: "a", mods: ["meta"] });
    ws.input({ t: "text", s: "你好" });
    ws.input({ t: "nav", to: "back" });
    await until(() => calls().some((c) => c.method === "Page.navigateToHistoryEntry"));
    const session = calls().filter((c) => c.sessionId === "S-T1");
    expect(session.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => [c.params.type, c.params.x, c.params.y, c.params.buttons, c.params.deltaY])).toEqual([
      ["mousePressed", 640, 320, 1, undefined],
      ["mouseMoved", 768, 320, 1, undefined],
      ["mouseReleased", 768, 320, 0, undefined],
      ["mouseWheel", 640, 320, undefined, -400],
    ]);
    expect(session.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => [c.params.type, c.params.key, c.params.text ?? c.params.commands])).toEqual([
      ["keyDown", "Enter", "\r"], ["keyUp", "Enter", undefined], ["keyDown", "a", ["selectAll"]],
    ]);
    expect(session.find((c) => c.method === "Input.insertText")!.params).toEqual({ text: "你好" });
    expect(session.find((c) => c.method === "Page.navigateToHistoryEntry")!.params).toEqual({ entryId: 10 });
    // The next picture is asked for only after a pause (FRAME_GAP_MS), so a scrolling page cannot flood the link.
    await until(() => calls().some((c) => c.method === "Page.screencastFrameAck"));
    expect(calls().find((c) => c.method === "Page.screencastFrameAck")!.params).toEqual({ sessionId: 1 });
    ws.close();
    await until(() => calls().some((c) => c.method === "Page.stopScreencast"));

    // A page the agent did not open through new_page (Chrome's first one) is found through the page itself.
    const first = viewer();
    browser.stream(first, 1);
    await until(() => first.frames.length === 2);
    first.close();
    expect(await browser.screenshot(2)).toEqual({ type: "image/jpeg", body: Buffer.from("shot") });

    // Chrome crashes: the next call starts a new one, with a fresh tool session.
    const port = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8");
    const exits = () => logs.filter((m) => m === "browser tools exited").length;
    const before = exits();
    process.kill(Number(fs.readFileSync(path.join(profileDir, "pid"), "utf8")), "SIGKILL");
    await until(() => exits() === before + 1);
    expect(textOf(await browser.handle(call("list_pages")))).toMatch(/^1: \(about:blank\)$/m);
    expect(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8")).not.toBe(port);

    // A second bridge (the app restarted while Chrome kept running) takes over the running Chrome instead of starting another.
    const again = createUserBrowser({ entry: path.join(FIXTURES, "fake-devtools-mcp.mjs"), profileDir, chromePath, log: (m: string) => logs.push(`again: ${m}`) });
    expect(textOf(await again.handle(call("list_pages")))).toMatch(/^1: \(about:blank\)$/m);
    expect(logs).toContain("again: ai chrome found running");
    again.close();
    await until(() => calls().at(-1)!.method === "Browser.close");
  } finally {
    browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("sends the agent to the sandbox browser when Chrome is not installed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-browser-"));
  const browser = createUserBrowser({ entry: path.join(FIXTURES, "fake-devtools-mcp.mjs"), profileDir: path.join(dir, "profile"), chromePath: path.join(dir, "missing"), log: () => undefined });
  try {
    expect(await browser.status()).toEqual({ available: false, connected: false });
    expect(result(await browser.handle(call("list_pages")))).toEqual({ content: [{ type: "text", text: UNAVAILABLE }], isError: true });
  } finally {
    browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
