import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright-core";

// The real tab server against a real headless Chromium over CDP. CI has no
// browser installed, so the test only runs where Playwright's Chromium exists.
const hasChromium = fs.existsSync(chromium.executablePath());
const require = createRequire(import.meta.url);

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

beforeAll(async () => {
  if (!hasChromium) return;
  const cdpPort = await freePort();
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  process.env.AIO_TABS_CDP = `http://127.0.0.1:${cdpPort}`;
  process.env.AIO_TABS_PLAYWRIGHT = require.resolve("playwright-core");
  process.env.AIO_TABS_OUTPUT = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tabs-"));
  const mod = require("../../src/server/browser/scripts/tab-server.cjs") as { server: import("node:http").Server };
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  if (!hasChromium) return;
  server.close();
  await browser.close();
});

async function call(task: string | null, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(task ? { "x-aio-task": task } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()) as { result?: { content: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message: string } };
}
const text = (r: Awaited<ReturnType<typeof call>>) => (r.result?.content ?? []).map((c) => c.text ?? "<image>").join("\n");
const page = (title: string, body: string) => `data:text/html,<title>${title}</title><p id="p">${body}</p><input id="q"><a href="data:text/html,<title>Next</title>next">go</a>`;

it.skipIf(!hasChromium)("gives each task its own tabs in one shared browser, in parallel", async () => {
  const init = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) });
  expect(init.headers.get("mcp-session-id")).toBeTruthy();
  expect(JSON.stringify(await init.json())).toContain("aio_tabs");

  const [a, b] = await Promise.all([call("taskA", "browser_navigate", { url: page("Alpha", "alpha body") }), call("taskB", "browser_navigate", { url: page("Beta", "beta body") })]);
  expect(text(a)).toContain("Alpha");
  expect(text(b)).toContain("Beta");
  expect(text(await call("taskA", "browser_get_text"))).toContain("alpha body");
  expect(text(await call("taskB", "browser_get_text"))).toContain("beta body");

  // Each task lists only its own tabs.
  expect(text(await call("taskA", "browser_tab_list"))).not.toContain("Beta");
  expect(text(await call("taskB", "browser_tab_list"))).not.toContain("Alpha");

  // Interaction stays in the caller's tab.
  await call("taskA", "browser_fill", { selector: "#q", text: "hello" });
  expect(text(await call("taskA", "browser_evaluate", { script: "document.querySelector('#q').value" }))).toBe("hello");
  expect(text(await call("taskB", "browser_evaluate", { script: "document.querySelector('#q').value" }))).toBe("");
  expect(text(await call("taskA", "browser_click", { selector: "text=go" }))).toContain("Next");

  // A task without tabs gets a tool error; a failure never takes the server down.
  const none = await call("taskC", "browser_get_text");
  expect(none.result?.isError).toBe(true);
  expect(text(await call("taskA", "browser_get_text"))).toContain("next");
  // No task identity: refused outright.
  expect((await call(null, "browser_get_text")).error?.message).toBe("missing task identity");

  const pages = async () => ((await (await fetch(`${process.env.AIO_TABS_CDP}/json/list`)).json()) as Array<{ type: string }>).filter((t) => t.type === "page").length;
  const before = await pages();
  const released = await (await fetch(`${base}/release`, { method: "POST", body: JSON.stringify({ key: "taskA" }) })).json();
  expect(released).toEqual({ closed: 1 });
  expect(await pages()).toBe(before - 1);
  expect(text(await call("taskB", "browser_get_text"))).toContain("beta body");
});
