import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const task = { id: "task-route", revision: 1, title: "查天气", text: "明天天气怎么样", conversationId: "child-route", status: "completed", result: "明天晴。", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 600_000, completedAt: Date.now() - 500_000 };
const old = { ...task, id: "task-old", title: "很久以前的任务", conversationId: "child-old", result: "早就做完了。" };
const path = (page: Page) => new URL(page.url()).pathname;

async function setup(page: Page, session: { username: string; role: string } = { username: "owner", role: "owner" }) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: true, ...session } }));
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null } }));
  await page.route("**/api/schedules", r => r.fulfill({ json: { schedules: [] } }));
  await page.route("**/api/vault", r => r.fulfill({ json: { entries: [] } }));
  await page.route("**/api/tasks/task-old", r => r.fulfill({ json: { task: old } }));
  await page.route("**/api/tasks/task-gone", r => r.fulfill({ status: 404, json: { error: "not_found" } }));
  for (const t of [task, old]) await page.route(`**/api/conversations/${t.conversationId}*`, r => r.fulfill({ json: { conversation: { id: t.conversationId, title: t.title, model: "m", effort: "high", status: "idle", createdAt: 1, updatedAt: 1, archivedAt: null }, turns: [], events: [], lastEventId: 0 } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
}
async function nav(page: Page, name: string, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
}

test("each page of the console has its own address, and back and forward follow it", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await setup(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  expect(path(page)).toBe("/u/owner");
  for (const [name, at, heading] of [["任务列表", "/u/owner/tasks", "任务列表"], ["定时任务", "/u/owner/schedules", "定时任务"], ["密码器", "/u/owner/vault", "密码器"], ["配置", "/u/owner/settings", "配置"], ["主会话", "/u/owner", "主会话"]] as const) {
    await nav(page, name, mobile);
    await expect.poll(() => path(page)).toBe(at);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    if (!mobile) await expect(page.locator(".sidebar").getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.goBack();
  await expect.poll(() => path(page)).toBe("/u/owner/settings");
  await expect(page.getByRole("heading", { name: "配置", exact: true }).first()).toBeVisible();
  await page.goBack();
  await expect.poll(() => path(page)).toBe("/u/owner/vault");
  await expect(page.getByRole("heading", { name: "密码器", exact: true })).toBeVisible();
  await page.goForward();
  await expect.poll(() => path(page)).toBe("/u/owner/settings");

  // The workspace opens at its own address over the page and closing it goes back.
  await nav(page, "工作区", mobile);
  await expect.poll(() => path(page)).toBe("/u/owner/workspace");
  await expect(page.locator(".workspace")).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await expect.poll(() => path(page)).toBe("/u/owner/settings");
  await expect(page.locator(".workspace")).toHaveCount(0);
});

test("an address opens its page directly, after a reload or from a link without the account", async ({ page }) => {
  await setup(page);
  await page.goto("/u/owner/schedules");
  await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
  await page.goto("/vault");
  await expect.poll(() => path(page)).toBe("/u/owner/vault");
  await expect(page.getByRole("heading", { name: "密码器", exact: true })).toBeVisible();
  await page.goto("/u/owner/workspace");
  await expect(page.locator(".workspace")).toBeVisible();
  await page.goto("/u/owner/no-such-page");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
});

test("a task's process has an address: from a card, back to where it was opened, and straight from a link", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: "查看过程" }).click();
  await expect.poll(() => path(page)).toBe("/u/owner/tasks/task-route");
  await expect(page.locator(".task-detail-bar")).toContainText("← 返回主会话");
  await page.getByRole("button", { name: "← 返回主会话" }).click();
  await expect.poll(() => path(page)).toBe("/u/owner");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator(".task-detail-bar")).toBeVisible();

  // A task outside the loaded feed is looked up by its id; one that is gone says so.
  await page.goto("/u/owner/tasks/task-old");
  await expect(page.locator(".task-detail")).toContainText("很久以前的任务");
  await page.getByRole("button", { name: "← 返回主会话" }).click();
  await expect.poll(() => path(page)).toBe("/u/owner");
  await page.goto("/u/owner/tasks/task-gone");
  await expect(page.getByText("没有找到这个任务")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/u/owner");
});

test("an owner page's address leads a member to their main session", async ({ page }) => {
  await setup(page, { username: "yzmy", role: "member" });
  await page.goto("/u/yzmy/settings");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  await expect.poll(() => path(page)).toBe("/u/yzmy");
  await page.goto("/u/yzmy/usage");
  await expect.poll(() => path(page)).toBe("/u/yzmy");
});
