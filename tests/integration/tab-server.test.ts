import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright-core";
import { patchedPatchright } from "../helpers/patchright.js";

// The real tab server against a real headless Chromium over CDP. CI has no
// browser installed, so the test only runs where Playwright's Chromium exists.
const hasChromium = fs.existsSync(chromium.executablePath());
const require = createRequire(import.meta.url);
const SCRIPT = require.resolve("../../src/control/browser/scripts/tab-server.cjs");

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let browser: Browser;
let patchright = "";
let cgroup = "";
/** The fake cgroup the server reads: a 1 GB limit, `fraction` of it in use. */
const setMemory = (fraction: number, kills = 0) => {
  fs.writeFileSync(path.join(cgroup, "memory.max"), "1000000000\n");
  fs.writeFileSync(path.join(cgroup, "memory.current"), `${Math.round(fraction * 1e9)}\n`);
  fs.writeFileSync(path.join(cgroup, "memory.stat"), "anon 1\ninactive_file 0\n");
  fs.writeFileSync(path.join(cgroup, "memory.events"), `oom 0\noom_kill ${kills}\n`);
};
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
  // The library as the sandbox runs it: patched by the build (scripts/patchright-patch.mjs).
  patchright = await patchedPatchright();
  process.env.AIO_TABS_PLAYWRIGHT = patchright;
  process.env.AIO_TABS_OUTPUT = dir;
  process.env.AIO_TABS_WORKSPACE = path.join(dir, "workspace");
  cgroup = path.join(dir, "cgroup");
  fs.mkdirSync(cgroup);
  setMemory(0.1);
  process.env.AIO_TABS_CGROUP = cgroup;
  process.env.AIO_TABS_PERSON_IDLE_MS = "300";
  process.env.AIO_TABS_STRAY_IDLE_MS = "300";
  process.env.AIO_TABS_STATE = path.join(dir, "state.json");
  process.env.AIO_TABS_MAX_FINISHED = "2";
  process.env.AIO_TABS_HUMAN_WAIT_MS = "3000";
  process.env.AIO_TABS_TOOL_DEADLINE_MS = "4000";
  process.env.AIO_TABS_PROBE_MS = "1500";
  process.env.AIO_TABS_VAULT_STEP_MS = "1200";
  await startServer();
});

afterAll(async () => {
  if (!hasChromium) return;
  server.close();
  await browser.close();
  fs.rmSync(patchright, { recursive: true, force: true });
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
type TabRecord = { id: string; key: string; title: string; finishedAt: number | null; holder: string; request: { reason: string } | null; url?: string; loginReport?: unknown };
const records = async (key?: string) => ((await (await fetch(`${base}/tabs${key ? `?key=${key}` : ""}`)).json()) as { tabs: TabRecord[] }).tabs;
const control = async (tab: string, action: string, key?: string) => fetch(`${base}/control`, { method: "POST", body: JSON.stringify({ tab, action, key }) });
const page = (title: string, body: string) => `data:text/html,<title>${title}</title><p id="p">${body}</p><input id="q"><a href="data:text/html,<title>Next</title>next">go</a>`;
const tabIdOf = (r: Rpc) => /标签页 (t\d+)/.exec(text(r))?.[1];

it.skipIf(!hasChromium)("tells the agent to retry a human check in a fresh tab before asking the person", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const instructions = ((await res.json()) as { result: { instructions: string } }).result.instructions;
  const rule = instructions.split("\n").find((line) => line.includes("Press & Hold"))!;
  expect(rule).toContain("browser_tab_new");
  expect(rule.indexOf("browser_tab_new")).toBeLessThan(rule.indexOf("browser_request_human"));
});

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
  // The agent's script runs in the page's own world, so it sees what the page's scripts defined.
  await call("G", "browser_navigate", { url: "data:text/html,<title>G</title><script>window.pageGlobal = 42</script>" });
  expect(text(await call("G", "browser_evaluate", { script: "window.pageGlobal" }))).toBe("42");
  await call("G", "browser_tab_close", {});
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
  // Watching without taking over may still bring the page's window up, nothing more.
  expect((await point({ action: "focus" })).status).toBe(200);

  await control(tab, "take", "P");
  expect((await point({ action: "click", x: 2, y: 0.25 })).status).toBe(400);
  expect((await point({ action: "drag" })).status).toBe(400);
  expect(await (await point({ action: "click", x: 0.5, y: 0.25 })).json()).toMatchObject({ title: "tapped", editable: false });
  expect(await (await point({ action: "click", x: 0.5, y: 0.75 })).json()).toMatchObject({ editable: true });
  expect((await point({ action: "scroll", dy: 800 })).status).toBe(200);
  // The person watches the whole desktop: focus puts this tab's page in front.
  expect((await point({ action: "focus" })).status).toBe(200);
  const back = (await (await point({ action: "back" })).json()) as { title: string };
  await control(tab, "release", "P");
  expect(back.title).toBe("First");
});

