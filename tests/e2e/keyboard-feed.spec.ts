import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `kb-${i}`, revision: 1, title: `任务 ${i + 1}`, text: `第 ${i + 1} 个请求`, conversationId: `kb-child-${i}`, status: "completed", result: `第 ${i + 1} 个结果。\n\n` + "说明文字。".repeat(30), error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + i * 10, completedAt: 1005 + i * 10 }));

const gap = (page: Page) => page.locator(".task-feed").evaluate(n => Math.round(n.scrollHeight - n.scrollTop - n.clientHeight));
/** Lets the feed's resize observer catch up, as it does between a keyboard animation and the next touch. */
const settle = (page: Page) => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const keyboard = (page: Page, height: number | null) => page.evaluate(h => {
  const vv = window.visualViewport!;
  if (h === null) delete (vv as unknown as Record<string, unknown>).height;
  else Object.defineProperty(vv, "height", { configurable: true, value: h });
  vv.dispatchEvent(new Event("resize"));
}, height);

test("the main feed stays at its latest message while a phone keyboard opens and closes", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"));
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks, nextBefore: null } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.addStyleTag({ content: ":root { --safe-top:62px; --safe-bottom:34px; }" });
  await expect(page.getByText("第 12 个结果。")).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.focus();
  await keyboard(page, 420);
  await expect.poll(() => page.locator(".app").evaluate(n => n.clientHeight)).toBe(420);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await input.evaluate(n => (n as HTMLElement).blur());
  await keyboard(page, null);
  await expect.poll(() => page.locator(".app").evaluate(n => n.clientHeight)).toBe(844);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  // Reading older messages is left alone: the bottom edge of what was visible stays in view.
  await settle(page);
  await page.locator(".task-feed").evaluate(n => { n.scrollTop = n.scrollHeight / 3; n.dispatchEvent(new Event("scroll")); });
  const before = await page.locator(".task-feed").evaluate(n => n.scrollTop + n.clientHeight);
  await input.focus();
  await keyboard(page, 420);
  await expect.poll(() => page.locator(".app").evaluate(n => n.clientHeight)).toBe(420);
  await expect.poll(async () => Math.abs(await page.locator(".task-feed").evaluate(n => n.scrollTop + n.clientHeight) - before)).toBeLessThanOrEqual(2);
  await input.evaluate(n => (n as HTMLElement).blur());
  await keyboard(page, null);
  await expect.poll(async () => Math.abs(await page.locator(".task-feed").evaluate(n => n.scrollTop + n.clientHeight) - before)).toBeLessThanOrEqual(2);
});

test("a back-to-latest button rises in only while the feed is read more than a screen above the latest message", async ({ page }, info) => {
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 390, height: 844 });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks, nextBefore: null } }));
  await page.goto("/");
  await expect(page.getByText("第 12 个结果。")).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  const button = page.locator(".feed-latest");
  await expect(button).not.toHaveClass(/show/);
  await expect(button).toHaveAttribute("aria-hidden", "true");
  // Slightly above the bottom is still "at the latest message".
  await page.locator(".task-feed").evaluate(n => { n.scrollTop = n.scrollHeight - n.clientHeight * 1.5; });
  await expect(button).not.toHaveClass(/show/);
  await page.locator(".task-feed").evaluate(n => { n.scrollTop = 0; });
  await expect(button).toHaveClass(/show/);
  await expect.poll(() => button.evaluate(n => getComputedStyle(n).opacity)).toBe("1");
  const box = (await button.boundingBox())!, feed = (await page.locator(".task-feed").boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(feed.x + feed.width - 80);
  expect(box.y + box.height).toBeLessThanOrEqual(feed.y + feed.height);
  await page.screenshot({ path: info.outputPath("feed-latest.png") });
  await page.getByRole("button", { name: "回到最新消息" }).click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await expect(button).not.toHaveClass(/show/);
});
