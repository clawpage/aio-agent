import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";

let h: TestHarness;
const TOKEN = "gadget-test-token-0123456789";
const BRIDGE_TOKEN = "b".repeat(64);
const dictate = (text: unknown, token = TOKEN) =>
  h.request("/api/gadget/dictation", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });

const POLISHED = "<text>明天下午三点开会，记得带电脑。</text>";
const model = { fail: false, reply: POLISHED, requests: [] as Array<{ headers: http.IncomingHttpHeaders; body: any }> };
const bridge = { status: 200, url: "", typed: [] as Array<{ auth: string | undefined; text: string }> };
const kb = { calls: [] as Array<{ auth: string | undefined; body: any }> };
const servers: http.Server[] = [];

async function listen(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    handler(req, JSON.parse(Buffer.concat(chunks).toString() || "{}"), res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  h = await startHarness();
  fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-"));
  const claudeFile = path.join(dir, "claude.env");
  fs.writeFileSync(claudeFile, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n", { mode: 0o600 });
  const bridgeFile = path.join(dir, "keyboard.env");
  fs.writeFileSync(bridgeFile, `KEYBOARD_BRIDGE_TOKEN=${BRIDGE_TOKEN}\n`, { mode: 0o600 });
  const modelUrl = await listen((req, body, res) => {
    model.requests.push({ headers: req.headers, body });
    if (model.fail) { res.writeHead(529).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: [{ type: "text", text: model.reply }] }));
  });
  const bridgeUrl = await listen((req, body, res) => {
    bridge.typed.push({ auth: req.headers.authorization, text: body.text });
    res.writeHead(bridge.status, { "content-type": "application/json" }).end("{}");
  });
  const kbUrl = await listen((req, body, res) => {
    kb.calls.push({ auth: req.headers.authorization, body });
    const rows = { columns: ["name", "n"], rows: [["Roy", 512], ["Rui Chao", 306]], truncated: false };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(rows) }] } }));
  });
  const kbFile = path.join(dir, "kb.env");
  fs.writeFileSync(kbFile, "KB_MCP_TOKEN=kb-test-token\n", { mode: 0o600 });
  h.ctx.cfg.kbMcp = { upstreamUrl: `${kbUrl}/mcp`, secretsFile: kbFile, members: [] };
  await createMember(h.ctx.db, "guest", "member-password-123");
  Object.assign(h.ctx.cfg.claudeCode, { enabled: "on", secretsFile: claudeFile, apiBaseUrl: modelUrl });
  h.ctx.cfg.keyboardBridge = { url: "", secretsFile: bridgeFile };
  h.ctx.cfg.polishModel = "claude-sonnet-5-5";
  bridge.url = bridgeUrl;
});
afterAll(async () => {
  for (const s of servers) s.close();
  await h?.shutdown();
});

it("refuses a caller without the gadget token, and is absent until a keyboard bridge is configured", async () => {
  expect((await dictate("你好", "not-the-token")).status).toBe(401);
  expect((await dictate("你好")).status).toBe(404);
  expect(bridge.typed).toHaveLength(0);
});

it("polishes the transcript with the configured model and types the result", async () => {
  h.ctx.cfg.keyboardBridge.url = bridge.url;
  const res = await dictate("嗯那个明天下午三点开会呃记得带电脑");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "明天下午三点开会，记得带电脑。", polished: true });
  const sent = model.requests.at(-1)!;
  expect(sent.headers.authorization).toBe("Bearer sk-ant-oat-test");
  expect(sent.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  expect(sent.body.model).toBe("claude-sonnet-5-5");
  expect(sent.body.output_config).toEqual({ effort: "low" });
  expect(sent.body.messages[0].content).toContain("嗯那个明天下午三点开会呃记得带电脑");
  expect(bridge.typed.at(-1)).toEqual({ auth: `Bearer ${BRIDGE_TOKEN}`, text: "明天下午三点开会，记得带电脑。" });
});

it("types the transcript as heard when the model can't be reached", async () => {
  model.fail = true;
  const res = await dictate("你好世界");
  model.fail = false;
  expect(await res.json()).toEqual({ text: "你好世界", polished: false });
  expect(bridge.typed.at(-1)!.text).toBe("你好世界");
});

it("enters only the last <text> block, never the model's deliberation", async () => {
  model.reply = "<text>帮我去淘宝选一个裤子。</text>\n\nWait, I need to correct that: 露露联 e e is likely lululemon.\n\n<text>帮我去 lululemon 选一条直筒裤。</text>";
  let res = await dictate("帮我去露露联 e e 选一个裤子那种直筒的裤子");
  expect(await res.json()).toEqual({ text: "帮我去 lululemon 选一条直筒裤。", polished: true });
  // A reply without a <text> block may be all deliberation: type what was heard.
  model.reply = "Hmm, 露露联 might be lululemon. 帮我去 lululemon 选一条直筒裤。";
  res = await dictate("帮我去露露联选一条直筒裤");
  model.reply = POLISHED;
  expect(await res.json()).toEqual({ text: "帮我去露露联选一条直筒裤", polished: false });
  expect(bridge.typed.at(-1)!.text).toBe("帮我去露露联选一条直筒裤");
});

it("says so when the Mac hasn't allowed the bridge to type, and rejects empty text", async () => {
  bridge.status = 403;
  const res = await dictate("你好");
  bridge.status = 200;
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "not_trusted" });
  const before = bridge.typed.length;
  expect((await dictate("  ")).status).toBe(400);
  expect((await dictate(42)).status).toBe(400);
  expect(bridge.typed).toHaveLength(before);
});

it("tells the model the knowledge base's names, only for an account the knowledge base is offered to", async () => {
  h.ctx.cfg.keyboardBridge.url = bridge.url;
  const systemOf = () => (model.requests.at(-1)!.body.system as Array<{ text: string }>).map((b) => b.text).join("\n");

  // The owner (the gadget's account when the token names none).
  await dictate("帮我给若伊约一下体检");
  expect(systemOf()).toContain("<names>\nRoy\nRui Chao\n</names>");
  expect(kb.calls).toHaveLength(1);
  expect(kb.calls[0]!.auth).toBe("Bearer kb-test-token");
  expect(kb.calls[0]!.body).toMatchObject({ method: "tools/call", params: { name: "kb_sql" } });

  // A member the knowledge base is not offered to.
  fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\nAIO_GADGET_USER=guest\n`, { mode: 0o600 });
  await dictate("帮我给若伊约一下体检");
  expect(systemOf()).not.toContain("<names>");
  h.ctx.cfg.kbMcp.members = ["guest"];
  await dictate("帮我给若伊约一下体检");
  expect(systemOf()).toContain("Rui Chao");
  // Read once, then reused.
  expect(kb.calls).toHaveLength(1);
  fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\n`, { mode: 0o600 });
});
