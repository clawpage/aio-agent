import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { JsonRpcResponseError, JsonRpcTimeoutError } from "../../src/control/codex/jsonrpc.js";
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
let agent: AgentManager, codex: FakeCodex, db: Db;

async function start(stopGraceMs = 60) {
  codex = new FakeCodex();
  db = openDb(":memory:");
  const hostTokens = { status: async () => ({ ok: true, authMethod: "chatgpt", email: null, planType: null, expiresAt: null, error: null }) } as unknown as HostTokenSource;
  agent = new AgentManager({ cfg: testConfig("/tmp/pa-turn-outcomes", 1), db, log: new Logger("error", undefined, false), codex, hostTokens, stopGraceMs });
  await agent.init();
}
const turn = (id: string) => db.prepare("SELECT status, error FROM turns WHERE client_message_id=?").get(id) as { status: string; error: string | null };
afterEach(() => { agent.shutdown(); db.close(); });

describe("turn outcomes are reported honestly (AGENTS.md rules 6 and 7)", () => {
  it("a turn/start that timed out is unknown (Codex may have taken it); a definite rejection is a failure", async () => {
    await start();
    const conv = agent.createConversation({ title: "t" });
    codex.startTurn = async () => { throw new JsonRpcTimeoutError("turn/start", "codex", 60_000); };
    agent.submitTurn({ conversationId: conv.id, text: "a", clientMessageId: "timeout" });
    await tick(80);
    expect(turn("timeout").status).toBe("unknown");
    codex.startTurn = async () => { throw new JsonRpcResponseError("turn/start", -32600, "bad request"); };
    agent.submitTurn({ conversationId: conv.id, text: "b", clientMessageId: "rejected" });
    await tick(80);
    expect(turn("rejected").status).toBe("failed");
  });

  it("a stopped turn that never reports back is released as unknown after the grace period", async () => {
    await start(60);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((t) => agent.createConversation({ title: t }));
    for (const [i, conv] of [a, b, c, d].entries()) agent.submitTurn({ conversationId: conv!.id, text: `m${i}`, clientMessageId: `m${i}` });
    await tick(60);
    expect(codex.startedTurns).toHaveLength(3); // every slot taken, the fourth waits
    expect(await agent.interrupt(a!.id)).toMatchObject({ ok: true, status: "running" });
    await tick(150);
    expect(turn("m0")).toMatchObject({ status: "unknown" });
    expect(turn("m0").error).toContain("停止请求发出后");
    // Its slot went to the waiting turn.
    expect(codex.startedTurns).toHaveLength(4);
  });

  it("a stop that cannot be delivered is recorded, and the turn is still released", async () => {
    await start(60);
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "a", clientMessageId: "lost-stop" });
    await tick(60);
    codex.interrupt = async () => { throw new JsonRpcTimeoutError("turn/interrupt", "codex", 30_000); };
    const result = await agent.interrupt(conv.id);
    expect(result).toMatchObject({ ok: true, status: "running" });
    expect(result.message).toContain("暂未送达");
    expect(agent.listEvents(conv.id, 0).find((e) => e.type === "turn.interrupt_requested")?.payload).toMatchObject({ delivered: false });
    await tick(150);
    expect(turn("lost-stop").status).toBe("unknown");
  });

  it("a stop answered in time keeps its normal outcome", async () => {
    await start(200);
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "a", clientMessageId: "answered" });
    await tick(60);
    await agent.interrupt(conv.id);
    codex.completeTurn(codex.startedTurns[0]!.turnId, "interrupted");
    await tick(300);
    expect(turn("answered").status).toBe("interrupted");
  });

  it("output buffered before another event is stored ahead of it", async () => {
    await start();
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "a", clientMessageId: "ordered" });
    await tick(60);
    const { threadId, turnId } = codex.startedTurns[0]!;
    codex.emitNotification("item/started", { threadId, turnId, item: { id: "i1", type: "agentMessage" } });
    codex.emitNotification("item/agentMessage/delta", { threadId, turnId, itemId: "i1", delta: "先说的话" });
    const local = (db.prepare("SELECT id FROM turns WHERE client_message_id='ordered'").get() as { id: string }).id;
    // A stop request arrives while that text is still buffered (deltas are flushed every 250 ms).
    await agent.interrupt(conv.id);
    const types = agent.listEvents(conv.id, 0).map((e) => e.type);
    expect(types.indexOf("stream.delta")).toBeGreaterThan(-1);
    expect(types.indexOf("stream.delta")).toBeLessThan(types.indexOf("turn.interrupt_requested"));
    expect(local).toBeTruthy();
    codex.completeTurn(turnId, "interrupted");
  });
});
