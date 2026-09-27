import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeModel, CHATGPT_PROVIDER_ID, expandHome, readSecretFile } from "../../src/server/bridgeModel.js";
import { Logger } from "../../src/server/logger.js";
import { AgentManager, TurnInputUnsupportedError } from "../../src/server/codex/manager.js";
import { openDb, type Db } from "../../src/server/db.js";
import { SandboxContainer } from "../../src/server/docker/sandbox.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";

const SECRET_VALUE = "sk-test-bridge-secret-value-0001";

/** One private 0600 secrets file per test, laid out like the real bridge's. */
function writeSecrets(dir: string, body: string, mode = 0o600): string {
  const file = path.join(dir, "secrets.env");
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pa-bridge-test-"));
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  delete process.env.LITELLM_MASTER_KEY;
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete process.env.LITELLM_MASTER_KEY;
});

describe("bridge secret file parsing", () => {
  it("reads only the requested key and strips optional quotes", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, `# comment\nOTHER_KEY=nope\nLITELLM_MASTER_KEY="${SECRET_VALUE}"\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    expect(readSecretFile(file, "LITELLM_MASTER_KEY")).toEqual({ ok: true, value: SECRET_VALUE });
    // A key that is not present is a clean miss, never a partial read.
    expect(readSecretFile(file, "MISSING_KEY").ok).toBe(false);
  });

  it("refuses a secrets file that is readable by group or others", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`, 0o644);
    const result = readSecretFile(file, "LITELLM_MASTER_KEY");
    expect(result.ok).toBe(false);
    // The refusal must explain itself without ever echoing the value.
    expect(result.ok === false && result.reason).toContain("600");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("treats a missing file as unavailable instead of throwing", () => {
    const result = readSecretFile("/nonexistent/pa-bridge/secrets.env", "LITELLM_MASTER_KEY");
    expect(result.ok).toBe(false);
  });

  it("expands a leading ~ to the control-plane home", () => {
    expect(expandHome("~/.config/x.env")).toBe(path.join(os.homedir(), ".config/x.env"));
    expect(expandHome("/abs/path.env")).toBe("/abs/path.env");
  });
});

