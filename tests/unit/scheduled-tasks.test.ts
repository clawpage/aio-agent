import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { TaskService } from "../../src/control/tasks/service.js";
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

class PlanningCodex extends FakeCodex {
  prompts: string[] = [];
  plan: (data: { message: string; existingSchedules?: Array<{ id: string }> }) => object = (data) => ({ title: data.message, related: [], dependencies: [], resources: [] });
  async planTask(p: string) {
    this.prompts.push(p);
    return JSON.stringify(this.plan(JSON.parse(p.split("\n").at(-1)!)));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));
let db: Db, agent: AgentManager, codex: PlanningCodex, tasks: TaskService;
const submit = (text: string) => tasks.submit({ text, clientMessageId: text }).task;
const fire = () => (tasks as unknown as { runDueSchedules(): void }).runDueSchedules();
const schedules = () => db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Array<Record<string, unknown> & { id: string; status: string; next_run_at: number | null; run_count: number; last_task_id: string | null }>;
const due = (id: string) => db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(Date.now() - 1000, id);
const daily = { kind: "daily", at: "08:00", instruction: "查旧金山今天的天气，提醒是否带伞" };

beforeEach(async () => {
  db = openDb(":memory:");
  codex = new PlanningCodex();
  const cfg = testConfig("/tmp/aio-scheduled", 1);
  cfg.browser.timezone = "America/Los_Angeles";
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource });
  await agent.init();
  tasks = new TaskService(db, cfg, agent, codex);
  tasks.init();
});
afterEach(async () => {
  tasks.close();
  for (const t of codex.startedTurns) codex.completeTurn(t.turnId);
  await tick();
  agent.shutdown();
  db.close();
});

describe("creating a schedule from the main session", () => {
  it("answers with the rule and next run, without starting an executor", async () => {
    codex.plan = () => ({ title: "每日天气提醒", related: [], dependencies: [], resources: [], schedule: daily });
    const job = submit("每天早上8点帮我查天气，提醒我要不要带伞");
    await tick();
    const row = tasks.view(tasks.get(job.id)!);
    expect(row.status).toBe("completed");
    expect(row.result).toContain("已创建定时任务「每日天气提醒」：每天 08:00");
    expect(row.result).toContain("每次会做：查旧金山今天的天气");
    expect(codex.startedTurns).toHaveLength(0);
    const [s] = schedules();
    expect(s).toMatchObject({ title: "每日天气提醒", status: "active", run_count: 0, source_task_id: job.id, timezone: "America/Los_Angeles" });
    expect(s!.next_run_at).toBeGreaterThan(Date.now());
    // The dispatcher was told the time and zone to resolve "明早" against.
    const payload = JSON.parse(codex.prompts[0]!.split("\n").at(-1)!);
    expect(payload.now).toMatch(/^\d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}$/);
    expect(payload.timezone).toBe("America/Los_Angeles");
  });

  it("asks the dispatcher again when its schedule cannot be used", async () => {
    let n = 0;
    codex.plan = () => (++n === 1
      ? { title: "提醒", related: [], dependencies: [], resources: [], schedule: { kind: "daily", at: "8点", instruction: "x" } }
      : { title: "提醒", related: [], dependencies: [], resources: [], schedule: { ...daily } });
    submit("每天8点提醒我");
    await tick();
    expect(codex.prompts[1]).toContain("schedule.at 须是 HH:MM");
    expect(schedules()).toHaveLength(1);
  });

  it("runs now too when asked, and says so at the start", async () => {
    codex.plan = () => ({ title: "价格监控", related: [], dependencies: [], resources: ["browser"], schedule: { kind: "interval", everyMinutes: 120, instruction: "查一下价格", runNow: true } });
    const job = submit("现在查一下价格，之后每2小时看一次");
    await tick();
    expect(codex.startedTurns).toHaveLength(1);
    expect(tasks.view(tasks.get(job.id)!).description).toContain("已创建定时任务（每 2 小时");
    expect(schedules()[0]).toMatchObject({ status: "active", resources_json: JSON.stringify(["browser"]) });
  });

  it("caps active schedules per account", async () => {
    codex.plan = (data) => ({ title: data.message, related: [], dependencies: [], resources: [], schedule: daily });
    for (let i = 0; i < 21; i++) submit(`提醒 ${i}`);
    await new Promise((r) => setTimeout(r, 400));
    expect(schedules().filter((s) => s.status === "active")).toHaveLength(20);
    expect(db.prepare("SELECT result FROM tasks ORDER BY created_at DESC LIMIT 1").get()).toMatchObject({ result: expect.stringContaining("上限 20 个") });
  });
});

