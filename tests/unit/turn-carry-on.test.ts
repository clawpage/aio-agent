import { afterEach, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

/** A Codex whose app-server outlives the control plane (appServerBridge.ts). */
class BridgedCodex extends FakeCodex {
  reattaches = true;
  constructor(public reattached = false) { super(); }
}

const log = new Logger("error", undefined, false);
let db: Db;
const managers: AgentManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.shutdown(); db?.close(); });

/** A turn running on the first control plane, which then stops; the second one starts on the same data. */
async function restartMidTurn(reattached: boolean, givenUpBefore = false) {
  db = openDb(":memory:");
  const cfg = testConfig("/tmp/aio-carry-on", 1);
  const first = new BridgedCodex();
  const before = new AgentManager({ db, cfg, codex: first, log });
  await before.init();
  const conversation = before.createConversation({ title: "长任务" });
  const { turn } = before.submitTurn({ conversationId: conversation.id, clientMessageId: "m1", text: "整理一下资料" });
  await vi.waitFor(() => expect((db.prepare("SELECT codex_turn_id FROM turns WHERE id=?").get(turn.id) as { codex_turn_id: string | null }).codex_turn_id).toBeTruthy());
  const codexTurnId = first.startedTurns[0]!.turnId, threadId = first.startedTurns[0]!.threadId;
  before.shutdown();
  if (givenUpBefore) {
    // An earlier turn of the same task was given up as unknown while Codex went on with it; the
    // resumed one (this turn) was joined by Codex to that same Codex turn.
    // The given-up one was written first, so it comes first in the table.
    db.exec("CREATE TEMP TABLE live AS SELECT * FROM turns; CREATE TEMP TABLE cut AS SELECT * FROM turns");
    db.prepare("UPDATE cut SET id='turn_given_up', client_message_id='m0', status='unknown', created_at=created_at-1000").run();
    db.exec("PRAGMA foreign_keys=OFF; DELETE FROM turns; INSERT INTO turns SELECT * FROM cut; INSERT INTO turns SELECT * FROM live; DROP TABLE cut; DROP TABLE live; PRAGMA foreign_keys=ON");
  }

  const second = new BridgedCodex(reattached);
  const after = new AgentManager({ db, cfg, codex: second, log });
  managers.push(after);
  await after.init();
  const row = () => db.prepare("SELECT status, error FROM turns WHERE id=?").get(turn.id) as { status: string; error: string | null };
  return { second, after, row, codexTurnId, threadId, turnId: turn.id, conversationId: conversation.id };
}

it("picks up a turn still running in the sandbox after a restart, and records how it ends", async () => {
  const { second, after, row, codexTurnId, threadId, turnId, conversationId } = await restartMidTurn(true);
  expect(row().status).toBe("running");
  expect((await after.status()).activeTurns).toMatchObject([{ turnId, codexTurnId, threadId }]);
  // What it says on joining (its replay) still reaches the turn.
  second.emitNotification("item/completed", { threadId, turnId: codexTurnId, item: { id: "i1", type: "agentMessage", text: "整理好了" } });
  second.emitNotification("turn/completed", { threadId, turn: { id: codexTurnId, status: "completed" } });
  await vi.waitFor(() => expect(row().status).toBe("completed"));
  const events = db.prepare("SELECT type FROM events WHERE turn_id=? ORDER BY id").all(turnId) as Array<{ type: string }>;
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["item/completed", "turn.finished"]));
  expect(events.map((e) => e.type)).not.toContain("turn.reconciled");
  await vi.waitFor(async () => expect((await after.status()).activeTurns).toEqual([]));
  expect((db.prepare("SELECT status FROM conversations WHERE id=?").get(conversationId) as { status: string }).status).toBe("idle");
});

it("ends such a turn unknown, as before, when the app-server did not survive the restart", async () => {
  const { row } = await restartMidTurn(false);
  await vi.waitFor(() => expect(row().status).toBe("unknown"));
  expect(row().error).toContain("The service restarted while this turn was running");
});

it("records what Codex says on a turn that an earlier, given-up turn was also joined to on the live one", async () => {
  const { second, row, codexTurnId, threadId, turnId } = await restartMidTurn(true, true);
  second.emitNotification("item/completed", { threadId, turnId: codexTurnId, item: { id: "i1", type: "agentMessage", text: "整理好了" } });
  second.emitNotification("turn/completed", { threadId, turn: { id: codexTurnId, status: "completed" } });
  await vi.waitFor(() => expect(row().status).toBe("completed"));
  const of = (id: string) => (db.prepare("SELECT type FROM events WHERE turn_id=?").all(id) as Array<{ type: string }>).map((e) => e.type);
  expect(of(turnId)).toContain("item/completed");
  expect(of("turn_given_up")).not.toContain("item/completed");
});
