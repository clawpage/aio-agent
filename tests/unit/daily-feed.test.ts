import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { AgentManager } from "../../src/server/codex/manager.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { TaskService } from "../../src/server/tasks/service.js";
import { Logger } from "../../src/server/logger.js";
import { taskNotification } from "../../src/server/push.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

class PlanningCodex extends FakeCodex {
  async planTask(p: string) {
    const message = JSON.parse(p.split("\n").at(-1)!).message as string;
    return JSON.stringify({ title: message, related: [], dependencies: [], resources: [] });
  }
}
const tick = () => new Promise((r) => setTimeout(r, 30));
let db: Db, agent: AgentManager, codex: PlanningCodex, tasks: TaskService;
const cfg = testConfig("/tmp/aio-feed", 1);
const fire = () => (tasks as unknown as { runDueSchedules(): void }).runDueSchedules();
const feed = () => db.prepare("SELECT * FROM schedules WHERE builtin='daily_feed'").get() as { id: string; status: string; run_count: number; next_run_at: number; last_task_id: string | null; resources_json: string };
const due = () => db.prepare("UPDATE schedules SET next_run_at=? WHERE builtin='daily_feed'").run(Date.now() - 1000);
async function start() {
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource });
  await agent.init();
  tasks = new TaskService(db, cfg, agent, codex);
  tasks.init();
}
/** A finished feed run that wrote `text`. */
async function finishFeed(text: string) {
  await codex.runTurn(codex.startedTurns.at(-1)!.turnId, { text });
  await tick();
}

beforeEach(async () => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) VALUES ('owner_1','owner','owner','x','x','{}',0)").run();
  codex = new PlanningCodex();
  await start();
});
afterEach(async () => {
  tasks.close();
  for (const t of codex.startedTurns) codex.completeTurn(t.turnId);
  await tick();
  agent.shutdown();
  db.close();
});

describe("the built-in daily feed", () => {
  it("exists once for every account, at 08:00 with the browser", async () => {
    expect(feed()).toMatchObject({ status: "active", run_count: 0, resources_json: JSON.stringify(["browser"]) });
    tasks.close(); agent.shutdown();
    await start();
    expect((db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE builtin='daily_feed'").get() as { n: number }).n).toBe(1);
    expect(tasks.listSchedules("owner_1")).toMatchObject([{ title: "每日推送", rule: "每天 08:00", builtin: "daily_feed" }]);
  });

  it("stays quiet after a day without messages, and runs after one", async () => {
    due(); fire(); await tick();
    expect(feed()).toMatchObject({ run_count: 0, last_task_id: null });
    expect(feed().next_run_at).toBeGreaterThan(Date.now());
    expect(codex.startedTurns).toHaveLength(0);

    tasks.submit({ text: "帮我看看 Mac Studio 现在多少钱", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    due(); fire(); await tick();
    expect(feed().run_count).toBe(1);
    const prompt = codex.startedTurns.at(-1)!.text;
    expect(prompt).toContain("内置的「每日推送」");
    expect(prompt).toContain("帮我看看 Mac Studio 现在多少钱"); // the person's earlier tasks
    expect(prompt).toContain("连续推过 3 次");
    expect(prompt).toContain("<!--feed-topics:");
  });

  it("counts only what the person sent, not its own runs, and a manual run skips the check", async () => {
    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    await finishFeed("今天没有需要特别提醒的事\n<!--feed-empty-->\n<!--feed-topics: []-->");
    due(); fire(); await tick();
    expect(feed().run_count).toBe(1); // its own run is not a message from the person
  });

  it("records the topics, hides its machine lines, and tells the next run what followed", async () => {
    tasks.submit({ text: "关注一下 Mac Studio 降价", clientMessageId: "m1" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    due(); fire(); await tick();
    const seen: Array<{ title: string } | null> = [];
    tasks.setNotifier((t) => seen.push(taskNotification(t)));
    await finishFeed("今日为你留意\n- Mac Studio 在 Best Buy 降到 $1,799。\n<!--feed-topics: [\"Mac Studio 降价\"]-->");
    const run = tasks.view(tasks.get(feed().last_task_id!)!);
    expect(run.result).toBe("今日为你留意\n- Mac Studio 在 Best Buy 降到 $1,799。");
    expect(seen).toEqual([{ title: "今日为你留意", body: "- Mac Studio 在 Best Buy 降到 $1,799。", tag: "daily-feed" }]);
    expect(db.prepare("SELECT topics_json, empty FROM feed_history").get()).toEqual({ topics_json: JSON.stringify(["Mac Studio 降价"]), empty: 0 });

    tasks.submit({ text: "给 Roy 约下周的疫苗", clientMessageId: "m2" });
    await tick();
    codex.completeTurn(codex.startedTurns.at(-1)!.turnId);
    await tick();
    due(); fire(); await tick();
    const history = codex.startedTurns.at(-1)!.text.split("推送记录 feedHistory（新到旧）：")[1]!;
    expect(JSON.parse(history.trim().split("\n\n")[0]!)).toMatchObject([{ topics: ["Mac Studio 降价"], nothingToday: false, userTasksAfter: ["给 Roy 约下周的疫苗"] }]);
  });

  it("says nothing on the phone when there is nothing today", async () => {
    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    const seen: unknown[] = [];
    tasks.setNotifier((t) => seen.push(t));
    await finishFeed("今天没有需要特别提醒的事\n<!--feed-empty-->");
    expect(seen).toEqual([]);
    expect(db.prepare("SELECT empty FROM feed_history").get()).toEqual({ empty: 1 });
  });

  it("turns off instead of disappearing when the person cancels it", () => {
    const { message, schedule } = tasks.changeSchedule(feed().id, "owner_1", "cancel");
    expect(message).toContain("内置的定时任务，已为你关闭");
    expect(schedule).toMatchObject({ status: "paused", builtin: "daily_feed" });
  });

  it("can be switched off for the whole deployment", async () => {
    tasks.close(); agent.shutdown();
    db.prepare("DELETE FROM schedules").run();
    cfg.agent.dailyFeed = false;
    try { await start(); expect(feed()).toBeUndefined(); } finally { cfg.agent.dailyFeed = true; }
  });
});
