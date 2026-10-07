import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const long = "这一段写得比较长，好让主会话需要滚动。".repeat(30);
const task = (i: number, extra: Record<string, unknown> = {}) => ({ id: `task-${i}`, revision: 1, title: `任务 ${i}`, text: `第 ${i} 件事`, conversationId: `child-${i}`, status: "completed", result: `第 ${i} 件办完了。\n\n${long}`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + i * 1000, completedAt: 1500 + i * 1000, ...extra });

async function setup(page: Page, live: Array<Record<string, unknown>>) {
  await mockConsole(page, { conversations: [] });
  // The live tasks come first: far above the latest messages, out of view.
  const tasks = [...live.map((extra, k) => task(1 + k, { status: "running", result: null, completedAt: null, ...extra })), ...Array.from({ length: 8 }, (_, k) => task(10 + k))];
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v1", tasks, nextBefore: null } }));
  await page.goto("/");
  await expect(page.locator('.task-entry[data-task-id="task-17"]')).toBeAttached({ timeout: 60_000 });
}
const inView = (page: Page, id: string) => page.locator(`[data-progress-for="${id}"]`).evaluate((el) => {
  const feed = el.closest(".task-feed")!.getBoundingClientRect(), box = el.getBoundingClientRect();
  return box.top >= feed.top - 1 && box.bottom <= feed.bottom + 1;
});

test("one task in progress: tapping the pill scrolls to its card", async ({ page }) => {
  await setup(page, [{ title: "比较三款扫地机" }]);
  await expect.poll(() => inView(page, "task-1")).toBe(false);
  const pill = page.getByRole("button", { name: "1 件在办" });
  await expect(pill).not.toHaveAttribute("aria-haspopup");
  await pill.click();
  await expect.poll(() => inView(page, "task-1")).toBe(true);
  await expect(page.getByRole("menu")).toBeHidden();
});

test("several: the pill opens a small list; picking one scrolls to it and closes the list", async ({ page }, info) => {
  await setup(page, [{ title: "比较三款扫地机" }, { title: "订周末的餐厅", status: "queued" }, { title: "查 Amazon 订单", status: "needs_input", clarification: "要哪个地址？" }]);
  await expect(page.getByRole("button", { name: "1 件等你补充" })).toBeVisible();
  const pill = page.getByRole("button", { name: "2 件在办" });
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  const menu = page.getByRole("menu", { name: "2 件在办" });
  await expect(menu).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText([/比较三款扫地机.*在办/, /订周末的餐厅.*排队中/]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect.poll(() => menu.evaluate((n) => getComputedStyle(n).opacity)).toBe("1");
  await page.screenshot({ path: info.outputPath("turn-menu.png") });

  await menu.getByRole("menuitem", { name: /订周末的餐厅/ }).click();
  await expect(menu).toBeHidden();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => inView(page, "task-2")).toBe(true);

  // A tap elsewhere or Escape closes it without going anywhere.
  await pill.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await pill.click();
  await expect(menu).toBeVisible();
  await page.locator(".task-feed").click({ position: { x: 5, y: 5 } });
  await expect(menu).toBeHidden();
});
