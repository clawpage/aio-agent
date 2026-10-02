import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

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
  let items = [schedule(), schedule({ id: "sched-2", title: "价格监控", rule: "每 2 小时", status: "paused", nextRunText: null, lastTask: null, runCount: 0 })];
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
