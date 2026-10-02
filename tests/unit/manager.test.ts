import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, getMeta, type Db } from "../../src/control/db.js";
import { writeAgentSettings } from "../../src/control/settings.js";
import { Logger } from "../../src/control/logger.js";
import {
  AgentManager,
  InvalidConversationTitleError,
  TurnConflictError,
  buildApprovalResponse,
  parseAttachments,
  type AgentEvent,
} from "../../src/control/codex/manager.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";

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

  it("runs up to three conversations concurrently and queues the fourth", async () => {
    const convs = ["a", "b", "c", "d"].map((t) => agent.createConversation({ title: t }));
    // All four turns stay running until Codex reports completion, so holding the
    // first three naturally fills every slot.
    for (let i = 0; i < 4; i++) {
      agent.submitTurn({ conversationId: convs[i]!.id, text: `msg-${i}`, clientMessageId: `m${i}` });
    }
    await tick(80);
    expect(codex.startedTurns.length).toBe(3);
    const queued = db.prepare("SELECT client_message_id, status FROM turns WHERE status = 'queued'").all() as Array<{
      client_message_id: string;
      status: string;
    }>;
    expect(queued.map((q) => q.client_message_id)).toEqual(["m3"]);

    const status = await agent.status();
    expect(status.activeTurns).toHaveLength(3);
    expect(status.capacity).toBe(3);
    expect(status.queuedTurns).toBe(1);
    // Legacy fields mirror the oldest active turn.
    expect(status.activeTurnId).toBe(status.activeTurns[0]!.turnId);
    expect(status.activeConversationId).toBe(status.activeTurns[0]!.conversationId);

    // Freeing one slot wakes the pump and starts the queued turn.
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(codex.startedTurns.length).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'queued'").get() as { n: number }).n).toBe(0);
  });

  it("never runs two turns for the same conversation at once", async () => {
    const a = agent.createConversation({ title: "a" });
    agent.submitTurn({ conversationId: a.id, text: "first", clientMessageId: "m1" });
    await tick(40);
    agent.submitTurn({ conversationId: a.id, text: "second", clientMessageId: "m2" });
    await tick(60);
    // The first turn holds the conversation's slot; the second stays queued even
    // though two other execution slots are free.
    expect(codex.startedTurns.length).toBe(1);
    expect((db.prepare("SELECT status FROM turns WHERE client_message_id = 'm2'").get() as { status: string }).status).toBe("queued");

    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(codex.startedTurns.length).toBe(2);
    expect(codex.startedTurns[1]!.text).toBe("second");
  });

  it("cancels a queued turn instead of merely announcing it", async () => {
    // Fill all three slots so the target conversation's turn is genuinely queued.
    const holders = ["h1", "h2", "h3"].map((t) => agent.createConversation({ title: t }));
    const b = agent.createConversation({ title: "b" });
    for (let i = 0; i < 3; i++) {
      agent.submitTurn({ conversationId: holders[i]!.id, text: `hold-${i}`, clientMessageId: `h${i}` });
    }
    const second = agent.submitTurn({ conversationId: b.id, text: "second", clientMessageId: "m2" });
    await tick(80);
    expect(codex.startedTurns.length).toBe(3);

    const result = await agent.interrupt(b.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("queued");
    const row = db.prepare("SELECT status FROM turns WHERE id = ?").get(second.turn.id) as { status: string };
    expect(row.status).toBe("interrupted");

    // Free a slot; the cancelled turn must never reach Codex.
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(codex.startedTurns.some((t) => t.text === "second")).toBe(false);
    expect(codex.startedTurns.length).toBe(3);
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

  it("applies the unified owner settings to every later message over a stale conversation model", async () => {
    const models = await agent.listModels();
    const conv = agent.createConversation({ title: "unified" });
    // A conversation carrying an old per-conversation model must not win: the
    // saved unified config is authoritative for later messages.
    db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run("gpt-5.5", conv.id);
    const saved = agent.saveAgentSettings({ model: "gpt-6-sol", effort: "high" }, models);
    expect(saved.ok).toBe(true);

    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick();

    expect(codex.startedTurns[0]?.model).toBe("gpt-6-sol");
    const turn = db.prepare("SELECT model, effort FROM turns WHERE client_message_id = 'm1'").get() as {
      model: string;
      effort: string | null;
    };
    expect(turn.model).toBe("gpt-6-sol");
    expect(turn.effort).toBe("high");
    expect(agent.agentSettings()).toEqual({ model: "gpt-6-sol", effort: "high" });
  });

  it("freezes the resolved model on a queued turn so a later config change cannot alter it", async () => {
    const models = await agent.listModels();
    const holders = ["h1", "h2", "h3"].map((t) => agent.createConversation({ title: t }));
    for (let i = 0; i < 3; i++) {
      agent.submitTurn({ conversationId: holders[i]!.id, text: `hold-${i}`, clientMessageId: `hold-${i}` });
    }
    await tick(80);
    expect(codex.startedTurns.length).toBe(3);

    // Submitted while every slot is busy, so this turn genuinely waits in queue.
    agent.saveAgentSettings({ model: "gpt-6-sol", effort: "medium" }, models);
    const conv = agent.createConversation({ title: "queued" });
    agent.submitTurn({ conversationId: conv.id, text: "queued", clientMessageId: "q1" });
    await tick(40);
    expect((db.prepare("SELECT status FROM turns WHERE client_message_id = 'q1'").get() as { status: string }).status).toBe("queued");
    const frozen = db.prepare("SELECT model, effort FROM turns WHERE client_message_id = 'q1'").get() as { model: string; effort: string };
    expect(frozen.model).toBe("gpt-6-sol");

    // The owner changes the unified config, and another turn rewrites the stored
    // conversation model, before the queued turn ever starts.
    agent.saveAgentSettings({ model: "gpt-5.5", effort: null }, models);
    db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run("gpt-5.5", conv.id);

    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(120);
    const started = codex.startedTurns.find((t) => t.text === "queued");
    expect(started?.model).toBe("gpt-6-sol");
  });

  it("uses the configured default for a later message when the global choice is unset", async () => {
    const conv = agent.createConversation({ title: "stale" });
    // A conversation carrying an old model must not win when no unified choice
    // has been saved: the config page shows "default", so the turn must run it.
    db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run("gpt-5.5", conv.id);
    expect(agent.agentSettings()).toEqual({ model: null, effort: null });

    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick();

    expect(codex.startedTurns[0]?.model).toBe("gpt-6-sol");
    const row = db.prepare("SELECT model FROM conversations WHERE id = ?").get(conv.id) as { model: string };
    expect(row.model).toBe("gpt-6-sol");
  });

  it("keeps a saved effort when the model catalog was never fetched", async () => {
    // Simulates a restart where the user sends before opening the config page and
    // the catalog is still unavailable: the stored, already-validated effort must
    // survive rather than being silently dropped.
    const db2 = openDb(":memory:");
    const codex2 = new FakeCodex();
    codex2.listModels = async () => {
      throw new Error("codex not up yet");
    };
    const cfg2 = testConfig("/tmp/pa-manager-test", 1);
    const hostTokens = { status: async () => ({ ok: true, authMethod: "chatgpt", email: null, planType: null, expiresAt: null, error: null }) } as unknown as HostTokenSource;
    const agent2 = new AgentManager({ cfg: cfg2, db: db2, log: new Logger("error", undefined, false), codex: codex2, hostTokens });
    await agent2.init();
    // Seed a saved choice directly (the API validated it when it was saved).
    writeAgentSettings(db2, { model: "gpt-6-sol", effort: "high" });

    const conv = agent2.createConversation({ title: "cold" });
    agent2.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "cold-1" });
    await tick();

    const turn = db2.prepare("SELECT model, effort FROM turns WHERE client_message_id = 'cold-1'").get() as {
      model: string;
      effort: string | null;
    };
    expect(turn.model).toBe("gpt-6-sol");
    expect(turn.effort).toBe("high");
    expect(codex2.startedTurns[0]?.model).toBe("gpt-6-sol");
    agent2.shutdown();
    db2.close();
  });

  it("backfills a frozen model for turns created before the column existed", async () => {
    const db2 = openDb(":memory:");
    const { agent: fresh } = makeManager({}, db2);
    await fresh.init();
    const conv = fresh.createConversation({ title: "legacy" });
    fresh.submitTurn({ conversationId: conv.id, text: "old", clientMessageId: "old-1" });
    await tick(60);
    // Simulate a pre-migration row: the turn has no frozen model, but the queued
    // event still carries the snapshot it was accepted with.
    db2.prepare("UPDATE turns SET model = NULL WHERE client_message_id = 'old-1'").run();
    db2.prepare("UPDATE conversations SET model = ? WHERE id = ?").run("gpt-6-astra", conv.id);
    fresh.shutdown();

    const second = makeManager({}, db2);
    await second.agent.init();
    const row = db2.prepare("SELECT model FROM turns WHERE client_message_id = 'old-1'").get() as { model: string | null };
    expect(row.model).toBe("gpt-6-sol");
    second.agent.shutdown();
    db2.close();
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

  it("records a manual rename and announces it in one step", () => {
    const conv = agent.createConversation();
    expect(agent.renameConversation(conv.id, "  我的手改标题  ").renamed).toBe(true);

    const row = db.prepare("SELECT title FROM conversations WHERE id = ?").get(conv.id) as { title: string };
    expect(row.title).toBe("我的手改标题");
    const updates = agent.listEvents(conv.id, 0).filter((e) => e.type === "conversation.title_updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ title: "我的手改标题" });

    // Renaming a conversation that does not exist changes nothing and stays silent.
    expect(agent.renameConversation("conv_missing", "x").renamed).toBe(false);
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

  it("attributes events, deltas and approvals to the right conversation under concurrency", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    const c = agent.createConversation({ title: "c" });
    for (const [conv, id] of [
      [a, "ma"],
      [b, "mb"],
      [c, "mc"],
    ] as const) {
      agent.submitTurn({ conversationId: conv.id, text: id, clientMessageId: id });
    }
    await tick(80);
    expect(codex.startedTurns.length).toBe(3);
    const turnA = codex.startedTurns[0]!;
    const turnB = codex.startedTurns[1]!;
    const turnC = codex.startedTurns[2]!;

    // Interleaved deltas must land on their own conversation only.
    codex.emitNotification("item/agentMessage/delta", { threadId: turnA.threadId, turnId: turnA.turnId, itemId: "ia", delta: "A" });
    codex.emitNotification("item/agentMessage/delta", { threadId: turnC.threadId, turnId: turnC.turnId, itemId: "ic", delta: "C" });
    codex.emitNotification("item/agentMessage/delta", { threadId: turnB.threadId, turnId: turnB.turnId, itemId: "ib", delta: "B" });
    // A non-delta item for B must not flush A's or C's buffered delta into B.
    codex.emitNotification("item/completed", { threadId: turnB.threadId, turnId: turnB.turnId, item: { id: "ib", type: "agentMessage", text: "B" } });
    await tick(20);

    const deltas = (conv: string) =>
      agent.listEvents(conv, 0).filter((e) => e.type === "stream.delta").map((e) => (e.payload as { delta: string }).delta);
    expect(deltas(a.id)).toEqual(["A"]);
    expect(deltas(b.id)).toEqual(["B"]);
    expect(deltas(c.id)).toEqual(["C"]);
    // The completed item for B belongs to B's turn only.
    const completedB = agent.listEvents(b.id, 0).find((e) => e.type === "item/completed");
    expect(completedB?.turnId).toBe(agent.listTurns(b.id).find((t) => t.client_message_id === "mb")!.id);

    // An approval for C is attributed to C and only C.
    codex.emitServerRequest("sr-a", "item/commandExecution/requestApproval", { threadId: turnA.threadId, turnId: turnA.turnId, command: "ls a" });
    codex.emitServerRequest("sr-c", "item/commandExecution/requestApproval", { threadId: turnC.threadId, turnId: turnC.turnId, command: "ls c" });
    await tick(20);
    expect(agent.listPendingRequests(a.id)).toHaveLength(1);
    expect(agent.listPendingRequests(b.id)).toHaveLength(0);
    expect(agent.listPendingRequests(c.id)).toHaveLength(1);

    // An approval whose thread cannot be routed is denied, not shown anywhere.
    codex.emitServerRequest("sr-unknown", "item/commandExecution/requestApproval", { threadId: "thread_unknown", turnId: "turn_unknown" });
    await tick(20);
    expect(codex.answers.find((x) => x.id === "sr-unknown")?.result).toEqual({ decision: "decline" });
    expect(agent.listPendingRequests().length).toBe(2);

    for (const turn of [turnA, turnB, turnC]) codex.completeTurn(turn.turnId);
    await tick(80);
  });

  it("interrupts one conversation without touching the others", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    const c = agent.createConversation({ title: "c" });
    for (const [conv, id] of [
      [a, "ma"],
      [b, "mb"],
      [c, "mc"],
    ] as const) {
      agent.submitTurn({ conversationId: conv.id, text: id, clientMessageId: id });
    }
    await tick(80);
    const result = await agent.interrupt(b.id);
    expect(result.status).toBe("running");
    expect(codex.interrupted).toEqual([{ threadId: codex.startedTurns[1]!.threadId, turnId: codex.startedTurns[1]!.turnId }]);
    // The other two turns were never interrupted.
    expect(codex.interrupted.some((i) => i.turnId === codex.startedTurns[0]!.turnId)).toBe(false);
    expect(codex.interrupted.some((i) => i.turnId === codex.startedTurns[2]!.turnId)).toBe(false);
    // All three are still executing until Codex reports their outcomes.
    expect((await agent.status()).activeTurns).toHaveLength(3);
    for (const turn of codex.startedTurns) codex.completeTurn(turn.turnId);
    await tick(80);
  });

  it("marks every in-flight turn unknown when the connection dies under concurrency", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    agent.submitTurn({ conversationId: a.id, text: "ma", clientMessageId: "ma" });
    agent.submitTurn({ conversationId: b.id, text: "mb", clientMessageId: "mb" });
    await tick(80);
    expect(codex.startedTurns.length).toBe(2);
    codex.emitClosed("exit code=137 signal=null");
    await tick(80);
    const rows = db.prepare("SELECT status FROM turns ORDER BY created_at").all() as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["unknown", "unknown"]);
    expect(codex.startedTurns.length).toBe(2);
  });

  it("reconciles multiple running turns after a restart without replaying any", async () => {
    const conv = agent.createConversation({ title: "multi" });
    const now = Date.now();
    for (const id of ["t1", "t2", "t3", "t4"]) {
      db.prepare("INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at) VALUES (?,?,?,?,?,?)").run(
        id,
        conv.id,
        id,
        id === "t4" ? "queued" : "running",
        id,
        now,
      );
    }
    const freshCodex = new FakeCodex();
    const fresh = new AgentManager({
      cfg: testConfig("/tmp/pa-manager-test", 1),
      db,
      log: new Logger("error", undefined, false),
      codex: freshCodex,
      hostTokens: { status: async () => ({}) } as unknown as HostTokenSource,
    });
    await fresh.init();
    const statuses = db.prepare("SELECT id, status FROM turns ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(statuses.map((s) => s.status)).toEqual(["unknown", "unknown", "unknown", "interrupted"]);
    expect(freshCodex.startedTurns.length).toBe(0);
    fresh.shutdown();
  });

  it("normalizes every tool-output stream method into a stream.delta with its original kind", async () => {
    const conv = agent.createConversation({ title: "tool output" });
    agent.submitTurn({ conversationId: conv.id, text: "run", clientMessageId: "m1" });
    await tick(40);
    const turn = codex.startedTurns[0]!;
    codex.emitNotification("item/started", { threadId: turn.threadId, turnId: turn.turnId, item: { id: "cmd1", type: "commandExecution", command: "probe" } });
    // Each of these is buffered by the manager and re-emitted as `stream.delta`
    // carrying the original method in `kind`, keyed by the tool's itemId. The web
    // client relies on that shape to route output into the tool card.
    const methods: Array<[string, Record<string, unknown>]> = [
      ["item/commandExecution/outputDelta", { delta: "cmd-out" }],
      ["item/fileChange/outputDelta", { delta: "file-out" }],
      ["command/exec/outputDelta", { delta: "exec-out" }],
      ["process/outputDelta", { delta: "proc-out" }],
      ["item/mcpToolCall/progress", { delta: "mcp-out" }],
    ];
    for (const [method, extra] of methods) {
      codex.emitNotification(method, { threadId: turn.threadId, turnId: turn.turnId, itemId: "cmd1", ...extra });
    }
    await tick(400);
    const deltas = agent.listEvents(conv.id, 0).filter((e) => e.type === "stream.delta");
    expect(deltas).toHaveLength(methods.length);
    for (const e of deltas) {
      const payload = e.payload as { itemId: string; kind: string; delta: string };
      expect(payload.itemId).toBe("cmd1");
      expect(methods.map(([m]) => m)).toContain(payload.kind);
      expect(payload.delta).toMatch(/-out$/);
    }
    codex.completeTurn(turn.turnId);
    await tick();
  });

  it("requests a concise reasoning summary and never surfaces raw chain-of-thought", async () => {
    const conv = agent.createConversation({ title: "reasoning" });
    agent.submitTurn({ conversationId: conv.id, text: "think", clientMessageId: "m1" });
    await tick(40);
    const turn = codex.startedTurns[0]!;
    // The manager must opt into summaries on the main turn.
    expect(codex.lastStartTurnSummary).toBe("concise");
    // Raw reasoning text deltas are dropped; summary deltas are kept.
    codex.emitNotification("item/reasoning/textDelta", { threadId: turn.threadId, turnId: turn.turnId, itemId: "r1", delta: "RAW" });
    codex.emitNotification("item/reasoning/summaryTextDelta", { threadId: turn.threadId, turnId: turn.turnId, itemId: "r1", summaryIndex: 0, delta: "摘要" });
    await tick(300);
    const deltas = agent.listEvents(conv.id, 0).filter((e) => e.type === "stream.delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0]!.payload as { kind: string }).kind).toBe("item/reasoning/summaryTextDelta");
    codex.completeTurn(turn.turnId);
    await tick();
  });

  it("rejects an event whose thread and turn identities disagree", async () => {
    const a = agent.createConversation({ title: "a" });
    const b = agent.createConversation({ title: "b" });
    agent.submitTurn({ conversationId: a.id, text: "ma", clientMessageId: "ma" });
    agent.submitTurn({ conversationId: b.id, text: "mb", clientMessageId: "mb" });
    await tick(80);
    const turnA = codex.startedTurns[0]!;
    const turnB = codex.startedTurns[1]!;

    // A's thread paired with B's turn id must never be written into A (or B).
    codex.emitNotification("item/agentMessage/delta", { threadId: turnA.threadId, turnId: turnB.turnId, itemId: "mix", delta: "MIX" });
    codex.emitNotification("item/completed", {
      threadId: turnA.threadId,
      turnId: turnB.turnId,
      item: { id: "mix", type: "agentMessage", text: "MIX" },
    });
    await tick(300);
    expect(agent.listEvents(a.id, 0).filter((e) => e.type === "stream.delta")).toHaveLength(0);
    expect(agent.listEvents(b.id, 0).filter((e) => e.type === "stream.delta")).toHaveLength(0);
    expect(agent.listEvents(a.id, 0).some((e) => e.type === "item/completed")).toBe(false);
    expect(agent.listEvents(b.id, 0).some((e) => e.type === "item/completed")).toBe(false);

    // A mismatched approval is denied and shown nowhere.
    codex.emitServerRequest("sr-mix", "item/commandExecution/requestApproval", {
      threadId: turnA.threadId,
      turnId: turnB.turnId,
      command: "ls",
    });
    await tick(20);
    expect(codex.answers.find((x) => x.id === "sr-mix")?.result).toEqual({ decision: "decline" });
    expect(agent.listPendingRequests()).toHaveLength(0);

    // The correctly paired identity still routes to A's own turn.
    codex.emitNotification("item/agentMessage/delta", { threadId: turnA.threadId, turnId: turnA.turnId, itemId: "ok", delta: "OK" });
    await tick(300);
    const ok = agent.listEvents(a.id, 0).filter((e) => e.type === "stream.delta");
    expect(ok).toHaveLength(1);
    expect(ok[0]!.turnId).toBe(agent.listTurns(a.id).find((t) => t.client_message_id === "ma")!.id);

    for (const turn of [turnA, turnB]) codex.completeTurn(turn.turnId);
    await tick(80);
  });

  it("rejects a stale turn id once the active turn already has its codex turn id", async () => {
    const a = agent.createConversation({ title: "a" });
    agent.submitTurn({ conversationId: a.id, text: "first", clientMessageId: "m1" });
    await tick(40);
    const first = codex.startedTurns[0]!;
    codex.completeTurn(first.turnId);
    await tick(80);

    agent.submitTurn({ conversationId: a.id, text: "second", clientMessageId: "m2" });
    await tick(40);
    const second = codex.startedTurns[1]!;
    expect(second.threadId).toBe(first.threadId);

    // Same thread, but an older turn: no longer live, so it is dropped.
    codex.emitNotification("item/agentMessage/delta", { threadId: second.threadId, turnId: first.turnId, itemId: "old", delta: "OLD" });
    codex.emitNotification("item/completed", {
      threadId: second.threadId,
      turnId: first.turnId,
      item: { id: "old", type: "agentMessage", text: "OLD" },
    });
    codex.emitServerRequest("sr-old", "item/commandExecution/requestApproval", { threadId: second.threadId, turnId: first.turnId, command: "ls" });
    await tick(300);
    expect(agent.listEvents(a.id, 0).filter((e) => e.type === "stream.delta")).toHaveLength(0);
    expect(
      agent.listEvents(a.id, 0).some((e) => e.type === "item/completed" && (e.payload as { item?: { id?: string } }).item?.id === "old"),
    ).toBe(false);
    expect(codex.answers.find((x) => x.id === "sr-old")?.result).toEqual({ decision: "decline" });
    expect(agent.listPendingRequests()).toHaveLength(0);

    // The live turn id still routes.
    codex.emitNotification("item/agentMessage/delta", { threadId: second.threadId, turnId: second.turnId, itemId: "new", delta: "NEW" });
    await tick(300);
    const live = agent.listEvents(a.id, 0).filter((e) => e.type === "stream.delta");
    expect(live).toHaveLength(1);
    expect(live[0]!.turnId).toBe(agent.listTurns(a.id).find((t) => t.client_message_id === "m2")!.id);

    codex.completeTurn(second.turnId);
    await tick(80);
  });

  it("drops events from an unknown thread instead of attributing them to an active turn", async () => {
    const a = agent.createConversation({ title: "a" });
    agent.submitTurn({ conversationId: a.id, text: "ma", clientMessageId: "ma" });
    await tick(40);
    const turnA = codex.startedTurns[0]!;

    codex.emitNotification("item/agentMessage/delta", { threadId: "thread_other", turnId: turnA.turnId, itemId: "x", delta: "X" });
    codex.emitNotification("item/completed", {
      threadId: "thread_other",
      turnId: turnA.turnId,
      item: { id: "x", type: "agentMessage", text: "X" },
    });
    codex.emitServerRequest("sr-other", "item/commandExecution/requestApproval", { threadId: "thread_other", turnId: turnA.turnId, command: "ls" });
    await tick(300);
    expect(agent.listEvents(a.id, 0).filter((e) => e.type === "stream.delta")).toHaveLength(0);
    expect(agent.listEvents(a.id, 0).some((e) => e.type === "item/completed")).toBe(false);
    expect(codex.answers.find((x) => x.id === "sr-other")?.result).toEqual({ decision: "decline" });
    expect(agent.listPendingRequests()).toHaveLength(0);

    codex.completeTurn(turnA.turnId);
    await tick(80);
  });

  it("routes an early event for the starting turn before startTurn resolves", async () => {
    const a = agent.createConversation({ title: "a" });
    let release!: () => void;
    codex.startTurnGate = new Promise<void>((resolve) => (release = resolve));
    const submitted = agent.submitTurn({ conversationId: a.id, text: "early", clientMessageId: "me" });
    await tick(40);
    const threadId = codex.startedThreads[0]!.threadId;

    // The codex turn id is not persisted yet; the thread identity alone must be
    // enough to attach the event to the turn that is still starting.
    codex.emitNotification("item/started", { threadId, turnId: "turn_not_yet_known", item: { id: "e1", type: "agentMessage" } });
    await tick(20);
    const early = agent.listEvents(a.id, 0).find((e) => e.type === "item/started");
    expect(early).toBeDefined();
    expect(early!.turnId).toBe(submitted.turn.id);

    // Once the real codex turn id exists, the same foreign id is stale and dropped.
    release();
    await tick(40);
    const codexTurnId = codex.startedTurns[0]!.turnId;
    expect(codexTurnId).not.toBe("turn_not_yet_known");
    codex.emitNotification("item/completed", {
      threadId,
      turnId: "turn_not_yet_known",
      item: { id: "e1", type: "agentMessage", text: "late" },
    });
    await tick(20);
    expect(agent.listEvents(a.id, 0).some((e) => e.type === "item/completed")).toBe(false);

    codex.completeTurn(codexTurnId);
    await tick(80);
  });

  it("keeps three concurrent conversations isolated for events and approvals", async () => {
    const convs = ["a", "b", "c"].map((t) => agent.createConversation({ title: t }));
    convs.forEach((c, i) => agent.submitTurn({ conversationId: c.id, text: `m${i}`, clientMessageId: `m${i}` }));
    await tick(80);
    expect(codex.startedTurns.length).toBe(3);
    const [ta, tb, tc] = codex.startedTurns;

    for (const [turn, delta] of [
      [ta, "A"],
      [tb, "B"],
      [tc, "C"],
    ] as const) {
      codex.emitNotification("item/agentMessage/delta", { threadId: turn.threadId, turnId: turn.turnId, itemId: `i${delta}`, delta });
      codex.emitServerRequest(`sr-${delta}`, "item/commandExecution/requestApproval", {
        threadId: turn.threadId,
        turnId: turn.turnId,
        command: `ls ${delta}`,
      });
    }
    await tick(300);

    convs.forEach((c, i) => {
      const expected = ["A", "B", "C"][i]!;
      const deltas = agent.listEvents(c.id, 0).filter((e) => e.type === "stream.delta");
      expect(deltas.map((e) => (e.payload as { delta: string }).delta)).toEqual([expected]);
      const pending = agent.listPendingRequests(c.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.codex_request_id).toBe(`sr-${expected}`);
    });

    // A cross-thread mismatch among the three is still denied.
    codex.emitServerRequest("sr-mix", "item/commandExecution/requestApproval", { threadId: ta.threadId, turnId: tb.turnId, command: "ls" });
    await tick(20);
    expect(codex.answers.find((x) => x.id === "sr-mix")?.result).toEqual({ decision: "decline" });
    expect(agent.listPendingRequests()).toHaveLength(3);

    for (const turn of codex.startedTurns) codex.completeTurn(turn.turnId);
    await tick(80);
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

describe("conversation lifecycle management", () => {
  it("reuses an active blank default conversation and keeps explicit titles separate", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const first = agent.getOrCreateConversation();
    expect(first.reused).toBe(false);
    expect(first.conversation.title).toBe("新会话");

    const second = agent.getOrCreateConversation();
    expect(second.reused).toBe(true);
    expect(second.conversation.id).toBe(first.conversation.id);

    const explicit = agent.getOrCreateConversation({ title: "显式" });
    expect(explicit.reused).toBe(false);
    expect(explicit.conversation.id).not.toBe(first.conversation.id);
    agent.shutdown();
    db.close();
  });

  it("refuses to restore a blank default while another active blank default exists", () => {
    const { agent, db } = makeManager();
    const activeBlank = agent.createConversation();
    const archivedBlank = agent.createConversation();
    agent.archiveConversation(archivedBlank.id, true);

    const conflict = agent.restoreConversation(archivedBlank.id);
    expect(conflict.conflict).toBe(true);
    expect(agent.getConversation(archivedBlank.id)?.archived).toBe(1);

    // With no active blank left, the restore succeeds.
    agent.archiveConversation(activeBlank.id, true);
    const ok = agent.restoreConversation(archivedBlank.id);
    expect(ok.restored).toBe(true);
    expect(agent.getConversation(archivedBlank.id)?.archived).toBe(0);
    agent.shutdown();
    db.close();
  });

  it("restores a conversation with messages even while a blank default is active", async () => {
    const { agent, codex, db } = makeManager();
    await agent.init();
    agent.createConversation();
    const used = agent.createConversation({ title: "有消息" });
    agent.submitTurn({ conversationId: used.id, text: "hi", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    agent.archiveConversation(used.id, true);

    const restored = agent.restoreConversation(used.id);
    expect(restored.restored).toBe(true);
    expect(agent.getConversation(used.id)?.archived).toBe(0);
    agent.shutdown();
    db.close();
  });

  it("does not reuse a blank default conversation once it has a turn", async () => {
    const { agent, codex, db } = makeManager();
    await agent.init();
    const first = agent.getOrCreateConversation();
    agent.submitTurn({ conversationId: first.conversation.id, text: "hi", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();

    const second = agent.getOrCreateConversation();
    expect(second.reused).toBe(false);
    expect(second.conversation.id).not.toBe(first.conversation.id);
    agent.shutdown();
    db.close();
  });

  it("refuses to rename a blank conversation onto the active default slot", () => {
    const { agent, db } = makeManager();
    // One active blank default already occupies the single default slot.
    agent.createConversation();
    const other = agent.createConversation({ title: "有标题" });

    const conflict = agent.renameConversation(other.id, "新会话");
    expect(conflict.conflict).toBe(true);
    expect(conflict.renamed).toBe(false);
    expect(agent.getConversation(other.id)?.title).toBe("有标题");

    // A non-default title still renames normally.
    const ok = agent.renameConversation(other.id, "自定义标题");
    expect(ok.conflict).toBe(false);
    expect(ok.renamed).toBe(true);
    expect(agent.getConversation(other.id)?.title).toBe("自定义标题");
    agent.shutdown();
    db.close();
  });

  it("allows the default title once the active conversation is no longer blank", async () => {
    const { agent, codex, db } = makeManager();
    await agent.init();
    const first = agent.createConversation();
    agent.submitTurn({ conversationId: first.id, text: "hi", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();

    const second = agent.createConversation({ title: "另一个" });
    const ok = agent.renameConversation(second.id, "新会话");
    expect(ok.conflict).toBe(false);
    expect(ok.renamed).toBe(true);
    expect(agent.getConversation(second.id)?.title).toBe("新会话");
    agent.shutdown();
    db.close();
  });

  it("rejects blank and over-long manual titles instead of silently rewriting them", () => {
    const { agent, db } = makeManager();
    const conv = agent.createConversation({ title: "原名" });
    for (const bad of ["", "   ", "x".repeat(201)]) {
      expect(() => agent.renameConversation(conv.id, bad)).toThrow(InvalidConversationTitleError);
    }
    expect(agent.getConversation(conv.id)?.title).toBe("原名");

    const ok = agent.renameConversation(conv.id, `  ${"y".repeat(200)}  `);
    expect(ok.renamed).toBe(true);
    expect(agent.getConversation(conv.id)?.title).toBe("y".repeat(200));
    agent.shutdown();
    db.close();
  });

  it("archives duplicate blank defaults on init but never a conversation with messages", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const insert = (id: string, createdAt: number) => {
      db.prepare(
        "INSERT INTO conversations (id, owner_id, title, model, cwd, status, archived, created_at, updated_at) VALUES (?, 'owner_1', '新会话', NULL, '/home/gem/workspace', 'idle', 0, ?, ?)",
      ).run(id, createdAt, createdAt);
    };
    insert("blank_old", now - 3000);
    insert("blank_mid", now - 2000);
    insert("blank_new", now - 1000);
    insert("has_message", now - 4000);
    db.prepare(
      "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at) VALUES ('t1', 'has_message', 'cm1', 'completed', 'hello', ?)",
    ).run(now - 4000);

    const { agent } = makeManager({}, db);
    await agent.init();
    const active = db.prepare("SELECT id FROM conversations WHERE archived = 0 ORDER BY id").all() as Array<{ id: string }>;
    expect(active.map((r) => r.id)).toEqual(["blank_new", "has_message"]);
    const archived = db.prepare("SELECT id FROM conversations WHERE archived = 1 ORDER BY id").all() as Array<{ id: string }>;
    expect(archived.map((r) => r.id)).toEqual(["blank_mid", "blank_old"]);
    agent.shutdown();
    db.close();
  });
});

describe("conversation list ordering", () => {
  let turnSeq = 0;
  function addTurn(db: Db, conversationId: string, opts: { createdAt: number; completedAt?: number | null; status?: string }): void {
    turnSeq += 1;
    db.prepare(
      "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at, completed_at) VALUES (?, ?, ?, ?, '', ?, ?)",
    ).run(`turn_sort_${turnSeq}`, conversationId, `cm_sort_${turnSeq}`, opts.status ?? "completed", opts.createdAt, opts.completedAt ?? null);
  }
  const ids = (agent: AgentManager): string[] => agent.listConversations().map((c) => c.id);

  it("pins an active blank default created before the other conversations", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const blank = agent.createConversation();
    const older = agent.createConversation({ title: "旧会话" });
    addTurn(db, older.id, { createdAt: 1_000, completedAt: 2_000 });
    const newer = agent.createConversation({ title: "新会话标题" });
    addTurn(db, newer.id, { createdAt: 3_000, completedAt: 4_000 });

    expect(ids(agent)[0]).toBe(blank.id);
    agent.shutdown();
    db.close();
  });

  it("pins an active blank default created after the other conversations", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const older = agent.createConversation({ title: "旧会话" });
    addTurn(db, older.id, { createdAt: 1_000, completedAt: 2_000 });
    const newer = agent.createConversation({ title: "新会话标题" });
    addTurn(db, newer.id, { createdAt: 3_000, completedAt: 4_000 });
    const blank = agent.createConversation();

    expect(ids(agent)[0]).toBe(blank.id);
    agent.shutdown();
    db.close();
  });

  it("orders by the latest turn, using the completed reply time", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const a = agent.createConversation({ title: "A" });
    addTurn(db, a.id, { createdAt: 1_000, completedAt: 5_000 });
    const b = agent.createConversation({ title: "B" });
    addTurn(db, b.id, { createdAt: 2_000, completedAt: 2_500 });

    // A's user input is older, but its agent reply completed later than B's turn.
    expect(ids(agent)).toEqual([a.id, b.id]);
    agent.shutdown();
    db.close();
  });

  it("uses a conversation's newest turn among several messages", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const a = agent.createConversation({ title: "A" });
    addTurn(db, a.id, { createdAt: 1_000, completedAt: 1_200 });
    addTurn(db, a.id, { createdAt: 4_000, completedAt: 4_100 });
    const b = agent.createConversation({ title: "B" });
    addTurn(db, b.id, { createdAt: 3_000, completedAt: 3_000 });

    expect(ids(agent)).toEqual([a.id, b.id]);
    agent.shutdown();
    db.close();
  });

  it("falls back to creation time for a conversation without turns", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const older = agent.createConversation({ title: "旧" });
    const newer = agent.createConversation({ title: "新" });

    // `createConversation` stamps both with `Date.now()`; force distinct times.
    db.prepare("UPDATE conversations SET created_at = 1, updated_at = 1 WHERE id = ?").run(older.id);
    db.prepare("UPDATE conversations SET created_at = 2, updated_at = 2 WHERE id = ?").run(newer.id);

    expect(ids(agent)).toEqual([newer.id, older.id]);
    agent.shutdown();
    db.close();
  });

  it("does not let rename, restore or status updates move an old conversation up", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const old = agent.createConversation({ title: "旧" });
    addTurn(db, old.id, { createdAt: 1_000, completedAt: 1_000 });
    const recent = agent.createConversation({ title: "新" });
    addTurn(db, recent.id, { createdAt: 2_000, completedAt: 2_000 });
    expect(ids(agent)).toEqual([recent.id, old.id]);

    // A rename and a status change both bump `updated_at`; neither is a message.
    agent.renameConversation(old.id, "旧（改名）");
    db.prepare("UPDATE conversations SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now() + 100_000, old.id);
    expect(ids(agent)).toEqual([recent.id, old.id]);

    // Archiving then restoring the recent conversation must not demote it either.
    agent.archiveConversation(recent.id, true);
    agent.restoreConversation(recent.id);
    expect(ids(agent)).toEqual([recent.id, old.id]);
    agent.shutdown();
    db.close();
  });

  it("does not force an archived blank default to the top of the archived list", async () => {
    const { agent, db } = makeManager();
    await agent.init();
    const blank = agent.createConversation();
    const used = agent.createConversation({ title: "有消息" });
    addTurn(db, used.id, { createdAt: 5_000, completedAt: 5_000 });
    // Make the blank clearly older, then archive both.
    db.prepare("UPDATE conversations SET created_at = 100, updated_at = 100 WHERE id = ?").run(blank.id);
    agent.archiveConversation(blank.id, true);
    agent.archiveConversation(used.id, true);

    const archived = agent.listConversations(true).filter((c) => c.archived === 1).map((c) => c.id);
    expect(archived).toEqual([used.id, blank.id]);
    agent.shutdown();
    db.close();
  });
});

describe("AgentManager item lifecycle idempotency", () => {
  let agent: AgentManager;
  let codex: FakeCodex;
  let db: Db;
  let seq = 0;

  beforeEach(async () => {
    ({ agent, codex, db } = makeManager());
    await agent.init();
  });

  afterEach(() => {
    agent.shutdown();
    db.close();
  });

  /** Start one held turn on a fresh conversation; returns its routed identities. */
  async function startHeldTurn(title = "idem"): Promise<{ conversationId: string; threadId: string; turnId: string }> {
    const conv = agent.createConversation({ title });
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: `idem-${++seq}` });
    await tick(40);
    return { conversationId: conv.id, threadId: codex.startedThreads[0]!.threadId, turnId: codex.startedTurns[0]!.turnId };
  }

  function startedItem(ids: { threadId: string; turnId: string }, itemId: string, extra: Record<string, unknown> = {}) {
    return { threadId: ids.threadId, turnId: ids.turnId, item: { id: itemId, type: "agentMessage", text: "", ...extra } };
  }

  it("persists and emits an identical item/started re-send only once", async () => {
    const ids = await startHeldTurn();
    const emitted: AgentEvent[] = [];
    agent.events.on("event", (e: AgentEvent) => emitted.push(e));

    const payload = startedItem(ids, "msg_dup");
    codex.emitNotification("item/started", payload);
    codex.emitNotification("item/started", payload); // bridge re-send, identical payload
    await tick(10);

    expect(agent.listEvents(ids.conversationId, 0).filter((e) => e.type === "item/started")).toHaveLength(1);
    expect(emitted.filter((e) => e.type === "item/started")).toHaveLength(1);

    codex.releaseTurn(ids.threadId);
    codex.completeTurn(ids.turnId);
    await tick(40);
  });

  it("persists an identical item/completed re-send only once", async () => {
    const ids = await startHeldTurn("completed");
    const payload = { threadId: ids.threadId, turnId: ids.turnId, item: { id: "msg_done", type: "agentMessage", text: "DONE" } };
    codex.emitNotification("item/completed", payload);
    codex.emitNotification("item/completed", payload);
    await tick(10);

    expect(agent.listEvents(ids.conversationId, 0).filter((e) => e.type === "item/completed")).toHaveLength(1);

    codex.releaseTurn(ids.threadId);
    codex.completeTurn(ids.turnId);
    await tick(40);
  });

  it("keeps a same item id with a different payload, a different item id, and a different turn", async () => {
    const ids = await startHeldTurn("variants");

    // Same item id, different payload (the empty text became real content).
    codex.emitNotification("item/started", startedItem(ids, "same_id", { text: "" }));
    codex.emitNotification("item/started", startedItem(ids, "same_id", { text: "real content" }));
    await tick(10);
    const sameIdEvents = agent.listEvents(ids.conversationId, 0).filter((e) => e.type === "item/started");
    expect(sameIdEvents).toHaveLength(2);

    // Different item id with an otherwise identical shape.
    codex.emitNotification("item/started", startedItem(ids, "other_id"));
    await tick(10);
    expect(agent.listEvents(ids.conversationId, 0).filter((e) => e.type === "item/started")).toHaveLength(3);

    codex.releaseTurn(ids.threadId);
    codex.completeTurn(ids.turnId);
    await tick(40);

    // Same conversation, next turn: a reused item id must still persist.
    agent.submitTurn({ conversationId: ids.conversationId, text: "again", clientMessageId: `idem-${++seq}` });
    await tick(40);
    const turn2 = codex.startedTurns[codex.startedTurns.length - 1]!;
    expect(turn2.turnId).not.toBe(ids.turnId);
    codex.emitNotification("item/started", startedItem({ threadId: turn2.threadId, turnId: turn2.turnId }, "same_id"));
    await tick(10);
    expect(agent.listEvents(ids.conversationId, 0).filter((e) => e.type === "item/started")).toHaveLength(4);

    codex.completeTurn(turn2.turnId);
    await tick(40);
  });

  it("flushes pending deltas before dropping a duplicate item/started", async () => {
    const ids = await startHeldTurn("delta-order");
    const payload = startedItem(ids, "msg_stream");
    codex.emitNotification("item/started", payload);
    codex.emitNotification("item/agentMessage/delta", { threadId: ids.threadId, turnId: ids.turnId, itemId: "msg_stream", delta: "PROBE" });
    // The duplicate arrives while PROBE is still buffered: its flush must win
    // before the duplicate is dropped.
    codex.emitNotification("item/started", payload);
    await tick(10);

    const events = agent.listEvents(ids.conversationId, 0);
    expect(events.filter((e) => e.type === "item/started")).toHaveLength(1);
    const startedIdx = events.findIndex((e) => e.type === "item/started");
    const deltaIdx = events.findIndex((e) => e.type === "stream.delta");
    expect(deltaIdx).toBeGreaterThan(startedIdx);
    expect((events[deltaIdx]!.payload as { delta: string }).delta).toBe("PROBE");

    codex.releaseTurn(ids.threadId);
    codex.completeTurn(ids.turnId);
    await tick(40);
  });

  it("deduplicates an identical item/started after a restart (persisted, not in-memory)", async () => {
    const shared = openDb(":memory:");
    const first = makeManager({}, shared);
    await first.agent.init();
    const conv = first.agent.createConversation({ title: "restart" });
    first.codex.holdTurn("thread_1");
    first.agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: `idem-${++seq}` });
    await tick(40);
    const threadId = first.codex.startedThreads[0]!.threadId;
    const turnId = first.codex.startedTurns[0]!.turnId;
    const payload = { threadId, turnId, item: { id: "msg_restart", type: "agentMessage", text: "" } };
    first.codex.emitNotification("item/started", payload);
    await tick(10);
    expect(first.agent.listEvents(conv.id, 0).filter((e) => e.type === "item/started")).toHaveLength(1);
    first.agent.shutdown();

    // Fresh process on the same database: the duplicate must still be recognised.
    const second = makeManager({}, shared);
    await second.agent.init();
    second.codex.emitNotification("item/started", payload);
    await tick(10);
    expect(second.agent.listEvents(conv.id, 0).filter((e) => e.type === "item/started")).toHaveLength(1);
    second.agent.shutdown();
    shared.close();
  });
});
