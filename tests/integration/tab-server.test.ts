import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright-core";

// The real tab server against a real headless Chromium over CDP. CI has no
// browser installed, so the test only runs where Playwright's Chromium exists.
const hasChromium = fs.existsSync(chromium.executablePath());
const require = createRequire(import.meta.url);
const SCRIPT = require.resolve("../../src/server/browser/scripts/tab-server.cjs");

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let browser: Browser;
let base = "";
let server: import("node:http").Server;

/** Load a fresh copy of the server module (a restart), listening on its own port. */
async function startServer(): Promise<void> {
  delete require.cache[SCRIPT];
  server = (require(SCRIPT) as { server: import("node:http").Server }).server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

beforeAll(async () => {
  if (!hasChromium) return;
  const cdpPort = await freePort();
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabs-"));
  process.env.AIO_TABS_CDP = `http://127.0.0.1:${cdpPort}`;
  process.env.AIO_TABS_PLAYWRIGHT = require.resolve("playwright-core");
  process.env.AIO_TABS_OUTPUT = dir;
  process.env.AIO_TABS_STATE = path.join(dir, "state.json");
  process.env.AIO_TABS_MAX_FINISHED = "2";
  process.env.AIO_TABS_HUMAN_WAIT_MS = "3000";
  await startServer();
});

afterAll(async () => {
  if (!hasChromium) return;
  server.close();
  await browser.close();
});

type Rpc = { result?: { content: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message: string } };
async function call(task: string | null, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Rpc> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (task) Object.assign(headers, { "x-aio-task": task, "x-aio-task-title": encodeURIComponent(`任务${task}`) });
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return (await res.json()) as Rpc;
}
const text = (r: Rpc) => (r.result?.content ?? []).map((c) => c.text ?? "<image>").join("\n");
const post = async (route: string, body: unknown = {}) => (await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify(body) })).json();
type TabRecord = { id: string; key: string; title: string; finishedAt: number | null; holder: string; request: { reason: string } | null };
const records = async (key?: string) => ((await (await fetch(`${base}/tabs${key ? `?key=${key}` : ""}`)).json()) as { tabs: TabRecord[] }).tabs;
const control = async (tab: string, action: string, key?: string) => fetch(`${base}/control`, { method: "POST", body: JSON.stringify({ tab, action, key }) });
const page = (title: string, body: string) => `data:text/html,<title>${title}</title><p id="p">${body}</p><input id="q"><a href="data:text/html,<title>Next</title>next">go</a>`;
const tabIdOf = (r: Rpc) => /标签页 (t\d+)/.exec(text(r))?.[1];

it.skipIf(!hasChromium)("records each tab's creator: it alone may act, others may only read", async () => {
  const [a, b] = await Promise.all([call("A", "browser_navigate", { url: page("Alpha", "alpha body") }), call("B", "browser_navigate", { url: page("Beta", "beta body") })]);
  const tabA = tabIdOf(a)!, tabB = tabIdOf(b)!;
  expect(tabA).not.toBe(tabB);
  expect(await records()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: tabA, key: "A", title: "任务A", finishedAt: null }),
    expect.objectContaining({ id: tabB, key: "B", title: "任务B", finishedAt: null }),
  ]));

  // B sees A's tab as read-only, and may read it.
  expect(text(await call("B", "browser_tab_list"))).toMatch(new RegExp(`\\[${tabA}\\].*任务「任务A」，只读`));
  expect(text(await call("B", "browser_get_text", { tab: tabA }))).toContain("alpha body");
  expect((await call("B", "browser_screenshot", { tab: tabA })).result?.content[0]?.type).toBe("image");
  // …but never act on it.
  for (const [tool, args] of [["browser_click", { selector: "text=go" }], ["browser_fill", { selector: "#q", text: "x" }], ["browser_navigate", { url: "about:blank" }], ["browser_evaluate", { script: "1" }], ["browser_tab_close", {}]] as const) {
    const r = await call("B", tool, { ...args, tab: tabA });
    expect(r.result?.isError, tool).toBe(true);
    expect(text(r)).toContain("其他任务只能只读访问");
  }
  // The creator still acts on its own tab.
  await call("A", "browser_fill", { selector: "#q", text: "hello" });
  expect(text(await call("A", "browser_evaluate", { script: "document.querySelector('#q').value" }))).toBe("hello");
  expect(text(await call("B", "browser_get_text"))).toContain("beta body");
  // No identity: refused; unknown tab: a tool error, the server keeps serving.
  expect((await call(null, "browser_get_text")).error?.message).toBe("missing task identity");
  expect((await call("B", "browser_get_text", { tab: "t999" })).result?.isError).toBe(true);
  expect(text(await call("A", "browser_get_text"))).toContain("alpha body");
});