describe("BridgeModel configuration", () => {
  it("stays disabled with no key and offers no provider arguments or catalog entry", () => {
    const cfg = testConfig("/tmp/pa-bridge-off", 1, { PA_OPENCODE_GO_SECRETS_FILE: "/nonexistent/secrets.env" });
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    expect(bridge.enabled).toBe(false);
    expect(bridge.modelEntries()).toEqual([]);
    expect(bridge.providerConfigArgs()).toEqual([]);
    expect(bridge.providerEnvFlags()).toEqual([]);
    expect(bridge.providerEnv()).toEqual({});
    // With no bridge, every model resolves to the ChatGPT provider.
    expect(bridge.providerForModel("gpt-6-sol")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.isTextOnly("gpt-6-sol")).toBe(false);
    // Neither bridged id may be claimed while the bridge is off.
    expect(bridge.providerForModel("deepseek-v4.1-flash")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.providerForModel("mimo-v2.6-pro")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.isTextOnly("mimo-v2.6-pro")).toBe(false);
  });

  it("enables the provider and catalog entry when a permission-clean key file exists", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`);
    const cfg = testConfig("/tmp/pa-bridge-on", 1, { PA_OPENCODE_GO_SECRETS_FILE: file });
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    expect(bridge.enabled).toBe(true);

    // Both bridged models are offered, in configured order.
    expect(bridge.modelIds).toEqual(["deepseek-v4.1-flash", "mimo-v2.6-pro"]);
    const entries = bridge.modelEntries();
    expect(entries.map((e) => e.id)).toEqual(["deepseek-v4.1-flash", "mimo-v2.6-pro"]);
    for (const entry of entries) {
      expect(entry.displayName).toContain("OpenCode Go");
      expect(entry.modelProvider).toBe("opencode_go");
      expect(entry.isDefault).toBe(false);
      // Both are text-only; neither may advertise image input.
      expect(entry.inputModalities).toEqual(["text"]);
      // A bridged model always has a concrete default effort.
      expect(entry.supportedReasoningEfforts).toContain(entry.defaultReasoningEffort);
    }

    const [deepseek, mimo] = entries;
    expect(deepseek?.supportedReasoningEfforts).toEqual(["low", "high", "max"]);
    expect(deepseek?.defaultReasoningEffort).toBe("high");
    // mimo must not advertise `max`: the upstream rejects it with HTTP 400.
    expect(mimo?.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(mimo?.supportedReasoningEfforts).not.toContain("max");
    expect(mimo?.defaultReasoningEffort).toBe("high");
    expect(mimo?.displayName).toContain("MiMo");

    const args = bridge.providerConfigArgs();
    expect(args.join(" ")).toContain('model_providers.opencode_go.base_url="http://host.docker.internal:4017/v1"');
    expect(args.join(" ")).toContain('model_providers.opencode_go.wire_api="responses"');
    expect(args.join(" ")).toContain('model_providers.opencode_go.env_key="LITELLM_MASTER_KEY"');
    // The key value is never in the arguments, only the variable name.
    expect(args.join(" ")).not.toContain(SECRET_VALUE);

    expect(bridge.providerForModel("deepseek-v4.1-flash")).toBe("opencode_go");
    expect(bridge.providerForModel("mimo-v2.6-pro")).toBe("opencode_go");
    expect(bridge.isTextOnly("deepseek-v4.1-flash")).toBe(true);
    expect(bridge.isTextOnly("mimo-v2.6-pro")).toBe(true);
    expect(bridge.providerForModel("gpt-6-sol")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.isTextOnly("gpt-6-sol")).toBe(false);
  });

  it("honours PA_OPENCODE_GO_MODELS and keeps the legacy single-model variable working", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`);

    const custom = new BridgeModel(
      testConfig("/tmp/pa-bridge-models", 1, {
        PA_OPENCODE_GO_SECRETS_FILE: file,
        PA_OPENCODE_GO_MODELS: "mimo-v2.6-pro",
      }),
      new Logger("error", undefined, false),
    );
    expect(custom.modelIds).toEqual(["mimo-v2.6-pro"]);
    expect(custom.providerForModel("mimo-v2.6-pro")).toBe("opencode_go");
    // deepseek is not configured here, so it must not be claimed by the bridge.
    expect(custom.providerForModel("deepseek-v4.1-flash")).toBe(CHATGPT_PROVIDER_ID);

    // An existing deployment that pinned one model keeps exactly that one.
    const legacy = new BridgeModel(
      testConfig("/tmp/pa-bridge-legacy", 1, {
        PA_OPENCODE_GO_SECRETS_FILE: file,
        PA_OPENCODE_GO_MODEL: "deepseek-v4.1-flash",
        PA_OPENCODE_GO_MODELS: "mimo-v2.6-pro,deepseek-v4.1-flash",
      }),
      new Logger("error", undefined, false),
    );
    expect(legacy.modelIds).toEqual(["deepseek-v4.1-flash"]);
    expect(legacy.modelEntries().map((e) => e.id)).toEqual(["deepseek-v4.1-flash"]);
  });

  it("keeps an unknown bridged id conservative instead of inventing capabilities", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`);
    const bridge = new BridgeModel(
      testConfig("/tmp/pa-bridge-unknown", 1, {
        PA_OPENCODE_GO_SECRETS_FILE: file,
        PA_OPENCODE_GO_MODELS: "some-future-model",
      }),
      new Logger("error", undefined, false),
    );
    const entry = bridge.modelEntries()[0];
    expect(entry?.id).toBe("some-future-model");
    expect(entry?.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(entry?.supportedReasoningEfforts).not.toContain("max");
    expect(entry?.inputModalities).toEqual(["text"]);
  });

  it("prefers the process environment over the file and honours an explicit off switch", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=from-file\n`);
    process.env.LITELLM_MASTER_KEY = SECRET_VALUE;
    const fromEnv = new BridgeModel(
      testConfig("/tmp/pa-bridge-env", 1, { PA_OPENCODE_GO_SECRETS_FILE: file }),
      new Logger("error", undefined, false),
    );
    expect(fromEnv.providerEnv()).toEqual({ LITELLM_MASTER_KEY: SECRET_VALUE });

    const off = new BridgeModel(
      testConfig("/tmp/pa-bridge-off2", 1, { PA_OPENCODE_GO_SECRETS_FILE: file, PA_OPENCODE_GO_ENABLED: "0" }),
      new Logger("error", undefined, false),
    );
    // Even with a readable key, an explicit opt-out keeps the model out.
    expect(off.enabled).toBe(false);
    expect(off.modelEntries()).toEqual([]);
  });
});

