import { it, expect, vi, afterEach } from "vitest";
import { startHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { ClawpageAi } from "../../src/control/clawpageAi.js";
import { Logger } from "../../src/common/logger.js";

afterEach(() => vi.unstubAllGlobals());

const sse = (events: unknown[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

it("answers on the account's own model: a GPT member's at most at its assigned effort, a Claude member's with the owner's credential", async () => {
  const h = await startHarness();
  try {
    const db = h.ctx.db;
    const gpt = await createMember(db, "gptuser", "member-password-123");
    const claude = await createMember(db, "claudeuser", "member-password-123");
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(`member_effort:${gpt.id}`, "low");
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(`member_model:${claude.id}`, "claude-sonnet-5-5");
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (url.endsWith("/responses")) {
        return new Response(sse([
          { type: "response.output_text.delta", delta: '{"score":' },
          { type: "response.output_text.delta", delta: " 3}" },
          { type: "response.completed", response: { usage: { input_tokens: 120, output_tokens: 8, input_tokens_details: { cached_tokens: 100 } } } },
        ]), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ content: [{ type: "text", text: "fine" }], usage: { input_tokens: 50, output_tokens: 5 } });
    });
    const ai = new ClawpageAi({
      cfg: { ...h.ctx.cfg, hostCodex: { ...h.ctx.cfg.hostCodex, enabled: true, chatgptUrl: "https://chatgpt.test/codex/" } },
      log: new Logger("error", undefined, false), db,
      hostTokens: { getTokens: async () => ({ accessToken: "host-access", chatgptAccountId: "acct", planType: null, expiresAt: 0 }), invalidate: () => undefined },
      claude: { status: () => ({ enabled: true, reason: null, envKey: "ANTHROPIC_API_KEY", secret: "claude-key" }), owns: (m: string) => m.startsWith("claude-") },
      usageDb: async () => db,
    });
    const request = { system: "Grade it.", messages: [{ role: "user" as const, content: "my answer" }, { role: "assistant" as const, content: "ok" }, { role: "user" as const, content: "again" }], effort: "high" as const };

    expect(await ai.answer(gpt.id, request)).toEqual({ text: '{"score": 3}', model: "gpt-6.1-sol" });
    expect(calls[0]!.url).toBe("https://chatgpt.test/codex/responses");
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer host-access", "chatgpt-account-id": "acct" });
    expect(calls[0]!.body).toMatchObject({
      model: "gpt-6.1-sol", instructions: "Grade it.", reasoning: { effort: "low" }, store: false, stream: true, tools: [],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "my answer" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      ],
    });

    expect(await ai.answer(claude.id, { ...request, effort: "medium" })).toEqual({ text: "fine", model: "claude-sonnet-5-5" });
    expect(calls[1]!.url).toBe(`${h.ctx.cfg.claudeCode.apiBaseUrl.replace(/\/$/, "")}/v1/messages`);
    expect(calls[1]!.headers).toMatchObject({ "x-api-key": "claude-key" });
    expect(calls[1]!.body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium" }, system: [{ type: "text", text: "Grade it." }] });

    // Both counted in the asking account's usage.
    const usage = db.prepare("SELECT source_key, input, output, cached FROM token_usage WHERE source_key LIKE 'clawpage-ai:%' ORDER BY id").all() as Array<{ input: number; output: number; cached: number }>;
    expect(usage.map((u) => [u.input, u.output, u.cached])).toEqual([[120, 8, 100], [50, 5, 0]]);

    // A picture goes to each API in its own shape.
    const photo = { system: "Count it.", effort: "low" as const, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "热量？" }, { type: "image" as const, mediaType: "image/jpeg", data: "QUJD" }] }] };
    await ai.answer(gpt.id, photo);
    expect(calls[2]!.body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "热量？" }, { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" }] }]);
    await ai.answer(claude.id, photo);
    expect(calls[3]!.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "热量？" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }] }]);

    // Upstream refusals become the page's errors, never a hang.
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
    await expect(ai.answer(gpt.id, request)).rejects.toMatchObject({ status: 429, code: "AI_BUSY" });
  } finally {
    await h.shutdown();
  }
});