describe("running schedules", () => {
  beforeEach(async () => {
    codex.plan = () => ({ title: "每日天气提醒", related: [], dependencies: [], resources: [], schedule: daily });
    submit("每天8点查天气");
    await tick();
  });

  it("starts a due run as an already-planned task, tells the executor nobody is watching, and moves on", async () => {
    const [s] = schedules();
    due(s!.id);
    const plansBefore = codex.prompts.length;
    fire();
    await tick();
    expect(codex.prompts.length).toBe(plansBefore); // no dispatcher round
    const after = schedules()[0]!;
    expect(after).toMatchObject({ run_count: 1, status: "active" });
    expect(after.next_run_at).toBeGreaterThan(Date.now());
    const run = tasks.view(tasks.get(after.last_task_id!)!);
    expect(run).toMatchObject({ title: "每日天气提醒", text: daily.instruction, schedule: { id: s!.id, rule: "每天 08:00" } });
    const turn = codex.startedTurns.at(-1)!;
    expect(turn.text).toContain("第 1 次自动运行");
    expect(turn.text).toContain("不要提问后等待");
  });

  it("does not stack runs while the previous one is still going, and gives the next run the previous result", async () => {
    const id = schedules()[0]!.id;
    due(id); fire(); await tick();
    const first = schedules()[0]!.last_task_id!;
    due(id); fire(); await tick();
    expect(schedules()[0]).toMatchObject({ run_count: 1, last_task_id: first });
    codex.completeTurn(codex.startedTurns.at(-1)!.turnId);
    await tick();
    due(id); fire(); await tick();
    const second = schedules()[0]!;
    expect(second.run_count).toBe(2);
    expect(codex.startedTurns.at(-1)!.text).toContain("第 2 次自动运行");
    expect(codex.startedTurns.at(-1)!.text).toContain("上一次运行的结果");
    expect(JSON.parse((tasks.get(second.last_task_id!)!).plan_json!).related).toEqual([first]);
  });

  it("finishes a one-off after its run and a counted rule after its last", async () => {
    db.prepare("UPDATE schedules SET spec_json=? WHERE id=?").run(JSON.stringify({ kind: "once", at: "08:00", date: "2026-01-01" }), schedules()[0]!.id);
    due(schedules()[0]!.id); fire(); await tick();
    expect(schedules()[0]).toMatchObject({ status: "done", next_run_at: null, run_count: 1 });
  });

  it("pauses, resumes and cancels by asking, and from the schedules page", async () => {
    const id = schedules()[0]!.id;
    codex.plan = (data) => ({ title: "暂停天气", related: [], dependencies: [], resources: [], scheduleAction: { id: data.existingSchedules![0]!.id, action: "pause" } });
    const pause = submit("先暂停天气提醒");
    await tick();
    expect(tasks.get(pause.id)).toMatchObject({ status: "completed", result: expect.stringContaining("已暂停定时任务「每日天气提醒」") });
    expect(schedules()[0]!.status).toBe("paused");
    due(id); fire(); await tick();
    expect(schedules()[0]!.run_count).toBe(0); // paused schedules do not run

    expect(tasks.changeSchedule(id, "owner_1", "resume").schedule).toMatchObject({ status: "active", nextRunText: expect.stringMatching(/周. 08:00$/) });
    expect(() => tasks.changeSchedule(id, "someone_else", "pause")).toThrow("定时任务不存在");
    expect(tasks.changeSchedule(id, "owner_1", "cancel")).toMatchObject({ schedule: null, message: expect.stringContaining("已取消") });
    expect(schedules()).toHaveLength(0);
  });

  it("runs once on demand without changing the regular time", async () => {
    const before = schedules()[0]!;
    const { task, schedule } = tasks.runScheduleNow(before.id, "owner_1");
    expect(task.schedule).toMatchObject({ id: before.id });
    expect(schedule).toMatchObject({ runCount: 1, nextRunAt: before.next_run_at });
    expect(() => tasks.runScheduleNow(before.id, "owner_1")).toThrow("上一次运行还没结束");
    expect(tasks.listSchedules("owner_1")).toMatchObject([{ title: "每日天气提醒", rule: "每天 08:00", status: "active", lastTask: { id: task.id } }]);
    expect(tasks.listSchedules("someone_else")).toEqual([]);
  });
});
