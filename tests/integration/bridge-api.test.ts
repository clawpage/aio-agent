import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";

const SECRET_VALUE = "sk-test-integration-secret-0003";
let h: TestHarness;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bridge-http-"));
  const secretsFile = path.join(dataDir, "secrets.env");
  fs.writeFileSync(secretsFile, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`, { mode: 0o600 });
  fs.chmodSync(secretsFile, 0o600);
  h = await startHarness({ PA_OPENCODE_GO_SECRETS_FILE: secretsFile });
});

afterAll(async () => {
  await h.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("bridge model over HTTP", () => {
  it("offers the bridge model in the catalog with its provider and modalities", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/models", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { models } = (await res.json()) as {
      models: Array<{ id: string; isDefault: boolean; inputModalities: string[]; modelProvider: string | null }>;
    };
    const bridge = models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(bridge).toBeDefined();
    expect(bridge?.modelProvider).toBe("opencode_go");
    expect(bridge?.inputModalities).toEqual(["text"]);
    // The product default is still the ChatGPT model, never the bridge one.
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["gpt-6-sol"]);
  });

  it("reports the bridge model in the settings catalog and accepts its own effort", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };

    const read = await h.request("/api/settings", { headers: { cookie } });
    const body = (await read.json()) as {
      models: Array<{ id: string; supportedReasoningEfforts: string[]; modelProvider: string | null }>;
    };
    const bridge = body.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(bridge?.supportedReasoningEfforts).toEqual(["low", "high", "max"]);
    expect(bridge?.modelProvider).toBe("opencode_go");

    const saved = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", effort: "max" }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { settings: unknown }).settings).toEqual({
      model: "deepseek-v4.1-flash",
      effort: "max",
    });

    // An effort outside the bridge model's own set is still refused.
    const badEffort = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", effort: "medium" }),
    });
    expect(badEffort.status).toBe(400);
  });

  it("rejects an image attachment for the text-only bridge model with a client error", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", effort: null }),
    });

    const created = await h.request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "bridge-image" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const res = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "看这张图",
        clientMessageId: "bridge-img-1",
        attachments: [{ path: "/home/gem/workspace/a.png", kind: "image" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("input_unsupported");
    expect(body.message).toContain("只支持文本");
    // The turn never reached Codex.
    expect(h.codex.startedTurns.length).toBe(0);

    // Restore the ChatGPT default so later cases in this file start clean.
    await h.request("/api/settings", { method: "PUT", headers, body: JSON.stringify({ model: null, effort: null }) });
  });

  it("runs a bridge turn on a thread created for that provider", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", effort: "high" }),
    });
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "bridge-turn" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const turnRes = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hi deepseek", clientMessageId: "bridge-t1" }),
    });
    expect(turnRes.status).toBe(202);
    const { turn } = (await turnRes.json()) as { turn: { model: string | null; effort: string | null } };
    expect(turn.model).toBe("deepseek-v4.1-flash");
    expect(turn.effort).toBe("high");

    await new Promise((r) => setTimeout(r, 80));
    const started = h.codex.startedTurns.at(-1)!;
    expect(started.model).toBe("deepseek-v4.1-flash");
    expect(h.codex.threadProviders.get(started.threadId)).toBe("opencode_go");
    h.codex.completeTurn(started.turnId);
    await new Promise((r) => setTimeout(r, 40));

    // Switching back to a ChatGPT model forks the conversation off the bridge thread.
    await h.request("/api/settings", { method: "PUT", headers, body: JSON.stringify({ model: null, effort: null }) });
    const second = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "back to chatgpt", clientMessageId: "bridge-t2" }),
    });
    expect(second.status).toBe(202);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.codex.forkedThreads.length).toBe(1);
    const back = h.codex.forkedThreads[0]!;
    expect(back.modelProvider).toBeUndefined();
    expect(h.codex.startedTurns.at(-1)?.threadId).toBe(back.threadId);
    h.codex.completeTurn(h.codex.startedTurns.at(-1)!.turnId);
    await new Promise((r) => setTimeout(r, 40));
  });
});

describe("bridge model is absent without a key", () => {
  it("does not advertise the bridge model when no key can be read", async () => {
    const bare = await startHarness({ PA_OPENCODE_GO_SECRETS_FILE: "/nonexistent/pa/secrets.env" });
    try {
      const { cookie } = await login(bare);
      const res = await bare.request("/api/models", { headers: { cookie } });
      const { models } = (await res.json()) as { models: Array<{ id: string }> };
      expect(models.some((m) => m.id === "deepseek-v4.1-flash")).toBe(false);
    } finally {
      await bare.shutdown();
    }
  });
});
