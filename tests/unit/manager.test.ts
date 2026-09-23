import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, getMeta, type Db } from "../../src/server/db.js";
import { Logger } from "../../src/server/logger.js";
import { AgentManager, TurnConflictError, buildApprovalResponse, parseAttachments } from "../../src/server/codex/manager.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";

function seedConversation(db: Db, id: string, model: string | null): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO conversations (id, owner_id, title, model, cwd, status, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?)",
  ).run(id, "owner_1", "seeded", model, "/home/gem/workspace", now, now);
}

function makeManager(extraEnv: Record<string, string> = {}, db: Db = openDb(":memory:")): { agent: AgentManager; codex: FakeCodex; db: Db } {
  const codex = new FakeCodex();
  const cfg = testConfig("/tmp/pa-manager-test", 1, extraEnv);
  const hostTokens = { status: async () => ({ ok: true, authMethod: "chatgpt", email: null, planType: null, expiresAt: null, error: null }) } as unknown as HostTokenSource;
  const agent = new AgentManager({ cfg, db, log: new Logger("error", undefined, false), codex, hostTokens });
  return { agent, codex, db };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe("AgentManager", () => {
  let agent: AgentManager;
  let codex: FakeCodex;
  let db: Db;

  beforeEach(async () => {
    ({ agent, codex, db } = makeManager());
    await agent.init();
  });

  afterEach(() => {
    agent.shutdown();
    db.close();
  });

  it("treats a repeated clientMessageId with identical payload as a duplicate", async () => {
    const conv = agent.createConversation({ title: "t" });
    const first = agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    const second = agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    expect(second.duplicate).toBe(true);
    expect(second.turn.id).toBe(first.turn.id);
    await tick();
    expect(codex.startedTurns.length).toBe(1);
  });

  it("rejects a reused clientMessageId with different content or conversation", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    agent.submitTurn({ conversationId: a.id, text: "hi", clientMessageId: "m1" });
    expect(() => agent.submitTurn({ conversationId: a.id, text: "different", clientMessageId: "m1" })).toThrow(TurnConflictError);
    expect(() => agent.submitTurn({ conversationId: b.id, text: "hi", clientMessageId: "m1" })).toThrow(TurnConflictError);
  });

  it("serialises execution so only one turn runs at a time across conversations", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: a.id, text: "first", clientMessageId: "m1" });
    await tick();
    agent.submitTurn({ conversationId: b.id, text: "second", clientMessageId: "m2" });
    await tick(50);
    // Second turn must still be queued while the first holds the sandbox.
    expect(codex.startedTurns.length).toBe(1);
    const queued = db.prepare("SELECT status FROM turns WHERE client_message_id = 'm2'").get() as { status: string };
    expect(queued.status).toBe("queued");

    codex.releaseTurn("thread_1");
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(codex.startedTurns.length).toBe(2);
  });

  it("cancels a queued turn instead of merely announcing it", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: a.id, text: "first", clientMessageId: "m1" });
    await tick();
    const second = agent.submitTurn({ conversationId: b.id, text: "second", clientMessageId: "m2" });
    await tick(20);

    const result = await agent.interrupt(b.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("queued");
    const row = db.prepare("SELECT status FROM turns WHERE id = ?").get(second.turn.id) as { status: string };
    expect(row.status).toBe("interrupted");

    codex.releaseTurn("thread_1");
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    // The cancelled turn must never reach Codex.
    expect(codex.startedTurns.length).toBe(1);
  });

  it("interrupts a running turn through Codex", async () => {
    const a = agent.createConversation({ title: "a" });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: a.id, text: "run", clientMessageId: "m1" });
    await tick(40);
    const result = await agent.interrupt(a.id);
    expect(result.status).toBe("running");
    expect(codex.interrupted.length).toBe(1);
  });

  it("reports no-op interrupts honestly", async () => {
    const a = agent.createConversation({ title: "a" });
    const result = await agent.interrupt(a.id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("none");
  });

  it("replays persisted events and streams deltas after reconnect", async () => {
    const a = agent.createConversation({ title: "a" });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: a.id, text: "hello", clientMessageId: "m1" });
    await tick(40);
    const turnId = codex.startedTurns[0]!.turnId;
    codex.emitServerRequest("sr1", "item/commandExecution/requestApproval", { threadId: "thread_1", turnId, command: "ls" });
    await tick(20);

    const events = agent.listEvents(a.id, 0);
    const types = events.map((e) => e.type);
    expect(types).toContain("conversation.created");
    expect(types).toContain("turn.queued");
    expect(types).toContain("approval.requested");

    // Replay from a checkpoint must not duplicate earlier events.
    const checkpoint = events[Math.floor(events.length / 2)]!.id;
    const replayed = agent.listEvents(a.id, checkpoint);
    expect(replayed.every((e) => e.id > checkpoint)).toBe(true);

    const pending = agent.listPendingRequests(a.id);
    expect(pending.length).toBe(1);
    const ok = agent.respondToRequest(pending[0]!.id, "accept");
    expect(ok.ok).toBe(true);
    expect(codex.answers[0]!.result).toEqual({ decision: "accept" });
    expect(agent.respondToRequest(pending[0]!.id, "accept").ok).toBe(false);
  });

  it("flushes buffered deltas before item/completed so text is never duplicated", async () => {
    const a = agent.createConversation({ title: "stream" });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: a.id, text: "hi", clientMessageId: "m1" });
    await tick(40);
    const turnId = codex.startedTurns[0]!.turnId;
    codex.emitNotification("item/started", { threadId: "thread_1", turnId, item: { id: "i1", type: "agentMessage" } });
    // Two deltas arrive well inside the 250 ms flush window, then the completed item.
    codex.emitNotification("item/agentMessage/delta", { threadId: "thread_1", turnId, itemId: "i1", delta: "PROBE" });
    codex.emitNotification("item/agentMessage/delta", { threadId: "thread_1", turnId, itemId: "i1", delta: "_OK" });
    codex.emitNotification("item/completed", {
      threadId: "thread_1",
      turnId,
      item: { id: "i1", type: "agentMessage", text: "PROBE_OK" },
    });
    await tick(10);

    const events = agent.listEvents(a.id, 0);
    const types = events.map((e) => e.type);
    const completedIdx = types.indexOf("item/completed");
    const deltaEvents = events.filter((e) => e.type === "stream.delta");
    expect(deltaEvents.length).toBeGreaterThan(0);
    // Every delta must be sequenced before the completed item.
    const lastDeltaIdx = types.lastIndexOf("stream.delta");
    expect(lastDeltaIdx).toBeLessThan(completedIdx);
    const joined = deltaEvents.map((e) => (e.payload as { delta: string }).delta).join("");
    expect(joined).toBe("PROBE_OK");
    // And the deltas are not re-sent after the completed item.
    expect(types.slice(completedIdx).filter((t) => t === "stream.delta")).toEqual([]);
    codex.releaseTurn("thread_1");
    codex.completeTurn(turnId);
    await tick(40);
  });

  it("marks an in-flight turn unknown when the sandbox Codex connection dies", async () => {
    const a = agent.createConversation({ title: "a" });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: a.id, text: "run", clientMessageId: "m1" });
    await tick(40);
    codex.emitClosed("exit code=137 signal=null");
    await tick(60);
    const row = db.prepare("SELECT status, error FROM turns WHERE client_message_id = 'm1'").get() as { status: string; error: string };
    expect(row.status).toBe("unknown");
    expect(row.error).toContain("结果未知");
    // No automatic replay of the unknown turn.
    expect(codex.startedTurns.length).toBe(1);
  });

  it("reconciles restarted work without claiming queued turns produced side effects", async () => {
    // Build the post-crash database state directly: one turn was running, one queued.
    const conv = agent.createConversation({ title: "a" });
    const now = Date.now();
    db.prepare(
      "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at) VALUES (?,?,?,?,?,?)",
    ).run("turn_running", conv.id, "m1", "running", "x", now);
    db.prepare(
      "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at) VALUES (?,?,?,?,?,?)",
    ).run("turn_queued", conv.id, "m2", "queued", "y", now + 1);
    db.prepare("UPDATE conversations SET status = 'running' WHERE id = ?").run(conv.id);

    const freshCodex = new FakeCodex();
    const fresh = new AgentManager({
      cfg: testConfig("/tmp/pa-manager-test", 1),
      db,
      log: new Logger("error", undefined, false),
      codex: freshCodex,
      hostTokens: { status: async () => ({}) } as unknown as HostTokenSource,
    });
    await fresh.init();

    const runningRow = db.prepare("SELECT status, error FROM turns WHERE id = 'turn_running'").get() as {
      status: string;
      error: string;
    };
    const queuedRow = db.prepare("SELECT status, error FROM turns WHERE id = 'turn_queued'").get() as {
      status: string;
      error: string;
    };
    expect(runningRow.status).toBe("unknown");
    expect(runningRow.error).toContain("结果未知");
    expect(queuedRow.status).toBe("interrupted");
    expect(queuedRow.error).toContain("排队");

    const reconciled = agent.listEvents(conv.id, 0).filter((e) => e.type === "turn.reconciled");
    expect(reconciled.length).toBe(2);
    const reasons = reconciled.map((e) => (e.payload as { reason: string }).reason).sort();
    expect(reasons).toEqual(["server_restart_before_start", "server_restart_while_running"]);
    // Nothing was replayed into Codex.
    expect(freshCodex.startedTurns.length).toBe(0);
    fresh.shutdown();
  });

  it("reports the configured default model as the default, not the CLI's own default", async () => {
    const models = await agent.listModels();
    expect(models.find((m) => m.id === "gpt-6-sol")?.isDefault).toBe(true);
    expect(models.find((m) => m.id === "gpt-5.5")?.isDefault).toBe(false);
  });

  it("migrates the legacy default model once, then preserves a later manual choice", async () => {
    const db2 = openDb(":memory:");
    seedConversation(db2, "conv_legacy", "gpt-5.5");
    const first = makeManager({}, db2);
    await first.agent.init();

    const migrated = db2.prepare("SELECT model FROM conversations WHERE id = 'conv_legacy'").get() as { model: string };
    expect(migrated.model).toBe("gpt-6-sol");

    // The migrated conversation really runs the default model on its next turn.
    first.agent.submitTurn({ conversationId: "conv_legacy", text: "hi", clientMessageId: "m1" });
    await tick();
    expect(first.codex.startedTurns[0]?.model).toBe("gpt-6-sol");
    first.codex.completeTurn(first.codex.startedTurns[0].turnId);
    await tick();

    // Picking the old model on purpose afterwards is a real choice...
    first.agent.submitTurn({ conversationId: "conv_legacy", text: "again", clientMessageId: "m2", model: "gpt-5.5" });
    await tick();
    expect(first.codex.startedTurns[1]?.model).toBe("gpt-5.5");
    first.agent.shutdown();

    // ...and the one-time migration never rewrites it on a later restart.
    const second = makeManager({}, db2);
    await second.agent.init();
    const kept = db2.prepare("SELECT model FROM conversations WHERE id = 'conv_legacy'").get() as { model: string };
    expect(kept.model).toBe("gpt-5.5");
    second.agent.shutdown();
    db2.close();
  });

  it("keeps an explicit model choice for the conversation", async () => {
    const conv = agent.createConversation({ title: "explicit" });
    db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run("gpt-5.5", conv.id);

    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1", model: "gpt-6-astra" });
    await tick();

    expect(codex.startedTurns[0]?.model).toBe("gpt-6-astra");
    const row = db.prepare("SELECT model FROM conversations WHERE id = ?").get(conv.id) as { model: string };
    expect(row.model).toBe("gpt-6-astra");
  });

  it("honours PA_DEFAULT_MODEL", async () => {
    const other = makeManager({ PA_DEFAULT_MODEL: "gpt-6-luna" });
    await other.agent.init();
    const conv = other.agent.createConversation({ title: "configured" });
    other.agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick();
    expect(other.codex.startedTurns[0]?.model).toBe("gpt-6-luna");
    other.agent.shutdown();
    other.db.close();
  });

  it("names a conversation from its first message exactly once", async () => {
    const conv = agent.createConversation();
    expect(conv.title).toBe("新会话");
    agent.submitTurn({ conversationId: conv.id, text: "帮我看看这个脚本", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(40);
    await agent.waitForAutoTitles();

    expect(codex.titleCalls).toEqual(["帮我看看这个脚本"]);
    let row = db.prepare("SELECT title FROM conversations WHERE id = ?").get(conv.id) as { title: string };
    expect(row.title).toBe("自动标题");
    expect(agent.listEvents(conv.id, 0).some((e) => e.type === "conversation.title_updated")).toBe(true);

    // A second turn must never rename it again.
    agent.submitTurn({ conversationId: conv.id, text: "第二轮", clientMessageId: "m2" });
    await tick();
    codex.completeTurn(codex.startedTurns[1]!.turnId);
    await tick(40);
    await agent.waitForAutoTitles();
    expect(codex.titleCalls).toEqual(["帮我看看这个脚本"]);
    row = db.prepare("SELECT title FROM conversations WHERE id = ?").get(conv.id) as { title: string };
    expect(row.title).toBe("自动标题");
  });

  it("never overwrites a title the user set by hand", async () => {
    const conv = agent.createConversation();
    agent.renameConversation(conv.id, "我的会话");
    agent.submitTurn({ conversationId: conv.id, text: "首条消息", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(40);
    await agent.waitForAutoTitles();

    expect(codex.titleCalls).toEqual([]);
    const row = db.prepare("SELECT title FROM conversations WHERE id = ?").get(conv.id) as { title: string };
    expect(row.title).toBe("我的会话");
  });

  it("records a manual rename and announces it in one step", () => {
    const conv = agent.createConversation();
    expect(agent.renameConversation(conv.id, "  我的手改标题  ")).toBe(true);

    const row = db.prepare("SELECT title FROM conversations WHERE id = ?").get(conv.id) as { title: string };
    expect(row.title).toBe("我的手改标题");
    // The marker that stops the auto-titler is written together with the title.
    expect(getMeta(db, `title_manual:${conv.id}`)).not.toBeNull();
    const updates = agent.listEvents(conv.id, 0).filter((e) => e.type === "conversation.title_updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ title: "我的手改标题" });

    // Renaming a conversation that does not exist changes nothing and stays silent.
    expect(agent.renameConversation("conv_missing", "x")).toBe(false);
  });

  it("records an explicit default title at creation as a manual choice", () => {
    const conv = agent.createConversation({ title: "新会话" });
    expect(conv.title).toBe("新会话");
    // Even the default string, when explicitly requested, must not be auto-named.
    expect(getMeta(db, `title_manual:${conv.id}`)).not.toBeNull();
  });

  it("drops deltas from unknown threads while the main turn is active", async () => {
    const conv = agent.createConversation();
    agent.submitTurn({ conversationId: conv.id, text: "主对话", clientMessageId: "m1" });
    await tick();
    const turn = codex.startedTurns[0]!;
    // An auxiliary / unknown thread must never contribute to the main stream.
    codex.emitNotification("item/agentMessage/delta", { threadId: "aux_1", turnId: "turn_aux", itemId: "i1", delta: "标题泄漏" });
    // The registered main thread still buffers normally.
    codex.emitNotification("item/agentMessage/delta", { threadId: turn.threadId, turnId: turn.turnId, itemId: "i2", delta: "正常增量" });
    await tick(300);
    const deltas = agent.listEvents(conv.id, 0).filter((e) => e.type === "stream.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.payload).toEqual({ itemId: "i2", kind: "item/agentMessage/delta", delta: "正常增量" });
    codex.completeTurn(turn.turnId);
    await tick();
  });
});

describe("approval response mapping", () => {
  it("uses the v2 decision vocabulary for command/file approvals", () => {
    expect(buildApprovalResponse("item/commandExecution/requestApproval", "accept")).toEqual({ decision: "accept" });
    expect(buildApprovalResponse("item/fileChange/requestApproval", "cancel")).toEqual({ decision: "cancel" });
  });

  it("uses the legacy ReviewDecision vocabulary for legacy methods", () => {
    expect(buildApprovalResponse("applyPatchApproval", "accept")).toEqual({ decision: "approved" });
    expect(buildApprovalResponse("execCommandApproval", "decline")).toEqual({ decision: "denied" });
    expect(buildApprovalResponse("execCommandApproval", "cancel")).toEqual({ decision: "abort" });
  });

  it("uses the MCP elicitation action envelope rather than an answers map", () => {
    expect(buildApprovalResponse("mcpServer/elicitation/request", "decline")).toEqual({ action: "decline", content: null });
    expect(buildApprovalResponse("mcpServer/elicitation/request", "accept", { content: { name: "x" } })).toEqual({
      action: "accept",
      content: { name: "x" },
    });
    expect(buildApprovalResponse("item/tool/requestUserInput", "accept", { answers: { q1: { answers: ["a"] } } })).toEqual({
      answers: { q1: { answers: ["a"] } },
    });
  });

  it("rejects unknown decisions", () => {
    expect(buildApprovalResponse("item/commandExecution/requestApproval", "maybe")).toBeNull();
  });
});

describe("attachment parsing", () => {
  it("normalises stored attachments and tolerates malformed json", () => {
    expect(parseAttachments('[{"path":"/a.png","kind":"image"}]')).toEqual([{ path: "/a.png", kind: "image", name: undefined }]);
    expect(parseAttachments("not json")).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
  });
});
