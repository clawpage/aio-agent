import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// The iOS app keeps its web view the full height and tells the page the keyboard's height on every
// frame of its animation (`aio-keyboard`, DeviceBrowser.swift). The bridge is played here: the page
// must give up exactly that much at the bottom, keep the feed where it was, and never scroll itself.
async function setup(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioKeyboard: { postMessage() {} } } };
  });
  await mockConsole(page, { conversations: [] });
  const now = Date.now();
  const tasks = Array.from({ length: 24 }, (_, i) => ({
    id: `task-${i}`, revision: 1, title: `任务 ${i}`, text: `任务 ${i}`, conversationId: "c-1", status: "completed",
    result: `第 ${i} 个任务的结果，`.repeat(6), error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0,
    createdAt: now - (24 - i) * 60_000, completedAt: now - (24 - i) * 60_000 + 1000,
  }));
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks, nextBefore: null } }));
}

const keyboard = (page: Page, height: number) => page.evaluate((h) => window.dispatchEvent(new CustomEvent("aio-keyboard", { detail: { height: h } })), height);
const composerBottom = (page: Page) => page.locator(".composer").first().evaluate((n) => n.getBoundingClientRect().bottom);
const feedGap = (page: Page) => page.locator(".chat-scroll").first().evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);

test("in the iOS app the composer and the feed follow the keyboard frame by frame", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"));
  await setup(page);
  await page.goto("/");
  await expect(page.getByText("任务 23").first()).toBeVisible();
  const rest = await composerBottom(page);
  const header = await page.locator(".chat-header, header").first().evaluate((n) => n.getBoundingClientRect().top);
  const gap = await feedGap(page);
  // Rising: each reported height moves the composer by exactly that much; the feed keeps its distance from the bottom.
  for (const h of [40, 120, 230, 336]) {
    await keyboard(page, h);
    expect(await composerBottom(page)).toBeCloseTo(rest - h, 0);
    expect(Math.abs((await feedGap(page)) - gap)).toBeLessThan(2);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.locator(".chat-header, header").first().evaluate((n) => n.getBoundingClientRect().top)).toBe(header);
  await page.screenshot({ path: info.outputPath("app-keyboard-open.png") });
  // Falling back to nothing restores the page as it was.
  for (const h of [200, 60, 0]) {
    await keyboard(page, h);
    expect(await composerBottom(page)).toBeCloseTo(rest - h, 0);
  }
  expect(Math.abs((await feedGap(page)) - gap)).toBeLessThan(2);
});

test("without the app's marker the page ignores keyboard events from elsewhere", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"));
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  await expect(page.locator(".composer").first()).toBeVisible();
  const rest = await composerBottom(page);
  await keyboard(page, 300);
  expect(await composerBottom(page)).toBe(rest);
});

// iOS anchors the attachment menu to the button: losing focus closed the keyboard and the composer slid
// away from the menu. (Chromium moves focus to a label's file input on activation; Android opens its file
// chooser as a full screen, so there is nothing to strand there.)
test("the attachment button keeps the message box focused, so an iPhone keyboard stays up for its menu", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-webkit");
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.click();
  await expect(box).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".composer .file-button").first().click();
  await chooser;
  await expect(box).toBeFocused();
});
