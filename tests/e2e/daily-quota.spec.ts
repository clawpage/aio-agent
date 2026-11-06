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
