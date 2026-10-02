import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { TaskService } from "../../src/control/tasks/service.js";
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

class PlanningCodex extends FakeCodex {
  async planTask(p: string) {
    const message = JSON.parse(p.split("\n").at(-1)!).message as string;
    return JSON.stringify({ title: message, related: [], dependencies: [], resources: [], clarification: message.includes("机票") ? "哪天出发？" : null });
  }
}
const tick = () => new Promise((r) => setTimeout(r, 30));
let db: Db, agent: AgentManager, codex: PlanningCodex, tasks: TaskService;
beforeEach(async () => {
  db = openDb(":memory:");
  codex = new PlanningCodex();
  const cfg = testConfig("/tmp/aio-notifier", 1);
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource });
  await agent.init();
  tasks = new TaskService(db, cfg, agent, codex);
  tasks.init();
});
afterEach(async () => { tasks.close(); for (const t of codex.startedTurns) codex.completeTurn(t.turnId); await tick(); agent.shutdown(); db.close(); });

it("tells the notifier when a task finishes or needs an answer, once each, and finds tasks by conversation", async () => {
  const seen: Array<{ title: string; status: string }> = [];
  tasks.setNotifier((t) => seen.push({ title: t.title, status: t.status }));
  const job = tasks.submit({ text: "查天气", clientMessageId: "m1" }).task;
  await tick();
  expect(seen).toEqual([]); // planning, waiting, running are not news
  expect(tasks.hasRunning()).toBe(true);
  expect(tasks.taskForConversation(job.conversationId)).toEqual({ id: job.id, title: "查天气" });
  codex.completeTurn(codex.startedTurns[0]!.turnId);
  await tick();
  tasks.submit({ text: "帮我订机票", clientMessageId: "m2" });
  await tick();
  expect(seen).toEqual([{ title: "查天气", status: "completed" }, { title: "帮我订机票", status: "needs_input" }]);
  tasks.setNotifier(null);
});