it.skipIf(!hasChromium)("opens a person's link in their own tab: theirs to operate, invisible to every agent", async () => {
  const site = (await import("node:http")).createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/popup"
      ? "<title>Popup</title><p>popup</p>"
      : `<title>Link ${req.url}</title><body style="margin:0"><button style="position:fixed;left:0;top:0;width:100vw;height:50vh" onclick="window.open('/popup')">open</button><input id=q style="position:fixed;left:0;top:50vh;width:100vw;height:50vh">`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  const open = async (url: string) => (await (await fetch(`${base}/open`, { method: "POST", body: JSON.stringify({ url }) })).json()) as { tab: TabRecord & { targetId: string } };
  for (const bad of ["file:///etc/passwd", "file:///home/gem/workspace/../../../etc/passwd", "file://host/home/gem/workspace/a.html", "javascript:alert(1)"]) {
    expect((await fetch(`${base}/open`, { method: "POST", body: JSON.stringify({ url: bad }) })).status, bad).toBe(400);
  }

  const { tab } = await open(`${origin}/one`);
  expect(tab).toMatchObject({ key: "person", holder: "human", url: `${origin}/one`, title: "Link /one" });
  // No agent sees it, reads it or acts on it.
  expect(text(await call("Z", "browser_tab_list"))).not.toContain(origin);
  expect((await call("Z", "browser_get_text", { tab: tab.id })).result?.isError).toBe(true);
  expect(text(await call("Z", "browser_get_text", { tab: tab.id }))).toContain("用户正在操作");

  // The person types and taps without taking anything over; a window the page opens becomes theirs too.
  const act = async (route: string, body: Record<string, unknown>) => (await (await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify({ task: "person", tab: tab.id, ...body }) })).json()) as { current: string; editable?: boolean };
  expect(await act("/pointer", { action: "click", x: 0.5, y: 0.75 })).toMatchObject({ editable: true, current: tab.id });
  await act("/input", { text: "hello" });
  const opened = await act("/pointer", { action: "click", x: 0.5, y: 0.25 });
  await new Promise((r) => setTimeout(r, 500));
  const popup = (await records("person")).find((t) => t.id !== tab.id)!;
  expect(popup).toMatchObject({ holder: "human", url: `${origin}/popup` });
  expect((await act("/pointer", { action: "back" })).current).toBe(popup.id);
  expect(opened.current === popup.id || opened.current === tab.id).toBe(true);

  // Only the person's own tabs close from here, and only their latest three stay open.
  expect((await fetch(`${base}/close`, { method: "POST", body: JSON.stringify({ tab: tabIdOf(await call("Z", "browser_navigate", { url: page("Zed", "z") })) }) })).status).toBe(404);
  for (const n of ["two", "three", "four"]) await open(`${origin}/${n}`);
  const mine = await records("person");
  expect(mine).toHaveLength(3);
  expect(mine.map((t) => t.url)).not.toContain(`${origin}/one`);
  expect((await fetch(`${base}/close`, { method: "POST", body: JSON.stringify({ tab: mine[0]!.id }) })).status).toBe(200);
  expect(await records("person")).toHaveLength(2);
  // A workspace page the control plane resolved opens like a link.
  expect((await fetch(`${base}/open`, { method: "POST", body: JSON.stringify({ url: "file:///home/gem/workspace/%E6%8A%A5%E5%91%8A.html" }) })).status).toBe(200);
  expect(await records("person")).toHaveLength(3);
  site.close();
});

