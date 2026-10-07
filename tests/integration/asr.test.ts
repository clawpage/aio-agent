import http from "node:http";
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
  expect(await (await h.request("/api/asr", { headers: { cookie } })).json()).toEqual({ enabled: true });
  const other = await login(off);
  expect(await (await off.request("/api/asr", { headers: { cookie: other.cookie } })).json()).toEqual({ enabled: false });
  expect((await post(off, { audioBase64: recording.toString("base64") })).status).toBe(404);
});

it("relays the WAV to the speech server and returns only the text", async () => {
  received = [];
  answer = { status: 200, text: " 打开走廊灯。 " };
  const res = await post(h, { audioBase64: recording.toString("base64") });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "打开走廊灯。" });
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
