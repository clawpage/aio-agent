import { it, expect } from "vitest";
import path from "node:path";
import http from "node:http";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { TTS_POLICY, TtsGateway, chunkText, detectLanguage, readWav, ttsMcpServers, ttsThreadServers, writeWav, type SpeechFiles } from "../../src/control/ttsTool.js";
import { memberConfig } from "../../src/control/tenants.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";

/** A 24 kHz WAV of `n` samples, each the text's length (so the joined audio shows the order). */
const wavOf = (text: string, n = 4) => {
  const samples = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) samples.writeInt16LE(text.length, i * 2);
  return writeWav({ rate: 24_000, samples });
};

it("gives every account text to speech from one speech server, saved into that account's workspace", async () => {
  const h = await startHarness();
  // A stand-in for the speech server; it counts how many requests overlap.
  const seen: Array<{ text: string; speaker: string; language: string }> = [];
  let active = 0;
  let overlapped = false;
  let answer: { status: number; body?: Buffer | string } | null = null;
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    seen.push(body);
    active += 1;
    if (active > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    if (answer) return res.writeHead(answer.status, { "content-type": "text/plain" }).end(answer.body);
    res.writeHead(200, { "content-type": "audio/wav" }).end(wavOf(body.text));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const written = new Map<string, Map<string, Buffer>>();
  const filesFor = async (id: string): Promise<SpeechFiles> => {
    const mine = written.get(id) ?? new Map<string, Buffer>();
    written.set(id, mine);
    return { write: async (file, bytes) => { mine.set(file, bytes); } };
  };
  const tts = new TtsGateway({ port: 0, log: h.ctx.log, speechUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/tts`, workspace: "/home/gem/workspace", filesFor });
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tts);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    tts.provision(owner);
    // A member never inherits the owner's tool: the gateway gives it one of its own.
    expect(memberConfig(owner, "user_m", 18092).tts).toBeUndefined();
    const member = memberConfig(owner, "user_m", 18092);
    gateway.provision(member);
    expect(member.tts!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/tts\/[a-f0-9]{64}\/mcp$/);
    expect(member.tts!.url).not.toBe(owner.tts!.url);
    expect(ttsThreadServers(member)).toEqual({ aio_tts: { url: member.tts!.url, tool_timeout_sec: 1230 } });
    expect(ttsMcpServers(member)).toEqual({ aio_tts: { type: "http", url: member.tts!.url } });
    // Codex runs a thread's MCP server only when its exact URL is in the managed policy.
    expect(codexRequirementsToml(member)).toContain(`[mcp_servers.aio_tts.identity]\nurl = "${member.tts!.url}"\n`);

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const call = async (url: string, args: Record<string, unknown>) => (await (await rpc(url, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "text_to_speech", arguments: args } })).json()).result as { content: Array<{ text: string }>; isError?: boolean };
    expect((await rpc(member.tts!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(member.tts!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_tts" }, instructions: TTS_POLICY });
    const tools = (await (await rpc(member.tts!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["text_to_speech"]);

    // Chinese text gets a Chinese voice and is saved where asked, as one WAV.
    const story = "/home/gem/workspace/tasks/task-1/故事.wav";
    const made = await call(member.tts!.url, { text: "从前有座山。山里有座庙。", path: story });
    expect(made.isError).toBeUndefined();
    expect(made.content[0]!.text).toContain(`[description](${story})`);
    expect(seen[0]).toEqual({ text: "从前有座山。山里有座庙。", speaker: "vivian", language: "Chinese" });
    expect(readWav(written.get("user_m")!.get(story)!).rate).toBe(24_000);
    expect(written.get("owner_1")).toBeUndefined();

    // Long text goes over in sentence-sized pieces, one request at a time even across accounts, joined in order.
    seen.length = 0;
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1}, which is long enough to fill a chunk soon.`).join(" ");
    const [a, b] = await Promise.all([
      call(member.tts!.url, { text: long, voice: "aiden" }),
      call(owner.tts!.url, { text: "Hello there.", language: "English" }),
    ]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(overlapped).toBe(false);
    const pieces = seen.filter((s) => s.speaker === "aiden");
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((p) => p.text.length <= 120 && p.language === "English")).toBe(true);
    expect(pieces.map((p) => p.text).join(" ")).toBe(long);
    expect(seen.find((s) => s.text === "Hello there.")).toEqual({ text: "Hello there.", speaker: "ryan", language: "English" });
    const saved = a.content[0]!.text.match(/Speech saved: (\/home\/gem\/workspace\/audio\/\d{8}-\d{6}-[0-9a-f]{6}\.wav)/)![1]!;
    const joined = readWav(written.get("user_m")!.get(saved)!);
    expect(joined.samples.length).toBe(pieces.length * 4 * 2);
    expect(Array.from({ length: pieces.length }, (_, i) => joined.samples.readInt16LE(i * 8))).toEqual(pieces.map((p) => p.text.length));

    // Nothing outside the workspace, nothing but .wav, no unknown voice or language, no empty or overlong text.
    const before = seen.length;
    for (const [args, message] of [
      [{ text: "x", path: "/etc/x.wav" }, "Only files inside the sandbox workspace can be accessed"],
      [{ text: "x", path: "/home/gem/workspace/a.mp3" }, ".wav"],
      [{ text: "" }, "Missing text"],
      [{ text: "……" }, "nothing to say"],
      [{ text: "x".repeat(1501) }, "at most 1500"],
      [{ text: "x", voice: "alloy" }, "voice must be one of"],
      [{ text: "x", language: "Klingon" }, "language must be one of"],
    ] as const) {
      const failed = await call(member.tts!.url, args);
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain(message);
    }
    expect(seen.length).toBe(before);

    // A refused text or a server without audio says so, and nothing is saved.
    const count = written.get("user_m")!.size;
    answer = { status: 400, body: "unknown speaker" };
    expect((await call(member.tts!.url, { text: "你好" })).content[0]!.text).toContain("refused the text");
    answer = { status: 200, body: "<html>" };
    expect((await call(member.tts!.url, { text: "你好" })).content[0]!.text).toContain("did not return a WAV");
    expect(written.get("user_m")!.size).toBe(count);
  } finally {
    gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await h.shutdown();
  }
});

it("cuts text after sentences and picks the language from its script", () => {
  expect(chunkText("第一句。第二句！Third one? Fourth.", 10)).toEqual(["第一句。第二句！", "Third one?", "Fourth."]);
  // A sentence longer than a chunk is cut after commas, then anywhere.
  expect(chunkText("一二三四五，六七八九十，甲乙丙丁戊己庚辛壬癸。", 6)).toEqual(["一二三四五，", "六七八九十，", "甲乙丙丁戊己", "庚辛壬癸。"]);
  expect(chunkText("[pause:500ms]")).toEqual(["[pause:500ms]"]);
  expect(detectLanguage("Hello 世界")).toBe("Chinese");
  expect(detectLanguage("こんにちは")).toBe("Japanese");
  expect(detectLanguage("안녕하세요")).toBe("Korean");
  expect(detectLanguage("Bonjour")).toBe("English");
});
