import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockConsole } from "./mock-api";

const evidence = "/Users/mengxiao/workspace/.scratch/artifacts/daily-quota";

async function openSettings(page: Page, mobile: boolean, role: "member" | "owner", quota: unknown) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: true, username: role, role } }));
  await page.route("**/api/account/quota", r => r.fulfill({ json: quota }));
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  await expect(page.locator(".mobile-menu-backdrop")).toHaveCount(0);
}

test("a member sees only the share of today's tokens used, and when they come back once used up", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await openSettings(page, mobile, "member", { limited: true, percent: 37, resetsAt: Date.now() + 3 * 3600_000 });
  const card = page.getByRole("region", { name: "今日用量" });
  await expect(card).toBeVisible();
  await expect(card.locator("strong")).toHaveText("37%");
  await expect(card.getByRole("progressbar")).toHaveAttribute("value", "37");
  await expect(card).not.toContainText("token");
  await expect(card.getByRole("status")).toHaveCount(0);
  await mkdir(evidence, { recursive: true });
  await card.screenshot({ path: `${evidence}/${info.project.name}-37.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.unroute("**/api/account/quota");
  await page.route("**/api/account/quota", r => r.fulfill({ json: { limited: true, percent: 100, resetsAt: Date.parse("2026-11-06T10:00:00Z") } }));
  await page.reload();
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  await expect(card.locator("strong")).toHaveText("100%");
  await expect(card.getByRole("status")).toContainText("已用完，将于");
  await card.screenshot({ path: `${evidence}/${info.project.name}-100.png` });
});

test("the usage card is there at once; only its figure waits on the answer", async ({ page }, info) => {
  let answer!: () => void;
  const held = new Promise<void>((r) => { answer = r; });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: true, username: "member", role: "member" } }));
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.route("**/api/account/quota", async r => { await held; await r.fulfill({ json: { limited: true, percent: 64, resetsAt: Date.now() + 3600_000 } }); });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  const card = page.getByRole("region", { name: "今日用量" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("status")).toContainText("加载中");
  answer();
  await expect(card.locator("strong")).toHaveText("64%");
  await expect(card.getByRole("status")).toHaveCount(0);
});

test("the owner has no limit and no card", async ({ page }, info) => {
  let asked = false;
  await openSettings(page, info.project.name.startsWith("mobile"), "owner", { limited: false });
  page.on("request", r => { if (r.url().includes("/api/account/quota")) asked = true; });
  await expect(page.getByRole("heading", { name: "配置", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "今日用量" })).toHaveCount(0);
  expect(asked).toBe(false);
});

test("a message sent after the day's tokens ran out is answered with when service comes back", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: true, username: "member", role: "member" } }));
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  const message = "今日免费用量已用完，服务暂停，将于太平洋时间 11月6日 02:00（约 3 小时后）恢复。";
  await page.route("**/api/tasks", r => r.request().method() === "POST" ? r.fulfill({ status: 429, json: { error: "daily_limit", message, resetsAt: 0 } }) : r.fallback());
  await page.goto("/");
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("帮我查一下天气");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(message)).toBeVisible();
});

test("from 90% a member is told above the composer, once per level, and again once it is used up", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: true, username: "member", role: "member" } }));
  let quota = { limited: true, percent: 85, resetsAt: Date.parse("2026-11-06T10:00:00Z") };
  let asked = 0;
  await page.route("**/api/account/quota", r => { asked++; return r.fulfill({ json: quota }); });
  const done = (id: string, at: number) => ({ id, revision: 1, title: "查天气", text: "查天气", conversationId: `c-${id}`, status: "completed", result: "晴", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: at - 1000, completedAt: at });
  let tasks = [done("t1", 1000)];
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", version: `v${tasks.length}`, tasks, nextBefore: null } }));
  await page.goto("/");
  await expect(page.getByText("晴")).toBeVisible();
  const notice = page.locator(".quota-notice");
  await expect(notice).toHaveCount(0);

  // A task finishing spends tokens: the share is asked again, and from 90% the notice shows.
  quota = { ...quota, percent: 92 };
  const before = asked;
  tasks = [...tasks, done("t2", 2000)];
  await expect.poll(() => asked, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(notice).toContainText("今日免费用量已用 92%，将于");
  await expect(notice).not.toContainText("token");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${info.project.name}-notice-92.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await notice.getByRole("button", { name: "知道了" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("晴").first()).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Used up: a new level, so it shows again.
  quota = { ...quota, percent: 100 };
  await page.reload();
  await expect(notice).toContainText("今日免费用量已用完，将于");
});

test("the owner's main session never asks about a limit", async ({ page }) => {
  let asked = false;
  page.on("request", r => { if (r.url().includes("/api/account/quota")) asked = true; });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: true, username: "owner", role: "owner" } }));
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  await expect(page.locator(".quota-notice")).toHaveCount(0);
  expect(asked).toBe(false);
});
