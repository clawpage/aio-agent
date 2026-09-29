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
  await startServer();
});

afterAll(async () => {
  if (!hasChromium) return;
  server.close();
  await browser.close();
});

type Rpc = { result?: { content: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message: string } };
async function call(task: string | null, name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (task) Object.assign(headers, { "x-aio-task": task, "x-aio-task-title": encodeURIComponent(`任务${task}`) });
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return (await res.json()) as Rpc;
}
const text = (r: Rpc) => (r.result?.content ?? []).map((c) => c.text ?? "<image>").join("\n");
const post = async (route: string, body: unknown = {}) => (await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify(body) })).json();
const records = async () => ((await (await fetch(`${base}/tabs`)).json()) as { tabs: Array<{ id: string; key: string; title: string; finishedAt: number | null }> }).tabs;
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