function makeBridgeManager(extraEnv: Record<string, string>): {
  agent: AgentManager;
  codex: FakeCodex;
  db: Db;
  bridge: BridgeModel;
} {
  const codex = new FakeCodex();
  const cfg = testConfig("/tmp/pa-manager-bridge", 1, extraEnv);
  const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
  const hostTokens = {
    status: async () => ({ ok: true, authMethod: "chatgpt", email: null, planType: null, expiresAt: null, error: null }),
  } as unknown as HostTokenSource;
  const db = openDb(":memory:");
  const agent = new AgentManager({ cfg, db, log: new Logger("error", undefined, false), codex, hostTokens, bridge });
  return { agent, codex, db, bridge };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("AgentManager with the bridge enabled", () => {
  let agent: AgentManager;
  let codex: FakeCodex;
  let db: Db;
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`);
    ({ agent, codex, db } = makeBridgeManager({ PA_OPENCODE_GO_SECRETS_FILE: file }));
    await agent.init();
  });

  afterEach(() => {
    agent.shutdown();
    db.close();
  });

  it("adds the bridge model to the catalog without changing the configured default", async () => {
    const models = await agent.listModels();
    const bridgeEntry = models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(bridgeEntry?.modelProvider).toBe("opencode_go");
    expect(bridgeEntry?.inputModalities).toEqual(["text"]);
    // The app default is still the ChatGPT model the product ships with.
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["gpt-6-sol"]);
  });

  it("saves and runs the bridge model with one of its own thinking levels", async () => {
    const saved = agent.saveAgentSettings({ model: "deepseek-v4.1-flash", effort: "max" }, await agent.listModels());
    expect(saved.ok).toBe(true);
    // An effort the bridge model does not offer is still refused.
    const bad = agent.saveAgentSettings({ model: "deepseek-v4.1-flash", effort: "medium" }, await agent.listModels());
    expect(bad.ok).toBe(false);

    const conv = agent.createConversation({ title: "bridge" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "b1" });
    await tick();
    // A brand-new conversation starts straight on the bridge provider.
    expect(codex.startedThreads.length).toBe(1);
    const threadId = codex.startedThreads[0]!.threadId;
    expect(codex.threadProviders.get(threadId)).toBe("opencode_go");
    expect(codex.startedTurns[0]?.model).toBe("deepseek-v4.1-flash");
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
  });

  it("forks the thread when the provider changes and resumes when it does not", async () => {
    const conv = agent.createConversation({ title: "switch" });
    // First turn runs on the ChatGPT provider (default model).
    agent.submitTurn({ conversationId: conv.id, text: "one", clientMessageId: "s1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    expect(codex.forkedThreads.length).toBe(0);

    // Same provider again: resume, never fork.
    agent.submitTurn({ conversationId: conv.id, text: "two", clientMessageId: "s2" });
    await tick();
    codex.completeTurn(codex.startedTurns[1]!.turnId);
    await tick();
    expect(codex.forkedThreads.length).toBe(0);

    // Switch to the bridge model: the provider must change, which requires a fork.
    agent.saveAgentSettings({ model: "deepseek-v4.1-flash", effort: "high" }, await agent.listModels());
    agent.submitTurn({ conversationId: conv.id, text: "three", clientMessageId: "s3" });
    await tick();
    expect(codex.forkedThreads.length).toBe(1);
    expect(codex.forkedThreads[0]?.modelProvider).toBe("opencode_go");
    const forked = codex.forkedThreads[0]!.threadId;
    expect(codex.threadProviders.get(forked)).toBe("opencode_go");
    // The forked thread is the one now used for turns.
    expect(codex.startedTurns[2]?.threadId).toBe(forked);
    codex.completeTurn(codex.startedTurns[2]!.turnId);
    await tick();

    const row = db.prepare("SELECT model_provider, codex_thread_id FROM conversations WHERE id = ?").get(conv.id) as {
      model_provider: string | null;
      codex_thread_id: string | null;
    };
    expect(row.model_provider).toBe("opencode_go");
    expect(row.codex_thread_id).toBe(forked);

    // Switching back to ChatGPT forks again rather than failing on the bridge thread.
    agent.saveAgentSettings({ model: null, effort: null }, await agent.listModels());
    agent.submitTurn({ conversationId: conv.id, text: "four", clientMessageId: "s4" });
    await tick();
    expect(codex.forkedThreads.length).toBe(2);
    expect(codex.forkedThreads[1]?.modelProvider).toBeUndefined();
    const back = db.prepare("SELECT model_provider FROM conversations WHERE id = ?").get(conv.id) as {
      model_provider: string | null;
    };
    expect(back.model_provider).toBe("openai");
    codex.completeTurn(codex.startedTurns[3]!.turnId);
    await tick();
  });

  it("refuses an image attachment on the text-only bridge model before the turn starts", async () => {
    agent.saveAgentSettings({ model: "deepseek-v4.1-flash", effort: null }, await agent.listModels());
    const conv = agent.createConversation({ title: "text-only" });
    expect(() =>
      agent.submitTurn({
        conversationId: conv.id,
        text: "look",
        clientMessageId: "i1",
        attachments: [{ path: "/home/gem/workspace/a.png", kind: "image" }],
      }),
    ).toThrow(TurnInputUnsupportedError);
    // Nothing was queued and Codex was never asked to run it.
    expect(codex.startedTurns.length).toBe(0);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("still accepts an image on a ChatGPT model", async () => {
    const conv = agent.createConversation({ title: "images-ok" });
    agent.submitTurn({
      conversationId: conv.id,
      text: "look",
      clientMessageId: "i2",
      attachments: [{ path: "/home/gem/workspace/a.png", kind: "image" }],
    });
    await tick();
    expect(codex.startedTurns.length).toBe(1);
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
  });

  it("lists both bridged models with their own thinking levels", async () => {
    const models = await agent.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4.1-flash");
    expect(ids).toContain("mimo-v2.6-pro");

    const deepseek = models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(deepseek?.supportedReasoningEfforts).toEqual(["low", "high", "max"]);
    expect(deepseek?.modelProvider).toBe("opencode_go");

    const mimo = models.find((m) => m.id === "mimo-v2.6-pro");
    expect(mimo?.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(mimo?.defaultReasoningEffort).toBe("high");
    expect(mimo?.inputModalities).toEqual(["text"]);
    expect(mimo?.modelProvider).toBe("opencode_go");

    // The app default is still the ChatGPT model the product ships with.
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["gpt-6-sol"]);
  });

  it("saves and runs mimo on the bridge provider, but refuses its unsupported max", async () => {
    // `max` is rejected upstream for mimo, so it must not be savable here.
    const bad = agent.saveAgentSettings({ model: "mimo-v2.6-pro", effort: "max" }, await agent.listModels());
    expect(bad.ok).toBe(false);

    const saved = agent.saveAgentSettings({ model: "mimo-v2.6-pro", effort: "high" }, await agent.listModels());
    expect(saved.ok).toBe(true);

    const conv = agent.createConversation({ title: "mimo" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick();
    expect(codex.startedThreads.length).toBe(1);
    const threadId = codex.startedThreads[0]!.threadId;
    expect(codex.threadProviders.get(threadId)).toBe("opencode_go");
    expect(codex.startedTurns[0]?.model).toBe("mimo-v2.6-pro");
    // The frozen effort is the one that was saved, not silently upgraded.
    expect(codex.startedTurns[0]?.effort).toBe("high");
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
  });

  it("refuses an image attachment on mimo as well", async () => {
    agent.saveAgentSettings({ model: "mimo-v2.6-pro", effort: null }, await agent.listModels());
    const conv = agent.createConversation({ title: "mimo-text-only" });
    expect(() =>
      agent.submitTurn({
        conversationId: conv.id,
        text: "look",
        clientMessageId: "m3",
        attachments: [{ path: "/home/gem/workspace/a.png", kind: "image" }],
      }),
    ).toThrow(TurnInputUnsupportedError);
    expect(codex.startedTurns.length).toBe(0);
  });

  it("keeps both bridged models on one provider thread when switching between them", async () => {
    // Both slugs share the same provider, so switching between them must not
    // force a thread fork the way crossing to ChatGPT does.
    agent.saveAgentSettings({ model: "deepseek-v4.1-flash", effort: "high" }, await agent.listModels());
    const conv = agent.createConversation({ title: "bridged-pair" });
    agent.submitTurn({ conversationId: conv.id, text: "one", clientMessageId: "p1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    expect(codex.forkedThreads.length).toBe(0);

    agent.saveAgentSettings({ model: "mimo-v2.6-pro", effort: "low" }, await agent.listModels());
    agent.submitTurn({ conversationId: conv.id, text: "two", clientMessageId: "p2" });
    await tick();
    expect(codex.forkedThreads.length).toBe(0);
    expect(codex.startedTurns[1]?.model).toBe("mimo-v2.6-pro");
    expect(codex.threadProviders.get(codex.startedTurns[1]!.threadId)).toBe("opencode_go");
    codex.completeTurn(codex.startedTurns[1]!.turnId);
    await tick();
  });
});

describe("AgentManager without the bridge", () => {
  it("never offers the bridge model and never sends a provider", async () => {
    const codex = new FakeCodex();
    const cfg = testConfig("/tmp/pa-manager-nobridge", 1, { PA_OPENCODE_GO_SECRETS_FILE: "/nonexistent/secrets.env" });
    const db = openDb(":memory:");
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    const agent = new AgentManager({
      cfg,
      db,
      log: new Logger("error", undefined, false),
      codex,
      hostTokens: { status: async () => ({}) } as unknown as HostTokenSource,
      bridge,
    });
    await agent.init();
    const models = await agent.listModels();
    expect(models.some((m) => m.id === "deepseek-v4.1-flash")).toBe(false);

    const conv = agent.createConversation({ title: "plain" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "n1" });
    await tick();
    // The ChatGPT path must not carry a modelProvider at all.
    expect(codex.startedThreads.length).toBe(1);
    expect(codex.threadProviders.get(codex.startedThreads[0]!.threadId)).toBeNull();
    expect(codex.forkedThreads.length).toBe(0);
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    agent.shutdown();
    db.close();
  });
});