it.skipIf(!hasChromium)("keeps a finished task's tabs for a follow-up and destroys them on demand", async () => {
  const pages = async () => ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ type: string }>).filter((t) => t.type === "page").length;
  const before = await pages();
  expect(await post("/finish", { key: "A" })).toEqual({ finished: 1 });
  expect(await pages()).toBe(before);
  // A follow-up turn of A continues on its tab, which is live again.
  expect(text(await call("A", "browser_get_text"))).toContain("alpha body");
  expect((await records()).find((t) => t.key === "A")?.finishedAt).toBeNull();

  // Pruning (before an idle release) closes only finished tasks' tabs.
  await post("/finish", { key: "B" });
  expect(await post("/prune")).toEqual({ closed: 1 });
  expect(await pages()).toBe(before - 1);
  expect((await records()).map((t) => t.key)).toEqual(["A"]);

  // At most two finished tabs are kept; the least recently used goes first.
  for (const k of ["C", "D", "E"]) {
    await call(k, "browser_navigate", { url: page(k, k) });
    await post("/finish", { key: k });
  }
  await call("F", "browser_navigate", { url: page("F", "f") });
  expect((await records()).map((t) => t.key).sort()).toEqual(["A", "D", "E", "F"]);
});

it.skipIf(!hasChromium)("re-claims recorded tabs after the server restarts", async () => {
  const beforeRestart = await records();
  server.close();
  await startServer();
  // The first tool call reconnects and matches Chromium's target ids to the record.
  expect(text(await call("A", "browser_get_text"))).toContain("alpha body");
  expect((await records()).map((t) => [t.id, t.key]).sort()).toEqual(beforeRestart.map((t) => [t.id, t.key]).sort());
  const tabF = beforeRestart.find((t) => t.key === "F")!.id;
  expect(text(await call("A", "browser_click", { selector: "text=go", tab: tabF }))).toContain("其他任务只能只读访问");
});

it.skipIf(!hasChromium)("hands a tab to a person and back: the agent waits in place, nobody else touches it meanwhile", async () => {
  const tab = tabIdOf(await call("H", "browser_navigate", { url: page("Login", "please sign in") }))!;
  const waiting = call("H", "browser_request_human", { reason: "请登录你的账号" });
  await new Promise((r) => setTimeout(r, 200));
  expect((await records("H"))[0]).toMatchObject({ id: tab, holder: "ai", request: { reason: "请登录你的账号" } });

  // Only the owning task may hand it over.
  expect((await control(tab, "take", "someone-else")).status).toBe(403);
  expect((await control(tab, "take", "H")).status).toBe(200);
  expect((await records("H"))[0]?.holder).toBe("human");
  // While a person holds it no agent may even read it.
  const blocked = await call("OTHER", "browser_get_text", { tab });
  expect(text(blocked)).toContain("用户正在操作");
  // The control plane can still show the person a preview.
  const shot = (await (await fetch(`${base}/screenshot?tab=${tab}&key=H`)).json()) as { mimeType: string; data: string };
  expect(shot.mimeType).toBe("image/jpeg");
  expect(shot.data.length).toBeGreaterThan(100);
  expect((await fetch(`${base}/screenshot?tab=${tab}&key=OTHER`)).status).toBe(403);

  expect((await control(tab, "release", "H")).status).toBe(200);
  const handedBack = await waiting;
  expect(text(handedBack)).toContain("用户已交还控制权");
  expect((await records("H"))[0]).toMatchObject({ holder: "ai", request: null });
  expect(text(await call("OTHER", "browser_get_text", { tab }))).toContain("please sign in");
});

it.skipIf(!hasChromium)("stops waiting on timeout, on a stopped caller and on a finished task, clearing the request", async () => {
  const tab = tabIdOf(await call("W", "browser_navigate", { url: page("Wait", "wait") }))!;
  const timedOut = await call("W", "browser_request_human", { reason: "等你" });
  expect(timedOut.result?.isError).toBe(true);
  expect(text(timedOut)).toContain("还没有交还");
  expect((await records("W"))[0]?.request).toBeNull();

  const stop = new AbortController();
  const aborted = call("W", "browser_request_human", { reason: "等你" }, stop.signal).catch(() => null);
  await new Promise((r) => setTimeout(r, 200));
  stop.abort();
  await aborted;
  await new Promise((r) => setTimeout(r, 200));
  expect((await records("W"))[0]?.request).toBeNull();

  const finished = call("W", "browser_request_human", { reason: "等你" });
  await new Promise((r) => setTimeout(r, 200));
  await post("/finish", { key: "W" });
  expect(text(await finished)).toContain("停止等待");
  expect((await records("W")).find((t) => t.id === tab)?.request).toBeNull();
});