it.skipIf(!hasChromium)("never lets a browser tool hang a task, and clears a hung page", async () => {
  const tab = tabIdOf(await call("Q", "browser_navigate", { url: page("Slow", "slow") }))!;
  // A script that never settles: the call fails with a reason, the tab stays, and the next call is not stuck behind it.
  const pending = await call("Q", "browser_evaluate", { script: "new Promise(() => {})" });
  expect(pending.result?.isError).toBe(true);
  expect(text(pending)).toContain("超过 4 秒");
  expect(text(await call("Q", "browser_get_text"))).toContain("slow");
  // A renderer spinning forever is hung: its tab is closed so nothing else waits on it.
  const spun = await call("Q", "browser_evaluate", { script: "while (true) {}" });
  expect(text(spun)).toContain(`标签页 ${tab} 已无响应，已关闭`);
  await new Promise((r) => setTimeout(r, 500));
  expect((await records("Q")).map((t) => t.id)).not.toContain(tab);
}, 30_000);

it.skipIf(!hasChromium)("reconnects past a hung page left in the browser, closing it", async () => {
  const stray = await browser.newPage();
  await stray.goto("data:text/html,<title>Stray</title>stray");
  void stray.evaluate("while (true) {}").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  server.close();
  await startServer();
  // The reconnect heals in the background; with this test's 4 s tool deadline the
  // first call may give up first (production allows 90 s), a later one succeeds.
  let opened = await call("R", "browser_navigate", { url: page("After", "after") });
  for (let i = 0; i < 20 && opened.result?.isError; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    opened = await call("R", "browser_navigate", { url: page("After", "after") });
  }
  expect(opened.result?.isError, text(opened)).toBeFalsy();
  expect(text(await call("R", "browser_get_text"))).toContain("after");
  const titles = ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ type: string; title: string }>).filter((t) => t.type === "page").map((t) => t.title);
  expect(titles).not.toContain("Stray");
}, 90_000);

it.skipIf(!hasChromium)("cleans up finished and ownerless pages on request, never a running task's or a person's, always leaving one", async () => {
  const done = tabIdOf(await call("C1", "browser_navigate", { url: page("Done", "done") }))!;
  await post("/finish", { key: "C1" });
  const running = tabIdOf(await call("C2", "browser_navigate", { url: page("Running", "running") }))!;
  const held = tabIdOf(await call("C3", "browser_navigate", { url: page("Held", "held") }))!;
  await post("/finish", { key: "C3" });
  await control(held, "take", "C3");
  // Any task may run the cleanup, e.g. when the person says "close them all".
  const res = await call("Z", "browser_tabs_cleanup");
  expect(res.result?.isError).toBeFalsy();
  expect(text(res)).toContain(running);
  const left = (await records()).map((t) => t.id);
  expect(left).not.toContain(done);
  expect(left).toEqual(expect.arrayContaining([running, held]));
  await control(held, "release", "C3");
  // Closing the last tabs still leaves the browser a page (Chromium may exit with its last window).
  await post("/finish", { key: "C2" });
  await post("/finish", { key: "C3" });
  await call("Z", "browser_tabs_cleanup");
  expect((await records()).map((t) => t.id)).not.toEqual(expect.arrayContaining([running]));
  expect((await records()).map((t) => t.id)).not.toContain(held);
  const pages = ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ type: string }>).filter((t) => t.type === "page");
  expect(pages.length).toBeGreaterThanOrEqual(1);
}, 60_000);

