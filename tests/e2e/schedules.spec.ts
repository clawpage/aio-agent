import { test, expect, type Page } from "@playwright/test";
import { mockConsole, mockTaskList } from "./mock-api";

const schedule = (over: Record<string, unknown> = {}) => ({
  id: "sched-1", title: "每日天气提醒", instruction: "查旧金山今天的天气，提醒是否需要带伞", rule: "每天 08:00", status: "active",
  timezone: "America/Los_Angeles", nextRunAt: Date.now() + 3600_000, nextRunText: "10月3日 周六 08:00", lastRunAt: Date.now() - 86400_000,
  lastTask: { id: "task-run", status: "completed" }, runCount: 3, createdAt: Date.now() - 3 * 86400_000, ...over,
});
const run = { id: "task-run", revision: 1, title: "每日天气提醒", text: "查旧金山今天的天气，提醒是否需要带伞", conversationId: "child-run", status: "completed",
  result: "今天晴，不用带伞。", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 600_000, completedAt: Date.now() - 500_000,
  schedule: { id: "sched-1", title: "每日天气提醒", rule: "每天 08:00" } };

async function setup(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [run], nextBefore: null } }));
  await mockTaskList(page, () => [run]);
  let items = [schedule(), schedule({ id: "sched-2", title: "价格监控", rule: "每 2 小时", status: "paused", nextRunText: null, lastTask: null, runCount: 0 }),
    schedule({ id: "sched-feed", title: "每日推送", instruction: "每天看一下 Gmail 有没有要交的账单，少说新闻", builtin: "daily_feed", lastTask: null, runCount: 0,
      feed: { customized: true, memory: [{ id: "fm1", kind: "care", text: "Roy 的疫苗和体检预约", source: "user" }, { id: "fm2", kind: "avoid", text: "加密货币行情", source: "feed" }] } })];
  const actions: string[] = [];
  await page.route("**/api/schedules", (r) => r.fulfill({ json: { schedules: items } }));
  await page.route("**/api/schedules/*/*", (r) => {
    const [, id, action] = /schedules\/([^/]+)\/([^/?]+)/.exec(r.request().url())!;
    actions.push(`${id}:${action}`);
    if (action === "cancel") items = items.filter((s) => s.id !== id);
    else if (action === "pause" || action === "resume") items = items.map((s) => (s.id === id ? { ...s, status: action === "pause" ? "paused" : "active" } : s));
    return r.fulfill({ json: { message: action === "pause" ? "已暂停定时任务「每日天气提醒」。" : action === "resume" ? "已恢复定时任务「价格监控」，下次运行 10月2日 周五 20:00。" : "已取消", schedule: items.find((s) => s.id === id) ?? null } });
  });
  await page.goto("/");
  return { actions };
}

test("a scheduled run shows as an automatic run, not as something you typed", async ({ page }, info) => {
  await setup(page);
  const note = page.locator(".schedule-run-note");
  await expect(note).toContainText("定时任务「每日天气提醒」自动运行 · 每天 08:00", { timeout: 60_000 });
  await expect(page.locator(".msg.user")).toHaveCount(0);
  await expect(page.locator(".schedule-badge")).toHaveText("定时 · 每天 08:00");
  await expect(page.getByText("今天晴，不用带伞。")).toBeVisible();
  await page.screenshot({ path: info.outputPath("schedule-run.png") });
});

