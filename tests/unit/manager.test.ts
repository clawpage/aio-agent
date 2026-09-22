import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { Logger } from "../../src/server/logger.js";
import { AgentManager, TurnConflictError, buildApprovalResponse, parseAttachments } from "../../src/server/codex/manager.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";

function makeManager(): { agent: AgentManager; codex: FakeCodex; db: Db } {
  const db = openDb(":memory:");
  const codex = new FakeCodex();
  const cfg = testConfig("/tmp/pa-manager-test", 1);
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
