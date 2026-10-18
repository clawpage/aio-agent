import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { wav } from "../../src/ui/src/voice.js";

// A stand-in for the speech server: answers what it was sent, or fails on demand.
let received: { type: string | undefined; body: Buffer }[] = [];
let answer: { status: number; text: string } = { status: 200, text: "" };
const speech = http.createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", c => parts.push(c));
  req.on("end", () => {
    received.push({ type: req.headers["content-type"], body: Buffer.concat(parts) });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify({ text: answer.text, raw: answer.text }));
  });
});
let h: TestHarness;
let off: TestHarness;

beforeAll(async () => {
  await new Promise<void>(resolve => speech.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(speech.address() as AddressInfo).port}/asr`;
  h = await startHarness({}, { configure: cfg => { cfg.asrUrl = url; } });
  off = await startHarness();
});
afterAll(async () => {
  await h?.shutdown();
  await off?.shutdown();
  speech.close();
});

const post = async (harness: TestHarness, body: unknown) => {
  const { cookie, csrf } = await login(harness);
  return harness.request("/api/asr", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
};
const recording = Buffer.from(wav(new Float32Array(1600).fill(0.25), 16_000));

it("says whether voice input is on, only to a logged-in console", async () => {
  expect((await h.request("/api/asr")).status).toBe(401);
  const { cookie } = await login(h);
  expect(await (await h.request("/api/asr", { headers: { cookie } })).json()).toEqual({ enabled: true, locales: ["zh-CN", "zh-TW", "en"] });
  const other = await login(off);
  expect(await (await off.request("/api/asr", { headers: { cookie: other.cookie } })).json()).toEqual({ enabled: false, locales: ["zh-CN", "zh-TW", "en"] });
  expect((await post(off, { audioBase64: recording.toString("base64") })).status).toBe(404);
});

it("relays the WAV to the speech server and returns only the text", async () => {
  received = [];
  answer = { status: 200, text: " 打开走廊灯。 " };
  const res = await post(h, { audioBase64: recording.toString("base64") });
  expect(res.status).toBe(200);
  // Without the owner's Claude credential the text comes back as heard.
  expect(await res.json()).toEqual({ text: "打开走廊灯。", polished: false });
  expect(received).toHaveLength(1);
  expect(received[0]!.type).toBe("audio/wav");
  expect(received[0]!.body.equals(recording)).toBe(true);
  // The browser's encoder writes the header the server checks: 16-bit mono PCM.
  expect(recording.toString("ascii", 0, 4)).toBe("RIFF");
  expect(recording.readUInt16LE(22)).toBe(1);
  expect(recording.readUInt16LE(34)).toBe(16);
  expect(recording.readUInt32LE(24)).toBe(16_000);
  expect(recording.readUInt32LE(40)).toBe(3200);
});

it("refuses what is not a WAV or is too long, and says when the speech server fails", async () => {
  received = [];
  expect((await post(h, { audioBase64: Buffer.from("not audio").toString("base64") })).status).toBe(400);
  expect((await post(h, {})).status).toBe(400);
  const long = Buffer.alloc(2 * 1024 * 1024 + 1);
  long.write("RIFF");
  expect((await post(h, { audioBase64: long.toString("base64") })).status).toBe(413);
  expect(received).toHaveLength(0);

  answer = { status: 500, text: "" };
  const failed = await post(h, { audioBase64: recording.toString("base64") });
  expect(failed.status).toBe(502);
  expect(((await failed.json()) as { message: string }).message).toContain("语音识别暂时不可用");
});

it("polishes what was heard with the dictation model, and falls back to it as heard", async () => {
  const requests: any[] = [];
  let fail = false;
  const model = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", c => parts.push(c));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(parts).toString()));
      if (fail) { res.writeHead(529).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: [{ type: "text", text: "<text>打开走廊的灯。</text>" }] }));
    });
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const claudeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asr-")), "claude.env");
  fs.writeFileSync(claudeFile, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n", { mode: 0o600 });
  const asrUrl = h.ctx.cfg.asrUrl;
  // A knowledge base that does not answer: the transcript is still polished, just without its names.
  const kbDown = http.createServer((_req, res) => { res.writeHead(500).end(); });
  await new Promise<void>(resolve => kbDown.listen(0, "127.0.0.1", resolve));
  const kbFile = path.join(path.dirname(claudeFile), "kb.env");
  fs.writeFileSync(kbFile, "KB_MCP_TOKEN=kb-test-token\n", { mode: 0o600 });
  const polishing = await startHarness({}, { configure: cfg => {
    cfg.asrUrl = asrUrl;
    cfg.kbMcp = { upstreamUrl: `http://127.0.0.1:${(kbDown.address() as AddressInfo).port}/mcp`, secretsFile: kbFile, members: [] };
    cfg.polishModel = "claude-sonnet-5-5";
    Object.assign(cfg.claudeCode, { enabled: "on", secretsFile: claudeFile, apiBaseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}` });
  } });
  try {
    answer = { status: 200, text: "嗯打开那个走廊灯" };
    expect(await (await post(polishing, { audioBase64: recording.toString("base64") })).json()).toEqual({ text: "打开走廊的灯。", polished: true });
    expect(requests.at(-1).model).toBe("claude-sonnet-5-5");
    expect(requests.at(-1).messages[0].content).toContain("嗯打开那个走廊灯");
    expect(JSON.stringify(requests.at(-1).system)).not.toContain("<names>");

    // Nothing heard: nothing to polish.
    answer = { status: 200, text: "" };
    expect(await (await post(polishing, { audioBase64: recording.toString("base64") })).json()).toEqual({ text: "", polished: false });
    expect(requests).toHaveLength(1);

    fail = true;
    answer = { status: 200, text: "你好世界" };
    expect(await (await post(polishing, { audioBase64: recording.toString("base64") })).json()).toEqual({ text: "你好世界", polished: false });
  } finally {
    await polishing.shutdown();
    model.close();
    kbDown.close();
  }
});

it("keeps the listed accounts' recordings with what was heard, for re-running the recognizer later", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-log-"));
  const logging = await startHarness({}, { configure: cfg => { cfg.asrUrl = h.ctx.cfg.asrUrl; cfg.voiceLog = { dir, users: ["owner"], days: 30 }; } });
  try {
    answer = { status: 200, text: "打开走廊灯。" };
    await post(logging, { audioBase64: recording.toString("base64") });
    answer = { status: 500, text: "" };
    expect((await post(logging, { audioBase64: recording.toString("base64") })).status).toBe(502);
    const [day] = fs.readdirSync(dir);
    const files = fs.readdirSync(path.join(dir, day!)).sort();
    expect(files.filter(f => f.endsWith(".wav"))).toHaveLength(2);
    const metas = files.filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(dir, day!, f), "utf8")));
    const heard = metas.find(m => m.asr)!;
    expect(heard).toMatchObject({ user: "owner", seconds: 0.1, asr: { url: h.ctx.cfg.asrUrl, text: "打开走廊灯。", raw: "打开走廊灯。" }, polish: { polished: false, text: "打开走廊灯。" }, error: null });
    expect(fs.readFileSync(path.join(dir, heard.id.split("/")[0], `${heard.id.split("/")[1]}.wav`)).equals(recording)).toBe(true);
    expect(metas.find(m => !m.asr)).toMatchObject({ user: "owner", error: "upstream 500" });
    expect(fs.statSync(path.join(dir, day!, files[0]!)).mode & 0o777).toBe(0o600);
  } finally {
    await logging.shutdown();
  }
  // Not listed: nothing kept (the default harness logs no one).
  expect(fs.existsSync(h.ctx.cfg.voiceLog.dir)).toBe(false);
});