test("the schedules page lists rules and pauses, resumes, runs and deletes them", async ({ page }, info) => {
  const { actions } = await setup(page);
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
  const list = page.getByRole("region", { name: "定时任务" });
  const weather = list.locator('[data-schedule-id="sched-1"]');
  await expect(weather).toContainText("每天 08:00 · 下次 10月3日 周六 08:00");
  await expect(weather).toContainText("已运行 3 次");
  await expect(weather.locator(".task-status-badge")).toHaveText("进行中");
  await expect(list.locator('[data-schedule-id="sched-2"] .task-status-badge')).toHaveText("已暂停");
  await expect(list).toContainText("在主会话里直接说就能创建");
  // The built-in daily feed can be paused or run, never deleted.
  const builtin = list.locator('[data-schedule-id="sched-feed"]');
  await expect(builtin).toContainText("内置");
  await expect(builtin).toContainText("前一天发过消息才会推送");
  // The feed shows the person's own instruction and what it keeps in mind, learnt entries marked as such.
  await expect(builtin.locator(".task-list-summary")).toHaveText("你的要求每天看一下 Gmail 有没有要交的账单，少说新闻");
  const memory = builtin.getByRole("list", { name: "推送记住的内容" }).getByRole("listitem");
  await expect(memory).toHaveText(["关心Roy 的疫苗和体检预约", "不再推加密货币行情 · 从你的反馈学到"]);
  await expect(builtin.getByRole("button", { name: "删除" })).toHaveCount(0);
  await expect(builtin.getByRole("button", { name: "暂停" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("schedules.png") });

  await weather.getByRole("button", { name: "暂停" }).click();
  await expect(list.getByRole("status")).toContainText("已暂停定时任务「每日天气提醒」");
  await expect(weather.locator(".task-status-badge")).toHaveText("已暂停");
  await list.locator('[data-schedule-id="sched-2"]').getByRole("button", { name: "恢复" }).click();
  await expect(list.locator('[data-schedule-id="sched-2"] .task-status-badge')).toHaveText("进行中");
  await weather.getByRole("button", { name: "立即运行一次" }).click();
  await expect(list.getByRole("status")).toContainText("已开始运行，结果会出现在主会话");
  await weather.getByRole("button", { name: "删除" }).click();
  await expect(weather).toContainText("删除后不会再运行");
  await weather.getByRole("button", { name: "确认删除" }).click();
  await expect(list.locator('[data-schedule-id="sched-1"]')).toHaveCount(0);
  expect(actions).toEqual(["sched-1:pause", "sched-2:resume", "sched-1:run", "sched-1:cancel"]);
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test("a schedule is edited on the page: several times a day, or a few irregular dates", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await mockTaskList(page, () => []);
  let item: ReturnType<typeof schedule> & { spec?: unknown; needsBrowser?: boolean } = schedule({ spec: { kind: "daily", at: "08:00" }, needsBrowser: true });
  const sent: Array<Record<string, unknown>> = [];
  await page.route("**/api/schedules", (r) => r.fulfill({ json: { schedules: [item] } }));
  await page.route("**/api/schedules/sched-1", (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown> & { schedule: { kind: string; times?: string[]; dates?: string[] } };
    expect(r.request().method()).toBe("PATCH");
    sent.push(body);
    if (body.schedule.kind === "dates" && body.schedule.dates!.some((d) => d.startsWith("2020"))) return r.fulfill({ status: 409, json: { error: "schedule_refused", message: "这些时间都已经过去了" } });
    const rule = body.schedule.kind === "dates" ? "10月8日 09:00、10月15日 14:30（共 2 次）" : `每天 ${body.schedule.times!.join("、")}`;
    item = { ...item, title: body.title as string, instruction: body.instruction as string, rule, spec: body.schedule, needsBrowser: body.needsBrowser as boolean };
    return r.fulfill({ json: { message: `已更新定时任务「${item.title}」：${rule}，下次运行 10月3日 周六 07:30。\n\n每次会做：${item.instruction}`, schedule: item } });
  });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
  const row = page.locator('[data-schedule-id="sched-1"]');
  await row.getByRole("button", { name: "修改" }).click();
  const form = page.getByRole("form", { name: /^修改定时任务：/ });
  await expect(page.getByRole("form", { name: "修改定时任务：每日天气提醒" })).toBeVisible();
  await expect(form.getByLabel("运行规则")).toHaveValue("daily");
  await expect(form.getByLabel("时间（一天多次用逗号隔开）")).toHaveValue("08:00");
  await form.getByLabel("时间（一天多次用逗号隔开）").fill("07:30，18:00");
  await form.getByLabel("名称").fill("天气提醒（早晚）");
  await form.screenshot({ path: info.outputPath("schedule-edit.png") });
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toContainText("已更新定时任务「天气提醒（早晚）」：每天 07:30、18:00");
  expect(sent[0]).toMatchObject({ title: "天气提醒（早晚）", instruction: "查旧金山今天的天气，提醒是否需要带伞", needsBrowser: true, schedule: { kind: "daily", times: ["07:30", "18:00"], maxRuns: null, until: null } });
  await expect(row).toContainText("每天 07:30、18:00");

  // Irregular dates: one a line; a refusal is shown and the form stays open.
  await row.getByRole("button", { name: "修改" }).click();
  await form.getByLabel("运行规则").selectOption("dates");
  await form.getByLabel("运行时间（一行一个）").fill("2020-10-08 09:00");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert")).toContainText("这些时间都已经过去了");
  await expect(form).toBeVisible();
  await form.getByLabel("运行时间（一行一个）").fill("2099-10-08 09:00\n2099-10-15 14:30\n");
  await form.getByLabel("运行时用浏览器查网页").uncheck();
  await form.getByRole("button", { name: "保存" }).click();
  await expect(row).toContainText("10月8日 09:00、10月15日 14:30（共 2 次）");
  expect(sent.at(-1)).toMatchObject({ needsBrowser: false, schedule: { kind: "dates", dates: ["2099-10-08 09:00", "2099-10-15 14:30"] } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
