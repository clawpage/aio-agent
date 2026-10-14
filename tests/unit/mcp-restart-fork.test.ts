import { afterEach, expect, it } from "vitest";
import { Logger } from "../../src/common/logger.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { openDb } from "../../src/control/db.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

it("continues a thread whose gateway tools failed to start on a fork, which starts them again", async () => {
  const codex = new FakeCodex();
  const db = openDb(":memory:");
  const agent = new AgentManager({ cfg: testConfig("/tmp/pa-mcp-fork", 1), db, log: new Logger("error", undefined, false), codex });
  cleanups.push(() => { agent.shutdown(); db.close(); });
  await agent.init();
  const conv = agent.createConversation({ title: "phone" });
  const status = (threadId: string, name: string, s: string) =>
    db.prepare("INSERT INTO events (conversation_id, turn_id, type, payload, created_at) VALUES (?, NULL, 'mcpServer/startupStatus/updated', ?, ?)")
      .run(conv.id, JSON.stringify({ threadId, name, status: s }), Date.now());

  agent.submitTurn({ conversationId: conv.id, text: "one", clientMessageId: "m1" });
  await tick();
  const first = codex.startedTurns[0]!.threadId;
  // The phone's Mac was offline as the thread started; another server of someone else's failing does not count.
  status(first, "aio_kb", "ready");
  status(first, "aio_phone", "starting");
  status(first, "aio_phone", "failed");
  status(first, "playwright", "failed");
  codex.completeTurn(codex.startedTurns[0]!.turnId);
  await tick();

  agent.submitTurn({ conversationId: conv.id, text: "two", clientMessageId: "m2" });
  await tick();
  expect(codex.forkedThreads).toHaveLength(1);
  expect(codex.forkedThreads[0]!.from).toBe(first);
  const forked = codex.forkedThreads[0]!.threadId;
  expect(codex.startedTurns[1]!.threadId).toBe(forked);
  status(forked, "aio_phone", "ready");
  codex.completeTurn(codex.startedTurns[1]!.turnId);
  await tick();

  // Started on the fork: the next turn simply resumes it.
  agent.submitTurn({ conversationId: conv.id, text: "three", clientMessageId: "m3" });
  await tick();
  expect(codex.forkedThreads).toHaveLength(1);
  expect(codex.startedTurns[2]!.threadId).toBe(forked);
});
