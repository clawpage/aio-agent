import { afterEach, expect, it } from "vitest";
import { Logger } from "../../src/common/logger.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { openDb } from "../../src/control/db.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

it("restarts Codex for a newly linked device's tools only once no turn runs on it", async () => {
  const codex = new FakeCodex();
  let restarts = 0, busy = false;
  Object.assign(codex, { restartIdle: () => { if (busy) return false; restarts += 1; return true; } });
  const db = openDb(":memory:");
  const agent = new AgentManager({ cfg: testConfig("/tmp/pa-tools-reload", 2), db, log: new Logger("error", undefined, false), codex });
  cleanups.push(() => { agent.shutdown(); db.close(); });
  await agent.init();

  // Nothing runs: at once.
  agent.reloadTools();
  expect(restarts).toBe(1);

  // A turn runs: it is left alone, and the restart follows when it ends.
  const conv = agent.createConversation({ title: "photos" });
  agent.submitTurn({ conversationId: conv.id, text: "one", clientMessageId: "m1" });
  await tick();
  agent.reloadTools();
  expect(restarts).toBe(1);
  codex.completeTurn(codex.startedTurns[0]!.turnId);
  await tick();
  expect(restarts).toBe(2);

  // A dispatcher thread holds it: the next turn to start alone restarts it first.
  busy = true;
  agent.reloadTools();
  busy = false;
  expect(restarts).toBe(2);
  agent.submitTurn({ conversationId: conv.id, text: "two", clientMessageId: "m2" });
  await tick();
  expect(restarts).toBe(3);
  codex.completeTurn(codex.startedTurns[1]!.turnId);
  await tick();
  expect(restarts).toBe(3);
});
