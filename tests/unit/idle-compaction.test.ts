import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { Logger } from "../../src/common/logger.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

const IDLE_MS = 80;
let agent: AgentManager, codex: FakeCodex, db: Db;

beforeEach(async () => {
  codex = new FakeCodex();
  db = openDb(":memory:");
  agent = new AgentManager({ cfg: testConfig("/tmp/pa-compact-test", 1), db, log: new Logger("error", undefined, false), codex, compactIdleMs: IDLE_MS });
  await agent.init();
});
afterEach(() => { agent.shutdown(); db.close(); });

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one turn that leaves `used` of a 258,400-token window in use, then start the quiet wait. */
async function turn(conversationId: string, n: number, used: number): Promise<string> {
  agent.submitTurn({ conversationId, text: `message ${n}`, clientMessageId: `m${n}` });
  await vi.waitFor(() => expect(codex.startedTurns.length).toBe(n));
  const { turnId, threadId } = codex.startedTurns[n - 1]!;
  codex.emitNotification("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { last: { totalTokens: Math.round(used * 258_400) }, total: {}, modelContextWindow: 258_400 } });
  await codex.runTurn(turnId);
  await vi.waitFor(async () => expect((await agent.status()).activeTurns).toHaveLength(0));
  agent.compactWhenIdle(conversationId);
  return threadId;
}

it("compacts a session that stays quiet after a turn left it at least 80% full, not before", async () => {
  const conv = agent.createConversation({ title: "配件" });
  const threadId = await turn(conv.id, 1, 0.85);
  await tick(IDLE_MS / 2);
  expect(codex.compacted).toEqual([]);
  await vi.waitFor(() => expect(codex.compacted).toEqual([threadId]));
  // It resumed the thread first (it may have been unloaded), and nothing else runs it again.
  expect(codex.resumedThreads).toContain(threadId);
  await tick(IDLE_MS * 2);
  expect(codex.compacted).toEqual([threadId]);
});

it("leaves a session alone below 80%, or while the sandbox is down", async () => {
  const conv = agent.createConversation({ title: "配件" });
  await turn(conv.id, 1, 0.79);
  await tick(IDLE_MS * 2);
  expect(codex.compacted).toEqual([]);

  await turn(conv.id, 2, 0.9);
  codex.ready = false;   // a sandbox asleep is not woken just to compact
  await tick(IDLE_MS * 2);
  expect(codex.compacted).toEqual([]);
});

it("waits for quiet: a message inside the window restarts the wait", async () => {
  const conv = agent.createConversation({ title: "配件" });
  await turn(conv.id, 1, 0.85);
  await tick(IDLE_MS / 2);
  // The person speaks again before the session has been quiet long enough.
  agent.submitTurn({ conversationId: conv.id, text: "again", clientMessageId: "m2" });
  await vi.waitFor(() => expect(codex.startedTurns.length).toBe(2));
  await tick(IDLE_MS);
  expect(codex.compacted).toEqual([]);   // still running: the earlier wait was given up
  await codex.runTurn(codex.startedTurns[1]!.turnId);
  await vi.waitFor(async () => expect((await agent.status()).activeTurns).toHaveLength(0));
  agent.compactWhenIdle(conv.id);
  await vi.waitFor(() => expect(codex.compacted).toHaveLength(1));
});

it("holds a message sent during the compaction until the compaction is done", async () => {
  const conv = agent.createConversation({ title: "配件" });
  await turn(conv.id, 1, 0.95);
  let release!: () => void;
  codex.compactGate = new Promise<void>((r) => { release = r; });
  await vi.waitFor(() => expect(codex.compacted).toHaveLength(1));
  expect((await agent.status()).compacting).toBe(1);

  agent.submitTurn({ conversationId: conv.id, text: "during", clientMessageId: "m2" });
  await tick(30);
  expect(codex.startedTurns).toHaveLength(1);   // queued behind the compaction
  release();
  await vi.waitFor(() => expect(codex.startedTurns).toHaveLength(2));
  expect((await agent.status()).compacting).toBe(0);
});

it("an idle compaction ends what the thread is known to still hold in full", async () => {
  const conv = agent.createConversation({ title: "配件" });
  const threadId = await turn(conv.id, 1, 0.85);
  const first = (db.prepare("SELECT id FROM turns WHERE conversation_id = ?").get(conv.id) as { id: string }).id;
  expect([...agent.turnsInThread(conv.id, null)]).toEqual([first]);
  await vi.waitFor(() => expect(codex.compacted).toEqual([threadId]));
  expect([...agent.turnsInThread(conv.id, null)]).toEqual([]);
});
