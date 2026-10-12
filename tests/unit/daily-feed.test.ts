import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { feedTimeFor, TaskService } from "../../src/control/tasks/service.js";
import { Logger } from "../../src/common/logger.js";
import { taskNotification } from "../../src/control/push.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

class PlanningCodex extends FakeCodex {
  async planTask(p: string) {
    const message = JSON.parse(p.split("\n").findLast(l => l.startsWith("{"))!).message as string;
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
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false) });
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
    expect(prompt).toContain("This is the built-in daily feed");
    expect(prompt).toContain("帮我看看 Mac Studio 现在多少钱"); // the person's earlier tasks
    expect(prompt).toContain("pushed 3 times in a row");
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
    const history = codex.startedTurns.at(-1)!.text.split("Feed history feedHistory (newest first):")[1]!;
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

  it("runs at the account's own minutes, so accounts do not all start at 08:00", async () => {
    expect([0, 1, 2, 15].map(feedTimeFor)).toEqual(["08:00", "08:04", "08:08", "09:00"]);
    tasks.close(); agent.shutdown();
    db.prepare("DELETE FROM schedules").run();
    cfg.agent.dailyFeedAt = "08:08";
    try {
      await start();
      expect(tasks.listSchedules("owner_1")).toMatchObject([{ rule: "每天 08:08", builtin: "daily_feed" }]);
      expect(new Date(feed().next_run_at).getUTCMinutes()).toBe(8);
    } finally { delete cfg.agent.dailyFeedAt; }
  });

  it("moves a feed still on 08:00 to the account's minutes, same day; a time the person chose stays", async () => {
    const before = feed().next_run_at;
    tasks.close(); agent.shutdown();
    cfg.agent.dailyFeedAt = "08:12";
    try {
      await start();
      expect(tasks.listSchedules("owner_1")).toMatchObject([{ rule: "每天 08:12" }]);
      // Not recomputed from now: a feed already run today is not run again later today.
      expect(feed().next_run_at - before).toBe(12 * 60_000);
      tasks.close(); agent.shutdown();
      db.prepare("UPDATE schedules SET spec_json=? WHERE builtin='daily_feed'").run(JSON.stringify({ kind: "daily", at: "07:30" }));
      cfg.agent.dailyFeedAt = "08:04";
      await start();
      expect(tasks.listSchedules("owner_1")).toMatchObject([{ rule: "每天 07:30" }]);
    } finally { delete cfg.agent.dailyFeedAt; }
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
    expect(brief()).toContain("Read-only look at the user's own pages");
    expect(brief()).toContain("Do not open unread email or direct messages");
    expect(brief()).not.toContain("用户对每日推送的要求");
    expect(section(brief(), "Remembered memory:")).toEqual({ care: [], avoid: [], note: [] });
  });

  it("reads a week of the person's tasks, the newest in detail and older ones by title, and asks it to check what they are shopping for", async () => {
    tasks.submit({ text: "seed", clientMessageId: "seed" });
    await tick();
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    const day = 86_400_000, now = Date.now();
    const insert = db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,attachments_json,created_at,status) VALUES (?,?,?,?,?,'[]',?,'completed')");
    const copy = (id: string, title: string, input: string, at: number) => insert.run(id, id, agent.createConversation({ ownerId: "owner_1", title }).id, title, input, at);
    copy("task_old", "八天前的事", "八天前的请求", now - 8 * day);
    copy("task_ring", "复查卡地亚项链折扣", "卡地亚项链的请求", now - 3 * day);
    copy("task_ring2", "复查卡地亚项链折扣", "卡地亚项链的请求", now - 3 * day + 1000);
    for (let i = 0; i < 70; i++) copy(`task_n${i}`, `今天的第 ${i} 件`, `今天的请求 ${i}`, now - day + i * 1000);
    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    const records = section(brief(), "The user's task records for the last 7 days (newest first; the newest 60 carry request and result summaries, older ones only the date and title, with only the latest of identical titles):") as Array<{ title: string; request?: string }>;
    expect(records.filter((t) => t.request)).toHaveLength(60);
    // Older than the newest 60 yet within the week: there by title, once.
    expect(records.filter((t) => t.title === "复查卡地亚项链折扣")).toEqual([{ date: expect.any(String), title: "复查卡地亚项链折扣" }]);
    expect(records.some((t) => t.title === "八天前的事")).toBe(false);
    expect(brief()).toContain("3–8 things");
    expect(brief()).toContain("Email and order tracking are only one part");
    expect(brief()).toContain('is not bound by the rules above to "match the effort to what the request actually needs" and "keep the commentary short"');
  });

  it("takes the person's instruction, time and memory, and the next run follows them", async () => {
    const said = tasks.updateFeed("owner_1", {
      instruction: "每天看一下 Gmail 有没有要交的账单，少说新闻", at: "07:30",
      add: [{ kind: "care", text: "Roy 的疫苗和体检预约" }, { kind: "avoid", text: "加密货币行情" }, { kind: "note", text: "只在有降价时才提商品" }],
    });
    expect(said).toContain("Updated the daily feed's instruction");
    expect(said).toContain("Feed time changed to 每天 07:30");
    expect(said).toContain("Remembered 3");
    const settings = tasks.feedSettings("owner_1");
    expect(settings).toMatchObject({ rule: "每天 07:30", customized: true, instruction: "每天看一下 Gmail 有没有要交的账单，少说新闻" });
    expect(settings.memory.map((m) => [m.kind, m.text, m.source])).toEqual([["care", "Roy 的疫苗和体检预约", "user"], ["avoid", "加密货币行情", "user"], ["note", "只在有降价时才提商品", "user"]]);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.browser.timezone, hour: "2-digit", minute: "2-digit" }).format(feed().next_run_at);
    expect(local).toBe("07:30");
    expect(tasks.listSchedules("owner_1")[0]).toMatchObject({ rule: "每天 07:30", feed: { customized: true, memory: [{ kind: "care" }, { kind: "avoid" }, { kind: "note" }] } });

    tasks.runScheduleNow(feed().id, "owner_1");
    await tick();
    expect(brief()).toContain("每天 07:30");
    expect(brief()).toContain("The user's instruction for the daily feed (follow it first; it may change the default approach below, but never the read-only and safety rules): 每天看一下 Gmail 有没有要交的账单，少说新闻");
    expect(section(brief(), "Remembered memory:")).toMatchObject({ care: [{ text: "Roy 的疫苗和体检预约", from: "said by the user" }], avoid: [{ text: "加密货币行情" }], note: [{ text: "只在有降价时才提商品" }] });

    // An empty instruction puts the default back.
    expect(tasks.updateFeed("owner_1", { instruction: "" })).toContain("Restored the daily feed's default instruction");
    expect(tasks.feedSettings("owner_1").customized).toBe(false);
  });

  it("learns from the person's reactions: caring again lifts a do-not-push, old entries go, and it never grows without bound", () => {
    tasks.updateFeed("owner_1", { add: [{ kind: "avoid", text: "Mac Studio 降价" }] });
    tasks.updateFeed("owner_1", { add: [{ kind: "care", text: "Mac Studio 降价" }, { kind: "care", text: "Mac Studio 降价" }], source: "feed" });
    let memory = tasks.feedSettings("owner_1").memory;
    expect(memory.map((m) => [m.kind, m.text, m.source])).toEqual([["care", "Mac Studio 降价", "feed"]]);
    // The same entry again changes nothing new.
    expect(tasks.updateFeed("owner_1", { add: [{ kind: "care", text: "Mac Studio 降价" }] })).toBe("These are already remembered; nothing changed.");
    expect(tasks.feedSettings("owner_1").memory).toHaveLength(1);
    tasks.updateFeed("owner_1", { remove: [memory[0]!.id] });
    expect(tasks.feedSettings("owner_1").memory).toEqual([]);

    expect(() => tasks.updateFeed("owner_1", { remove: ["feedmem_nope"] })).toThrow("No memory with id feedmem_nope");
    expect(() => tasks.updateFeed("owner_1", { add: [{ kind: "like", text: "x" }] })).toThrow("care, avoid or note");
    expect(() => tasks.updateFeed("owner_1", { at: "25:00" })).toThrow();
    expect(() => tasks.updateFeed("owner_1", {})).toThrow("Nothing to change");
    tasks.updateFeed("owner_1", { add: Array.from({ length: 30 }, (_, i) => ({ kind: "note", text: `偏好 ${i}` })) });
    expect(() => tasks.updateFeed("owner_1", { add: [{ kind: "note", text: "再多一条" }] })).toThrow("holds at most 30 entries");
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
    expect(section(brief(), "Feed history feedHistory (newest first):")[0]).toMatchObject({ topics: ["Mac Studio 降价"], replies: [{ request: "这个有用，以后降价都告诉我" }] });
    expect(brief()).toContain("feed_update (source set to \"feed\")");
  });
});
