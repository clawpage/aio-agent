import { it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain ESM script without types
import { createUserBrowser, filterTools, refused, UNAVAILABLE } from "../../bin/user-browser.mjs";

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

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
  ]);
  expect(tools).toEqual([{ name: "take_screenshot", inputSchema: { type: "object", properties: { pageId: {} }, required: ["pageId"] } }]);
});

/** A stdio MCP server standing in for chrome-devtools-mcp: lists two tools and echoes the call it got. */
const FAKE_SERVER = `
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "chrome_devtools", version: "x" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "list_pages", inputSchema: { type: "object", properties: {} } }, { name: "upload_file", inputSchema: { type: "object", properties: {} } }] } });
  send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "called " + m.params.name + " " + process.argv.slice(2).join(" ") }] } });
});
`;

it("answers the gateway from one session with the browser tools, and only while Chrome is open for remote debugging", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-browser-"));
  const entry = path.join(dir, "server.mjs");
  fs.writeFileSync(entry, FAKE_SERVER);
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  const chrome = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => chrome.listen(0, "127.0.0.1", resolve));
  const browser = createUserBrowser({ entry, userDataDir: profile, log: () => undefined });
  try {
    expect(await browser.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await browser.handle({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-06-18" } }))
      .toEqual({ jsonrpc: "2.0", id: 7, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chrome_devtools", version: "x" } } });
    expect(await browser.handle({ jsonrpc: "2.0", id: 8, method: "tools/list" }))
      .toEqual({ jsonrpc: "2.0", id: 8, result: { tools: [{ name: "list_pages", inputSchema: { type: "object", properties: {} } }] } });

    // No Chrome open for remote debugging: the call says so at once, without reaching the browser tools.
    expect(await browser.status()).toEqual({ available: false, connected: false });
    expect(await browser.handle(call("list_pages"))).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: UNAVAILABLE }], isError: true } });

    // Chrome open: the call goes to the tools, attached to the user's Chrome profile, under the gateway's own id.
    fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${(chrome.address() as net.AddressInfo).port}\n/devtools/browser/x\n`);
    const answer = (await browser.handle({ ...call("list_pages"), id: "req-9" })) as { id: unknown; result: { content: Array<{ text: string }> } };
    expect(answer.id).toBe("req-9");
    expect(answer.result.content[0]!.text).toBe(`called list_pages --autoConnect --userDataDir ${profile} --performanceCrux=false`);
    expect(await browser.status()).toEqual({ available: true, connected: true });
    expect((await browser.handle(call("upload_file"))) as unknown).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: expect.stringMatching(/not available/) }], isError: true } });

    // Chrome closed again (a stale port file): unavailable once more.
    chrome.close();
    expect(await browser.handle(call("list_pages"))).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: UNAVAILABLE }], isError: true } });
  } finally {
    browser.close();
    chrome.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