it.skipIf(!hasChromium)("stops a service worker once no page of its site is open, keeping its registration", async () => {
  // This server's CDP connection attaches to every worker, which keeps Chromium from stopping idle ones.
  const http = await import("node:http");
  const site = async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/sw.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("self.addEventListener('fetch', () => {});");
      res.writeHead(200, { "content-type": "text/html" }).end("<title>SW</title><script>navigator.serviceWorker.register('/sw.js')</script>");
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    return { srv, url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/` };
  };
  const [closed, open] = [await site(), await site()];
  const workers = async () => ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ type: string; url: string }>)
    .filter((t) => t.type === "service_worker").map((t) => t.url);
  const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 50 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 200)); };
  const sweep = (require(SCRIPT) as { closeIdleWorkers: (now?: number) => Promise<string[]> }).closeIdleWorkers;
  try {
    await call("W1", "browser_navigate", { url: closed.url });
    await call("W2", "browser_navigate", { url: open.url });
    await until(async () => (await workers()).length >= 2);
    await call("W1", "browser_tab_close", {});
    // The first sweep only notes the idle worker; it is stopped once idle long enough.
    expect(await sweep()).toEqual([]);
    expect(await sweep(Date.now() + 61_000)).toEqual([`${closed.url}sw.js`]);
    await until(async () => !(await workers()).includes(`${closed.url}sw.js`));
    expect(await workers()).toEqual([`${open.url}sw.js`]);
    // Still registered: the next visit is controlled by it again.
    await call("W1", "browser_navigate", { url: closed.url });
    expect(text(await call("W1", "browser_evaluate", { script: "navigator.serviceWorker.getRegistrations().then((r) => r.length)" }))).toContain("1");
  } finally {
    await call("W1", "browser_tab_close", {});
    await call("W2", "browser_tab_close", {});
    closed.srv.close();
    open.srv.close();
  }
}, 60_000);

it.skipIf(!hasChromium)("closes a tab whose renderer crashed and keeps serving every other task", async () => {
  const tab = tabIdOf(await call("K", "browser_navigate", { url: page("Kaboom", "k") }))!;
  const { targetId } = (await records("K")).find((t) => t.id === tab) as TabRecord & { targetId: string };
  const target = ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ id: string; webSocketDebuggerUrl: string }>).find((t) => t.id === targetId)!;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.crash" }));
    ws.onclose = () => resolve(); ws.onerror = () => resolve(); setTimeout(resolve, 3000);
  });
  await expect.poll(async () => (await records("K")).map((t) => t.id), { timeout: 10_000 }).not.toContain(tab);
  expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: true });
  expect((await call("K", "browser_get_text", { tab })).result?.isError).toBe(true);
  // The task carries on in a fresh tab.
  expect(text(await call("K", "browser_navigate", { url: page("Again", "again body") }))).toContain("Again");
  expect(text(await call("K", "browser_get_text"))).toContain("again body");
});

it.skipIf(!hasChromium)("saves a product picture into the workspace, by element or by address with the page's own referer", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");
  const site = (await import("node:http")).createServer((req, res) => {
    // A store that refuses its pictures to anyone but its own pages.
    if (req.url === "/item.png") {
      if (!String(req.headers.referer ?? "").endsWith("/product")) { res.writeHead(403).end(); return; }
      res.setHeader("content-type", "image/png"); res.end(png); return;
    }
    if (req.url === "/logo.svg") { res.setHeader("content-type", "image/svg+xml"); res.end("<svg xmlns='http://www.w3.org/2000/svg'/>"); return; }
    // A product page declaring its picture, with a version parameter its CDN insists on.
    if (req.url === "/shared.png?v=Q0wv&trace=1") {
      if (!String(req.headers.referer ?? "").endsWith("/declared")) { res.writeHead(403).end(); return; }
      res.setHeader("content-type", "image/png"); res.end(png); return;
    }
    if (req.url === "/shared.png") { res.writeHead(404).end(); return; }
    if (req.url === "/declared") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end('<meta property="og:image" content="/shared.png?v=Q0wv&trace=1"><title>Declared</title><img src="/item.png" width="300" height="300">'); return; }
    if (req.url === "/gallery") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end('<title>Gallery</title><img src="/logo-small.png" width="40" height="40"><img id="big" src="/item.png?big" width="320" height="320">'); return; }
    if (req.url === "/item.png?big") {
      if (!String(req.headers.referer ?? "").endsWith("/gallery")) { res.writeHead(403).end(); return; }
      res.setHeader("content-type", "image/png"); res.end(png); return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<title>Product</title><div id="gallery"><img id="main" src="/item.png" width="40" height="40"></div><div id="card" style="width:200px;height:100px;background:#2a6">卡片</div>');
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  const ws = process.env.AIO_TABS_WORKSPACE!;
  await call("S", "browser_navigate", { url: `${origin}/product` });

  const card = await call("S", "browser_save_image", { selector: "#card", path: `${ws}/tasks/t1/card.jpg` });
  expect(text(card)).toContain(`已保存：${ws}/tasks/t1/card.jpg`);
  expect([...fs.readFileSync(`${ws}/tasks/t1/card.jpg`).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const saved = await call("S", "browser_save_image", { url: "/item.png", path: `${ws}/tasks/t1/item.png` });
  expect(saved.result?.isError).toBeUndefined();
  expect(fs.readFileSync(`${ws}/tasks/t1/item.png`).equals(png)).toBe(true);
  // A picture element (or one holding a picture) is downloaded as the original, with the page's referer.
  for (const selector of ["#main", "#gallery"]) {
    const target = `${ws}/tasks/t1/by-${selector.slice(1)}.png`;
    expect((await call("S", "browser_save_image", { selector, path: target })).result?.isError, selector).toBeUndefined();
    expect(fs.readFileSync(target).equals(png), selector).toBe(true);
  }

  for (const [args, why] of [
    [{ selector: "#card", path: "/etc/card.jpg" }, "outside the workspace"],
    [{ selector: "#card", path: `${ws}/../escape.jpg` }, "climbing out"],
    [{ selector: "#card", path: `${ws}/tasks/t1/card.txt` }, "not a picture"],
    [{ url: "/logo.svg", path: `${ws}/tasks/t1/logo.png` }, "an SVG"],
    [{ path: `${ws}/tasks/t1/none.jpg` }, "no picture on the page to pick"],
  ] as const) {
    expect((await call("S", "browser_save_image", args)).result?.isError, why).toBe(true);
  }
  expect(fs.existsSync(path.join(ws, "..", "escape.jpg"))).toBe(false);

  // Only a path: the page's declared picture, fetched exactly (no one copies its address).
  await call("S", "browser_navigate", { url: `${origin}/declared` });
  expect(text(await call("S", "browser_save_image", { path: `${ws}/tasks/t1/declared.png` }))).toContain("已保存");
  expect(fs.readFileSync(`${ws}/tasks/t1/declared.png`).equals(png)).toBe(true);
  // No declared picture: the largest one on the page.
  await call("S", "browser_navigate", { url: `${origin}/gallery` });
  expect(text(await call("S", "browser_save_image", { path: `${ws}/tasks/t1/largest.png` }))).toContain("已保存");
  expect(fs.readFileSync(`${ws}/tasks/t1/largest.png`).equals(png)).toBe(true);
  site.close();
});

it.skipIf(!hasChromium)("frees memory near the limit, least valuable pages first, never a running task's or a held tab", async () => {
  const { reclaimMemory } = require(SCRIPT) as { reclaimMemory: (reason: string) => Promise<string[]> };
  const html = (title: string, extra = "") => `data:text/html,<title>${title}</title>${extra}`;
  // A running task, a finished one, one taken over by the person, the person's own idle page, and a page nobody tracks.
  const running = tabIdOf(await call("MR", "browser_navigate", { url: html("Running") }))!;
  await call("MF", "browser_navigate", { url: html("Finished") });
  await post("/finish", { key: "MF" });
  const held = tabIdOf(await call("MH", "browser_navigate", { url: html("Held") }))!;
  expect((await control(held, "take")).status).toBe(200);
  const site = (await import("node:http")).createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Person</title>person"); });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const personUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/`;
  expect((await fetch(`${base}/open`, { method: "POST", body: JSON.stringify({ url: personUrl }) })).status).toBe(200);
  await fetch(`${process.env.AIO_TABS_CDP}/json/new?${encodeURIComponent(html("Stray"))}`, { method: "PUT" });
  // And one the person was typing into.
  const typing = (await (await fetch(`${process.env.AIO_TABS_CDP}/json/new?${encodeURIComponent(html("Typing", "<input id=q>"))}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
  const typed = await new Promise<string>((resolve) => {
    const ws = new WebSocket(typing.webSocketDebuggerUrl);
    // Once the field exists (the page may still be loading), type into it.
    const expression = "new Promise((done) => { const t = setInterval(() => { const q = document.querySelector('#q'); if (q) { clearInterval(t); q.value = '还没提交的话'; done(q.value); } }, 20); })";
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) { ws.close(); resolve(m.result?.result?.value); } };
  });
  expect(typed).toBe("还没提交的话");
  await new Promise((r) => setTimeout(r, 600));
  const titles = async () => ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ type: string; title: string }>).filter((t) => t.type === "page").map((t) => t.title);
  try {
    // Below the high mark nothing is touched.
    setMemory(0.8);
    expect(await reclaimMemory("poll")).toEqual([]);
    // High but not critical: finished tabs, then the person's idle tabs; untracked pages stay.
    setMemory(0.88);
    const first = await reclaimMemory("poll");
    expect(first.join(" ")).toContain("Finished");
    expect(first).toContain(personUrl);
    expect(first.join(" ")).not.toContain("Stray");
    expect(await titles()).toEqual(expect.arrayContaining(["Running", "Held", "Stray"]));
    // A page about to open goes all the way: an untracked page left alone gives way too.
    await new Promise((r) => setTimeout(r, 400));
    setMemory(0.95);
    await call("MN", "browser_navigate", { url: html("Needed") });
    const left = await titles();
    expect(left).not.toContain("Stray");
    expect(left).toEqual(expect.arrayContaining(["Running", "Held", "Needed", "Typing"]));
    expect(left).not.toContain("Finished");
    // The server reports its memory for the control plane.
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ memory: { usedMb: 906, maxMb: 954, oomKills: 0 } });
    expect((await records("MR")).map((t) => t.id)).toContain(running);

    // After a restart nothing is attached yet: pressure alone attaches, re-claims the record and frees.
    await post("/finish", { key: "MN" });
    server.close();
    await startServer();
    const { reclaimMemory: restarted } = require(SCRIPT) as { reclaimMemory: (reason: string) => Promise<string[]> };
    expect((await restarted("oom")).join(" ")).toContain("Needed");
  } finally {
    setMemory(0.1);
    await control(held, "release");
    site.close();
  }
});

it.skipIf(!hasChromium)("signs in from the vault: the agent only asks, the page gets the account and password, no tool ever returns them", async () => {
  const SECRET = "s3cret-пароль-密码";
  const received: string[] = [];
  const html = (body: string) => `<!doctype html><meta charset="utf-8"><title>Sign in</title>${body}`;
  const pages: Record<string, string> = {
    "/login": html(`<form method="post" action="/done"><input name="q" type="search"><input name="username"><input type="password" name="password"><button>登录</button></form>`),
    // A script-driven form: nothing navigates, and the framework mirrors the value into the attribute.
    "/spa": html(`<form id="f"><input name="email" type="email"><input type="password" name="password"><button>Sign in</button></form><script>
      const pw = document.querySelector('[type=password]'); pw.addEventListener('input', () => pw.setAttribute('value', pw.value));
      document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); fetch('/done', { method: 'POST', body: new URLSearchParams(new FormData(e.target)) }); });
    </script>`),
    "/first": html(`<form method="get" action="/second"><input type="email" name="email"><button>Next</button></form>`),
    "/second": html(`<form method="post" action="/done"><input type="password" name="password"><button>Sign in</button></form>`),
    "/none": html(`<p>no form here</p>`),
  };
  const site = (await import("node:http")).createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { received.push(decodeURIComponent(body.replace(/\+/g, " "))); res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<title>Welcome</title>signed in"); });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[url.pathname] ?? "<title>404</title>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  const login = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/login`, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { result?: string; error?: string } };
  };
  /** The agent asks and waits; the control plane answers once the request is on record. */
  const ask = (task: string) => call(task, "browser_login");
  const asked = async (task: string) => {
    for (let i = 0; i < 60 && !(await records(task)).some((t) => (t.request as { kind?: string } | null)?.kind === "login"); i += 1) await new Promise((r) => setTimeout(r, 50));
  };
  const cred = { site: "127.0.0.1", username: "max@example.com", password: SECRET };
  try {
    // Nothing is typed unless the task's agent asked for it.
    const tab = tabIdOf(await call("V", "browser_navigate", { url: `${origin}/login` }))!;
    expect((await login({ key: "V", tab, ...cred })).status).toBe(409);

    const waiting = ask("V");
    await asked("V");
    expect((await records("V"))[0]?.request).toMatchObject({ kind: "login", site: "127.0.0.1" });
    // Another task's key, and an account saved for another site, are both refused.
    expect((await login({ key: "OTHER", tab, ...cred })).status).toBe(404);
    expect((await login({ key: "V", tab, ...cred, site: "example.com" })).body.error).toBe("site_changed");
    expect(received).toEqual([]);
    expect((await login({ key: "V", tab, ...cred })).body.result).toBe("submitted");
    const answered = await waiting;
    expect(text(answered)).toContain("密码器已填入账号密码并提交");
    expect(text(answered)).toContain("Welcome");
    expect(JSON.stringify(answered)).not.toContain(SECRET);
    expect(JSON.stringify(answered)).not.toContain("max@example.com");
    // The account went into the box before the password box, not into the search box.
    expect(received).toEqual([`q=&username=max@example.com&password=${SECRET}`]);
    expect((await records("V"))[0]?.request).toBeNull();
    expect(fs.readFileSync(process.env.AIO_TABS_STATE!, "utf8")).not.toContain(SECRET);

    // A form that stays on screen: what was typed is gone before the agent can read the page again.
    await call("V", "browser_navigate", { url: `${origin}/spa`, tab });
    // A script the agent ran earlier cannot watch the typing: the page is loaded afresh first.
    await call("V", "browser_evaluate", { tab, script: "document.addEventListener('input', (e) => { window.__spy = (window.__spy || '') + e.target.value; }, true); 1" });
    const spa = ask("V");
    await asked("V");
    expect((await login({ key: "V", tab, ...cred })).body.result).toBe("submitted");
    expect(JSON.stringify(await spa)).not.toContain(SECRET);
    expect(received[1]).toBe(`email=max@example.com&password=${SECRET}`);
    expect(text(await call("V", "browser_evaluate", { tab, script: "JSON.stringify([document.querySelector('[type=password]').value, String(window.__spy)])" }))).toBe('["","undefined"]');
    expect(text(await call("V", "browser_get_html", { tab }))).not.toContain(SECRET);

    // Account first, password on the next page.
    await call("V", "browser_navigate", { url: `${origin}/first`, tab });
    const twoStep = ask("V");
    await asked("V");
    expect((await login({ key: "V", tab, ...cred })).body.result).toBe("submitted");
    expect(text(await twoStep)).toContain("Welcome");
    expect(received[2]).toBe(`password=${SECRET}`);

    // No form: the agent is told to open one, and nothing is typed anywhere.
    await call("V", "browser_navigate", { url: `${origin}/none`, tab });
    const none = ask("V");
    await asked("V");
    expect((await login({ key: "V", tab, ...cred })).body.result).toBe("no_form");
    expect(text(await none)).toContain("没有找到账号或密码输入框");
    expect(received).toHaveLength(3);

    // A site that signs in with Google: nothing is typed, the agent is told which button and account.
    await call("V", "browser_navigate", { url: `${origin}/login`, tab });
    const google = ask("V");
    await asked("V");
    expect((await login({ key: "V", tab, site: "example.com", method: "google", username: "max@gmail.com" })).body.error).toBe("site_changed");
    expect((await login({ key: "V", tab, site: "127.0.0.1", method: "google", username: "max@gmail.com" })).body.result).toBe("google");
    const told = text(await google);
    expect(told).toContain("用 Google 登录");
    expect(told).toContain("Google 账号 max@gmail.com");
    expect(received).toHaveLength(3);
    expect((await records("V"))[0]?.request).toBeNull();

    // Skipping the vault: the person signs in by hand, as before.
    await call("V", "browser_navigate", { url: `${origin}/login`, tab });
    const manual = ask("V");
    await asked("V");
    expect((await control(tab, "take", "V")).status).toBe(200);
    expect((await login({ key: "V", tab, ...cred })).body.error).toBe("no_request");
    expect((await control(tab, "release", "V")).status).toBe(200);
    expect(text(await manual)).toContain("用户选择自己在浏览器里登录");
  } finally {
    await post("/finish", { key: "V" });
    site.close();
  }
});

