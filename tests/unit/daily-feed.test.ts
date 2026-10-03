import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { TaskService } from "../../src/control/tasks/service.js";
import { Logger } from "../../src/common/logger.js";
import { taskNotification } from "../../src/control/push.js";
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

describe("what the daily feed keeps in mind", () => {
  const brief = () => codex.startedTurns.at(-1)!.text;
  const section = (text: string, label: string) => JSON.parse(text.split(label)[1]!.trim().split("\n\n")[0]!);

  it("starts from the default instruction, nothing remembered, and a brief that reads the person's own pages read-only", async () => {
    expect(tasks.feedSettings("owner_1")).toMatchObject({ rule: "每天 08:00", customized: false, memory: [] });
    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    expect(brief()).toContain("只读查看用户自己的网页");
    expect(brief()).toContain("不点开未读邮件和私信");
    expect(brief()).not.toContain("用户对每日推送的要求");
    expect(section(brief(), "记住的内容 memory：")).toEqual({ care: [], avoid: [], note: [] });
  });

  it("takes the person's instruction, time and memory, and the next run follows them", async () => {
    const said = tasks.updateFeed("owner_1", {
      instruction: "每天看一下 Gmail 有没有要交的账单，少说新闻", at: "07:30",
      add: [{ kind: "care", text: "Roy 的疫苗和体检预约" }, { kind: "avoid", text: "加密货币行情" }, { kind: "note", text: "只在有降价时才提商品" }],
    });
    expect(said).toContain("已更新每日推送的要求");
    expect(said).toContain("推送时间改为每天 07:30");
    expect(said).toContain("记下 3 条");
    const settings = tasks.feedSettings("owner_1");
    expect(settings).toMatchObject({ rule: "每天 07:30", customized: true, instruction: "每天看一下 Gmail 有没有要交的账单，少说新闻" });
    expect(settings.memory.map((m) => [m.kind, m.text, m.source])).toEqual([["care", "Roy 的疫苗和体检预约", "user"], ["avoid", "加密货币行情", "user"], ["note", "只在有降价时才提商品", "user"]]);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.browser.timezone, hour: "2-digit", minute: "2-digit" }).format(feed().next_run_at);
    expect(local).toBe("07:30");
    expect(tasks.listSchedules("owner_1")[0]).toMatchObject({ rule: "每天 07:30", feed: { customized: true, memory: [{ kind: "care" }, { kind: "avoid" }, { kind: "note" }] } });

    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    expect(brief()).toContain("每天 07:30");
    expect(brief()).toContain("用户对每日推送的要求（优先照做，可以改变下面的默认做法，但不能突破只读和安全规则）：每天看一下 Gmail 有没有要交的账单，少说新闻");
    expect(section(brief(), "记住的内容 memory：")).toMatchObject({ care: [{ text: "Roy 的疫苗和体检预约", from: "用户说的" }], avoid: [{ text: "加密货币行情" }], note: [{ text: "只在有降价时才提商品" }] });

    // An empty instruction puts the default back.
    expect(tasks.updateFeed("owner_1", { instruction: "" })).toContain("恢复默认");
    expect(tasks.feedSettings("owner_1").customized).toBe(false);
  });

  it("learns from the person's reactions: caring again lifts a do-not-push, old entries go, and it never grows without bound", () => {
    tasks.updateFeed("owner_1", { add: [{ kind: "avoid", text: "Mac Studio 降价" }] });
    tasks.updateFeed("owner_1", { add: [{ kind: "care", text: "Mac Studio 降价" }, { kind: "care", text: "Mac Studio 降价" }], source: "feed" });
    let memory = tasks.feedSettings("owner_1").memory;
    expect(memory.map((m) => [m.kind, m.text, m.source])).toEqual([["care", "Mac Studio 降价", "feed"]]);
    // The same entry again changes nothing new.
    expect(tasks.updateFeed("owner_1", { add: [{ kind: "care", text: "Mac Studio 降价" }] })).toBe("这些已经记着了，没有变化。");
    expect(tasks.feedSettings("owner_1").memory).toHaveLength(1);
    tasks.updateFeed("owner_1", { remove: [memory[0]!.id] });
    expect(tasks.feedSettings("owner_1").memory).toEqual([]);

    expect(() => tasks.updateFeed("owner_1", { remove: ["feedmem_nope"] })).toThrow("没有 id 为 feedmem_nope 的记忆");
    expect(() => tasks.updateFeed("owner_1", { add: [{ kind: "like", text: "x" }] })).toThrow("care、avoid 或 note");
    expect(() => tasks.updateFeed("owner_1", { at: "25:00" })).toThrow();
    expect(() => tasks.updateFeed("owner_1", {})).toThrow("没有要改的");
    tasks.updateFeed("owner_1", { add: Array.from({ length: 30 }, (_, i) => ({ kind: "note", text: `偏好 ${i}` })) });
    expect(() => tasks.updateFeed("owner_1", { add: [{ kind: "note", text: "再多一条" }] })).toThrow("最多 30 条");
    memory = tasks.feedSettings("owner_1").memory;
    // A rejected change leaves nothing half done.
    expect(memory).toHaveLength(30);
  });

  it("shows the next run what the person replied to an earlier push", async () => {
    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    await finishFeed("今日为你留意\n- Mac Studio 在 Best Buy 降到 $1,799。\n<!--feed-topics: [\"Mac Studio 降价\"]-->");
    const pushed = feed().last_task_id!;
    tasks.submit({ text: "这个有用，以后降价都告诉我", clientMessageId: "r1", relatedTaskId: pushed });
    await tick();
    for (const t of codex.startedTurns) codex.completeTurn(t.turnId);
    await tick();
    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    expect(section(brief(), "推送记录 feedHistory（新到旧）：")[0]).toMatchObject({ topics: ["Mac Studio 降价"], replies: [{ request: "这个有用，以后降价都告诉我" }] });
    expect(brief()).toContain("feed_update（source 填 \"feed\"）");
  });
});