it.skipIf(!hasChromium)("opens every task tab in its own window", async () => {
  const [x, y] = await Promise.all([call("X", "browser_navigate", { url: page("X", "x") }), call("Y", "browser_navigate", { url: page("Y", "y") })]);
  expect(tabIdOf(x)).not.toBe(tabIdOf(y));
  const cdp = await browser.newBrowserCDPSession();
  const windowOf = async (key: string) => {
    const { targetId } = (await records(key))[0] as unknown as { targetId: string };
    return (await cdp.send("Browser.getWindowForTarget", { targetId })).windowId;
  };
  expect(await windowOf("X")).not.toBe(await windowOf("Y"));
  await cdp.detach();
});

it.skipIf(!hasChromium)("lets a person type and tap only in a tab they took over", async () => {
  const form = (title: string) => `data:text/html,<title>${title}</title><input id=q autofocus>`;
  const tabK = tabIdOf(await call("K", "browser_navigate", { url: form("FormK") }))!;
  const tabL = tabIdOf(await call("L", "browser_navigate", { url: form("FormL") }))!;
  const typeIn = async (body: Record<string, unknown>) => fetch(`${base}/input`, { method: "POST", body: JSON.stringify(body) });
  const valueOf = async (key: string) => text(await call(key, "browser_evaluate", { script: "document.querySelector('#q').value" }));

  // Nothing taken over: nothing is typed anywhere, however many pages are open.
  const refused = await typeIn({ text: "hi" });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { message: string }).message).toContain("先在任务卡片上点“接管”");
  // A named tab its agent still drives is refused too; a tab of another task is not found.
  expect((await typeIn({ tab: tabK, task: "K", text: "hi" })).status).toBe(409);
  expect((await typeIn({ tab: tabK, task: "L", text: "hi" })).status).toBe(404);

  await control(tabL, "take", "L");
  await control(tabK, "take", "K");
  // Unnamed input goes to the tab taken over last; a named one to that tab.
  expect((await typeIn({ text: "你好 world 👋" })).status).toBe(200);
  expect((await typeIn({ key: "Backspace" })).status).toBe(200);
  expect((await typeIn({ key: "F12" })).status).toBe(400);
  expect(((await (await typeIn({ tab: tabL, task: "L", text: "ell" })).json()) as { tab: string }).tab).toBe(tabL);
  await control(tabK, "release", "K");
  await control(tabL, "release", "L");
  expect(await valueOf("K")).toBe("你好 world 👋".slice(0, -2));
  expect(await valueOf("L")).toBe("ell");
  expect((await typeIn({ tab: tabL, task: "L", text: "x" })).status).toBe(409);
});

it.skipIf(!hasChromium)("taps, scrolls and goes back for a person in a held tab", async () => {
  const tall = "data:text/html,<title>Tall</title><body style='margin:0;height:5000px'><button style='position:fixed;left:0;top:0;width:100vw;height:50vh' onclick=\"document.title='tapped'\">tap</button><input style='position:fixed;left:0;top:50vh;width:100vw;height:50vh'>";
  const tab = tabIdOf(await call("P", "browser_navigate", { url: page("First", "first") }))!;
  await call("P", "browser_navigate", { url: tall });
  const point = async (body: Record<string, unknown>) => fetch(`${base}/pointer`, { method: "POST", body: JSON.stringify({ tab, task: "P", ...body }) });
  expect((await point({ action: "click", x: 0.5, y: 0.25 })).status).toBe(409);

  await control(tab, "take", "P");
  expect((await point({ action: "click", x: 2, y: 0.25 })).status).toBe(400);
  expect((await point({ action: "drag" })).status).toBe(400);
  expect(await (await point({ action: "click", x: 0.5, y: 0.25 })).json()).toMatchObject({ title: "tapped", editable: false });
  expect(await (await point({ action: "click", x: 0.5, y: 0.75 })).json()).toMatchObject({ editable: true });
  expect((await point({ action: "scroll", dy: 800 })).status).toBe(200);
  const back = (await (await point({ action: "back" })).json()) as { title: string };
  await control(tab, "release", "P");
  expect(back.title).toBe("First");
});