it.skipIf(!hasChromium)("signs in with steps the agent wrote, from the vault's values: retries on a step's error, refuses the password outside a password box, gives up after three tries", async () => {
  const SECRET = "pw-秘密-123";
  const received: string[] = [];
  // Like 99 Ranch: the sign-in lives in a dialog behind a button, behind a tab that defaults to a text code.
  const home = `<!doctype html><meta charset="utf-8"><title>Shop</title><button id="open">Sign in / Sign up</button>
    <div id="dlg" hidden><button id="code">Code login</button><button id="pw">Password login</button>
      <form id="f" method="post" action="/done"><input id="acct" name="acct" placeholder="Phone or email"><input id="secret" name="secret" type="password" hidden><input id="note" name="note"><button>Log in</button></form></div>
    <script>const $ = (id) => document.getElementById(id); $("open").onclick = () => { $("dlg").hidden = false; }; $("pw").onclick = () => { $("secret").hidden = false; };</script>`;
  const site = (await import("node:http")).createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(decodeURIComponent(b)); res.end("<title>Account</title>welcome"); }); return; }
    res.end(home);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  const login = async (body: Record<string, unknown>) => (await (await fetch(`${base}/login`, { method: "POST", body: JSON.stringify(body) })).json()) as { result?: string; error?: string };
  const asked = async (task: string) => { for (let i = 0; i < 60 && !(await records(task)).some((t) => (t.request as { kind?: string } | null)?.kind === "login"); i += 1) await new Promise((r) => setTimeout(r, 50)); };
  const cred = { site: "127.0.0.1", username: "max@example.com", password: SECRET };
  const good = [
    { action: "click", selector: "#open" }, { action: "click", selector: "text=Password login" },
    { action: "fill", selector: "#acct", value: "{{username}}" }, { action: "fill", selector: "#secret", value: "{{password}}" },
    { action: "press", selector: "#secret", key: "Enter" },
  ];
  try {
    const tab = tabIdOf(await call("S", "browser_navigate", { url: origin }))!;
    // Steps are checked before anyone is asked.
    expect(text(await call("S", "browser_login", { steps: [{ action: "click", selector: "#open" }] }))).toContain("{{password}}");
    expect(text(await call("S", "browser_login", { steps: [{ action: "fill", selector: "#acct", value: "x{{password}}" }] }))).toContain("占位符");

    // The password is only ever typed into a password box: aimed at another box, nothing is typed and the try counts.
    const sneaky = call("S", "browser_login", { steps: [...good.slice(0, 2), { action: "fill", selector: "#note", value: "{{password}}" }] });
    await asked("S");
    expect((await login({ key: "S", tab, ...cred })).result).toBe("failed");
    expect(text(await sneaky)).toContain("不是密码框");
    expect(text(await sneaky)).toContain("还能再试 2 次");

    // A step that does not match: the agent hears which step and why, never a value.
    const wrong = call("S", "browser_login", { steps: [{ action: "click", selector: "#open" }, { action: "fill", selector: "#secret", value: "{{password}}" }] });
    await asked("S");
    expect((await login({ key: "S", tab, ...cred })).result).toBe("failed");
    const told = text(await wrong);
    expect(told).toContain("第 2 步（fill #secret）失败");
    expect(told).toContain("还能再试 1 次");
    expect(told).not.toContain(SECRET);
    expect(received).toEqual([]);

    // Revised steps open the dialog, switch to the password tab and sign in.
    const right = call("S", "browser_login", { steps: good });
    await asked("S");
    expect((await login({ key: "S", tab, ...cred })).result).toBe("submitted");
    expect(text(await right)).toContain("browser_login_report");
    expect(received).toEqual([`acct=max@example.com&secret=${SECRET}&note=`]);
    expect(JSON.stringify(await records("S"))).not.toContain(SECRET);
    // The agent reports what the page shows; the steps it used come with the report, for the vault to keep.
    expect(text(await call("S", "browser_login_report", { ok: true }))).toContain("已记下");
    const report = (await records("S"))[0]!.loginReport as unknown as { ok: boolean; steps: unknown[]; startUrl: string; source: string };
    expect(report).toMatchObject({ ok: true, source: "agent", startUrl: `${origin}/` });
    expect(report.steps).toEqual(good);

    // Next time the agent asks without steps, the kept ones (sent by the vault) replay from where they worked.
    await call("S", "browser_navigate", { url: `${origin}/elsewhere`, tab });
    const again = call("S", "browser_login");
    await asked("S");
    expect((await login({ key: "S", tab, ...cred, steps: good, startUrl: `${origin}/` })).result).toBe("submitted");
    expect(text(await again)).toContain("上次在这个网站成功的步骤");
    expect(received).toHaveLength(2);

    // Three failed tries and the agent is told to hand it to the person.
    for (const note of ["还停在登录框", "提示密码错误", "又失败"]) {
      const t = call("S", "browser_login", { steps: good });
      await asked("S");
      await login({ key: "S", tab, ...cred });
      await t;
      await call("S", "browser_login_report", { ok: false, note });
    }
    const refused = text(await call("S", "browser_login", { steps: good }));
    expect(refused).toContain("browser_request_human");
    expect(refused).toContain("不要再调用 browser_login");
  } finally {
    await post("/finish", { key: "S" });
    site.close();
  }
});
