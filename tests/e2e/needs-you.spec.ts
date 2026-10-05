import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const base = { revision: 1, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0 };
const done = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `done-${i}`, title: `已完成任务 ${i + 1}`, text: `请求 ${i + 1}`, conversationId: `c-done-${i}`, status: "completed", result: `结果 ${i + 1}。\n\n` + "说明文字。".repeat(40), createdAt: 2000 + i * 10, completedAt: 2005 + i * 10 }));
const asking = { ...base, id: "ask-1", title: "订周末的餐厅", text: "帮我订周六晚上的餐厅", conversationId: "c-ask", status: "needs_input", result: null, clarification: "几位用餐？", options: ["2 位", "4 位"], createdAt: 1000, completedAt: null };
const approving = { ...base, id: "approve-1", title: "删除旧照片", text: "清理去年的照片", conversationId: "c-approve", status: "running", result: null, approvals: 1, createdAt: 2045, completedAt: null };

async function open(page: Page, tasks: unknown[]) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks, nextBefore: null } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByText("结果 8。")).toBeVisible();
}

test("tasks waiting for you off screen show as amber bubbles above the input, each leading to its card", async ({ page }, info) => {
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 390, height: 844 });
  await open(page, [asking, approving, ...done]);
  const bubbles = page.getByRole("group", { name: "等你处理的任务" }).getByRole("button");
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.nth(0)).toContainText("等你补充");
  await expect(bubbles.nth(0)).toContainText("订周末的餐厅");
  await expect(bubbles.nth(1)).toContainText("等你确认");
  await expect(bubbles.nth(1)).toContainText("删除旧照片");
  // Amber, just above the composer.
  const bubble = (await bubbles.nth(0).boundingBox())!, composer = (await page.locator(".composer").boundingBox())!;
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(composer.y);
  expect(composer.y - (bubble.y + bubble.height)).toBeLessThan(40);
  const colors = await bubbles.nth(0).evaluate(n => [getComputedStyle(n).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue("--you").trim()]);
  expect(colors[0]).not.toBe("rgba(0, 0, 0, 0)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("needs-you.png") });
  // A tap scrolls to that card and marks it; its bubble goes once the card is on screen.
  await bubbles.nth(0).click();
  const card = page.locator('[data-progress-for="ask-1"]');
  await expect(card).toBeInViewport({ ratio: 0.6 });
  await expect(card).toHaveClass(/attention/);
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.nth(0)).toContainText("删除旧照片");
  await page.screenshot({ path: info.outputPath("needs-you-scrolled.png") });
});

test("no bubble when nothing waits for you, or the waiting card is already on screen", async ({ page }) => {
  await open(page, done);
  await expect(page.getByRole("group", { name: "等你处理的任务" })).toHaveCount(0);
  const latest = { ...asking, createdAt: 9000 };
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [...done, latest], nextBefore: null } }));
  await expect(page.locator('[data-progress-for="ask-1"]')).toBeInViewport({ timeout: 10_000 });
  await expect(page.getByRole("group", { name: "等你处理的任务" })).toHaveCount(0);
});
