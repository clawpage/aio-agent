import { test, expect } from "@playwright/test";
import { mockConsole, mockTaskList } from "./mock-api";
import type { Task } from "../../src/ui/src/types";

const base = { revision: 1, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, result: null, completedAt: null } as const;
const make = (id: string, title: string, status: string, extra: Partial<Task> = {}) => ({ ...base, id, title, text: title, conversationId: `c-${id}`, status, createdAt: Date.now() - 3600_000, ...extra }) as unknown as Task;

test("live and waiting tasks can be stopped from the list, unconfirmed ones archived, finished ones neither", async ({ page }, info) => {
  let tasks = [
    make("t-run", "比较三款扫地机", "running"),
    make("t-ask", "订周末的餐厅", "needs_input", { clarification: "几位用餐？" }),
    make("t-unknown", "申请一个 Google Voice 号码", "unknown", { error: "连接中断，结果需要你核对。", completedAt: Date.now() - 7200_000 }),
    make("t-done", "查天气", "completed", { result: "明天晴。", completedAt: Date.now() - 600_000 }),
  ];
  const calls: string[] = [];
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await mockTaskList(page, () => tasks);
  await page.route(/\/api\/tasks\/[^/]+\/(stop|archive)$/, r => {
    const [, id, action] = /tasks\/([^/]+)\/(stop|archive)$/.exec(r.request().url())!;
    calls.push(`${action}:${id}`);
    tasks = tasks.map(t => t.id === id ? { ...t, status: "interrupted", revision: t.revision + 1, completedAt: Date.now() } : t);
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto("/u/owner/tasks");
  const row = (id: string) => page.locator(`li[data-task-id="${id}"]`);
  await expect(row("t-run")).toBeVisible();
  await expect(row("t-run").getByRole("button", { name: "停止任务：比较三款扫地机" })).toBeVisible();
  await expect(row("t-ask").getByRole("button", { name: "停止任务：订周末的餐厅" })).toBeVisible();
  await expect(row("t-unknown").getByRole("button", { name: "归档任务：申请一个 Google Voice 号码" })).toBeVisible();
  await expect(row("t-done").locator(".task-list-end-action")).toHaveCount(0);
  // The button sits over the row without covering its text.
  const stopBox = (await row("t-run").getByRole("button", { name: /^停止任务/ }).boundingBox())!, rowBox = (await row("t-run").boundingBox())!;
  expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("task-list-end.png") });

  // One tap asks, the second stops; cancelling asks nothing.
  await row("t-run").getByRole("button", { name: /^停止任务/ }).click();
  await row("t-run").getByRole("button", { name: "取消" }).click();
  expect(calls).toEqual([]);
  await row("t-run").getByRole("button", { name: /^停止任务/ }).click();
  await row("t-run").getByRole("button", { name: "确认停止" }).click();
  await expect(row("t-run").locator(".task-status-badge")).toHaveText("已停止");
  await expect(row("t-run").locator(".task-list-end-action")).toHaveCount(0);
  // Opening the row still opens the task: the stop button is not part of it.
  await row("t-unknown").getByRole("button", { name: /^归档任务/ }).click();
  await row("t-unknown").getByRole("button", { name: "确认归档" }).click();
  await expect(row("t-unknown").locator(".task-status-badge")).toHaveText("已停止");
  expect(calls).toEqual(["stop:t-run", "archive:t-unknown"]);
  await expect(page.getByRole("button", { name: /轮到你/ }).locator(".task-filter-count")).toHaveText("1");
});
