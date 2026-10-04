import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeModel, CHATGPT_PROVIDER_ID } from "../../src/control/bridgeModel.js";
import { expandHome, readSecretFile } from "../../src/common/secrets.js";
import { Logger } from "../../src/common/logger.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { openDb, type Db } from "../../src/control/db.js";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import type { Config } from "../../src/control/config.js";

const SECRET_VALUE = "sk-test-bridge-secret-value-0001";
const GATEWAY_URL = "http://host.docker.internal:4902/u/user_g/v1";

/** A runtime whose provider is the member gateway, as the gateway provisions a member's. */
function gatewayConfig(cfg: Config, secretsFile: string, models = ["gpt-6.1-sol"]): Config {
  return { ...cfg, bridge: { ...cfg.bridge, enabled: "on", baseUrl: GATEWAY_URL, secretsFile, models } };
}

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
  delete process.env.AIO_MEMBER_MODEL_TOKEN;
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete process.env.AIO_MEMBER_MODEL_TOKEN;
});

describe("bridge secret file parsing", () => {
  it("reads only the requested key and strips optional quotes", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, `# comment\nOTHER_KEY=nope\nAIO_MEMBER_MODEL_TOKEN="${SECRET_VALUE}"\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    expect(readSecretFile(file, "AIO_MEMBER_MODEL_TOKEN")).toEqual({ ok: true, value: SECRET_VALUE });
    // A key that is not present is a clean miss, never a partial read.
    expect(readSecretFile(file, "MISSING_KEY").ok).toBe(false);
  });

  it("refuses a secrets file that is readable by group or others", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `AIO_MEMBER_MODEL_TOKEN=${SECRET_VALUE}\n`, 0o644);
    const result = readSecretFile(file, "AIO_MEMBER_MODEL_TOKEN");
    expect(result.ok).toBe(false);
    // The refusal must explain itself without ever echoing the value.
    expect(result.ok === false && result.reason).toContain("600");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("treats a missing file as unavailable instead of throwing", () => {
    const result = readSecretFile("/nonexistent/pa-bridge/secrets.env", "AIO_MEMBER_MODEL_TOKEN");
    expect(result.ok).toBe(false);
  });

  it("expands a leading ~ to the control-plane home", () => {
    expect(expandHome("~/.config/x.env")).toBe(path.join(os.homedir(), ".config/x.env"));
    expect(expandHome("/abs/path.env")).toBe("/abs/path.env");
  });
});

describe("BridgeModel configuration", () => {
  it("stays disabled with no key and offers no provider arguments or catalog entry", () => {
    const cfg = gatewayConfig(testConfig("/tmp/pa-bridge-off", 1), "/nonexistent/secrets.env");
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    expect(bridge.enabled).toBe(false);
    expect(bridge.modelEntries()).toEqual([]);
    expect(bridge.providerConfigArgs()).toEqual([]);
    expect(bridge.providerEnvFlags()).toEqual([]);
    expect(bridge.providerEnv()).toEqual({});
    // With no bridge, every model resolves to the ChatGPT provider.
    expect(bridge.providerForModel("gpt-6-sol")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.isTextOnly("gpt-6-sol")).toBe(false);
    // The configured gateway model may not be claimed while the provider is off.
    expect(bridge.providerForModel("gpt-6.1-sol")).toBe(CHATGPT_PROVIDER_ID);
    // Nor is anything on by default: only the member gateway switches it on.
    expect(new BridgeModel(testConfig("/tmp/pa-bridge-default", 1), new Logger("error", undefined, false)).enabled).toBe(false);
  });

  it("enables the provider and catalog entry when a permission-clean key file exists", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `AIO_MEMBER_MODEL_TOKEN=${SECRET_VALUE}\n`);
    const cfg = gatewayConfig(testConfig("/tmp/pa-bridge-on", 1), file);
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    expect(bridge.enabled).toBe(true);

    expect(bridge.modelIds).toEqual(["gpt-6.1-sol"]);
    const [entry] = bridge.modelEntries();
    expect(entry?.id).toBe("gpt-6.1-sol");
    expect(entry?.displayName).toBe("GPT-6.1 Sol");
    expect(entry?.modelProvider).toBe("aio_gateway");
    expect(entry?.isDefault).toBe(false);
    expect(entry?.inputModalities).toEqual(["text", "image"]);
    // A gateway model always has a concrete default effort.
    expect(entry?.supportedReasoningEfforts).toContain(entry?.defaultReasoningEffort);

    const args = bridge.providerConfigArgs();
    expect(args.join(" ")).toContain(`model_providers.aio_gateway.base_url="${GATEWAY_URL}"`);
    expect(args.join(" ")).toContain('model_providers.aio_gateway.wire_api="responses"');
    expect(args.join(" ")).toContain('model_providers.aio_gateway.env_key="AIO_MEMBER_MODEL_TOKEN"');
    // The key value is never in the arguments, only the variable name.
    expect(args.join(" ")).not.toContain(SECRET_VALUE);

    expect(bridge.providerForModel("gpt-6.1-sol")).toBe("aio_gateway");
    expect(bridge.isTextOnly("gpt-6.1-sol")).toBe(false);
    expect(bridge.providerForModel("gpt-6-sol")).toBe(CHATGPT_PROVIDER_ID);
    expect(bridge.isTextOnly("gpt-6-sol")).toBe(false);
  });

  it("keeps an unknown bridged id conservative instead of inventing capabilities", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `AIO_MEMBER_MODEL_TOKEN=${SECRET_VALUE}\n`);
    const bridge = new BridgeModel(
      gatewayConfig(testConfig("/tmp/pa-bridge-unknown", 1), file, ["some-future-model"]),
      new Logger("error", undefined, false),
    );
    const entry = bridge.modelEntries()[0];
    expect(entry?.id).toBe("some-future-model");
    expect(entry?.displayName).toBe("some-future-model");
    expect(entry?.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(entry?.supportedReasoningEfforts).not.toContain("max");
    expect(entry?.inputModalities).toEqual(["text"]);
    expect(bridge.isTextOnly("some-future-model")).toBe(true);
  });
});

function makeBridgeManager(secretsFile: string): {
  agent: AgentManager;
  codex: FakeCodex;
  db: Db;
  bridge: BridgeModel;
} {
  const codex = new FakeCodex();
  const cfg = gatewayConfig(testConfig("/tmp/pa-manager-bridge", 1), secretsFile);
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
    const file = writeSecrets(dir, `AIO_MEMBER_MODEL_TOKEN=${SECRET_VALUE}\n`);
    ({ agent, codex, db } = makeBridgeManager(file));
    await agent.init();
  });

  afterEach(() => {
    agent.shutdown();
    db.close();
  });

  it("adds the bridge model to the catalog without changing the configured default", async () => {
    const models = await agent.listModels();
    const bridgeEntry = models.find((m) => m.id === "gpt-6.1-sol");
    expect(bridgeEntry?.modelProvider).toBe("aio_gateway");
    expect(bridgeEntry?.inputModalities).toEqual(["text", "image"]);
    // The app default is still the ChatGPT model the product ships with.
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["gpt-6-sol"]);
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
    agent.saveAgentSettings({ model: "gpt-6.1-sol", effort: "high" }, await agent.listModels());
    agent.submitTurn({ conversationId: conv.id, text: "three", clientMessageId: "s3" });
    await tick();
    expect(codex.forkedThreads.length).toBe(1);
    expect(codex.forkedThreads[0]?.modelProvider).toBe("aio_gateway");
    const forked = codex.forkedThreads[0]!.threadId;
    expect(codex.threadProviders.get(forked)).toBe("aio_gateway");
    // The forked thread is the one now used for turns.
    expect(codex.startedTurns[2]?.threadId).toBe(forked);
    codex.completeTurn(codex.startedTurns[2]!.turnId);
    await tick();

    const row = db.prepare("SELECT model_provider, codex_thread_id FROM conversations WHERE id = ?").get(conv.id) as {
      model_provider: string | null;
      codex_thread_id: string | null;
    };
    expect(row.model_provider).toBe("aio_gateway");
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
    const cfg = testConfig("/tmp/pa-manager-nobridge", 1);
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
    expect(models.some((m) => m.modelProvider)).toBe(false);

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

describe("A member assigned GPT", () => {
  it("runs on its gateway provider with images allowed, and fails closed without the control plane's ChatGPT login", async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = writeSecrets(dir, `AIO_MEMBER_MODEL_TOKEN=${"a".repeat(64)}\n`);
    const base = gatewayConfig(testConfig("/tmp/pa-member-gpt", 1), file);
    const cfg = { ...base, memberRuntime: true, memberModel: "gpt-6.1-sol", agent: { ...base.agent, defaultModel: "gpt-6.1-sol" } };
    const log = new Logger("error", undefined, false);
    const bridge = new BridgeModel(cfg, log);
    expect(bridge.providerForModel("gpt-6.1-sol")).toBe("aio_gateway");
    expect(bridge.isTextOnly("gpt-6.1-sol")).toBe(false);
    expect(bridge.modelEntries()[0]?.inputModalities).toEqual(["text", "image"]);

    const db = openDb(":memory:");
    db.prepare("INSERT INTO owners(id,username,role,password_hash,password_salt,password_params,created_at) VALUES ('user_g','xjy','member','x','x','{}',0)").run();
    const codex = new FakeCodex();
    const hostTokens = { status: async () => ({ ok: true }) } as unknown as HostTokenSource;
    const member = new AgentManager({ cfg, db, log, codex, hostTokens, bridge });
    await member.init();
    const off = new AgentManager({ cfg: { ...cfg, hostCodex: { ...cfg.hostCodex, enabled: false } }, db, log, codex: new FakeCodex(), hostTokens, bridge });
    try {
      expect(member.memberSettings()).toEqual({ model: "gpt-6.1-sol", effort: "high" });
      const conv = member.createConversation({ ownerId: "user_g", title: "member" });
      member.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "g1", model: "gpt-6-astra", effort: "max" });
      await tick();
      expect(codex.threadProviders.get(codex.startedThreads[0]!.threadId)).toBe("aio_gateway");
      expect(codex.startedTurns[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
      expect(() => off.memberSettings()).toThrow("服务暂时不可用");
    } finally {
      member.shutdown();
      off.shutdown();
      db.close();
    }
  });
});
