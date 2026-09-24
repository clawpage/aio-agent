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
    expect(bridge.modelEntry()).toBeNull();
    expect(bridge.providerConfigArgs()).toEqual([]);
    expect(bridge.providerEnvFlags()).toEqual([]);
    expect(bridge.providerEnv()).toEqual({});
    // With no bridge, every model resolves to the ChatGPT provider.
    expect(bridge.providerForModel("gpt-6-sol")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.isTextOnly("gpt-6-sol")).toBe(false);
  });

  it("enables the provider and catalog entry when a permission-clean key file exists", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`);
    const cfg = testConfig("/tmp/pa-bridge-on", 1, { PA_OPENCODE_GO_SECRETS_FILE: file });
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    expect(bridge.enabled).toBe(true);

    const entry = bridge.modelEntry();
    expect(entry?.id).toBe("deepseek-v4.1-flash");
    expect(entry?.displayName).toContain("OpenCode Go");
    expect(entry?.supportedReasoningEfforts).toEqual(["low", "high", "max"]);
    expect(entry?.defaultReasoningEffort).toBe("high");
    expect(entry?.inputModalities).toEqual(["text"]);
    expect(entry?.modelProvider).toBe("opencode_go");
    expect(entry?.isDefault).toBe(false);

    const args = bridge.providerConfigArgs();
    expect(args.join(" ")).toContain('model_providers.opencode_go.base_url="http://host.docker.internal:4017/v1"');
    expect(args.join(" ")).toContain('model_providers.opencode_go.wire_api="responses"');
    expect(args.join(" ")).toContain('model_providers.opencode_go.env_key="LITELLM_MASTER_KEY"');
    // The key value is never in the arguments, only the variable name.
    expect(args.join(" ")).not.toContain(SECRET_VALUE);

    expect(bridge.providerForModel("deepseek-v4.1-flash")).toBe("opencode_go");
    expect(bridge.isTextOnly("deepseek-v4.1-flash")).toBe(true);
    expect(bridge.providerForModel("gpt-6-sol")).toBe(CHATGPT_PROVIDER_ID);
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
    expect(off.modelEntry()).toBeNull();
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
