import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** A main-chat message folds past this share of the usable screen height. */
const FOLD = 1;

test("long main messages cap at one screen, open as a full-screen page on phones and retain device/private links and draft", async ({ page }, info) => {
  const opened: string[] = [];
  await mockConsole(page, { conversations: [], onBrowserTab: url => opened.push(url) });
  const result = `[公开链接](https://external.example/start)\n\n` + Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段：完整正文可以一直读到最后。`).join("\n\n") + "\n\n[末尾公开链接](https://external.example/end)\n\n[内网链接](http://192.168.1.8/page)\n\n完整正文结束";
  let text = Array.from({ length: 90 }, (_, i) => `用户原始需求第 ${i + 1} 行`).join("\n");
  let report = result;
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [{ id: "long-message", revision: 1, title: "长消息", text, result: report, status: "completed", conversationId: "child", attachments: [], createdAt: 1000, completedAt: 2000, approvals: 0, dependencies: [] }, { id: "short-message", revision: 1, title: "短消息", text: "简短问题", result: "简短回答", status: "completed", conversationId: "short-child", attachments: [], createdAt: 3000, completedAt: 4000, approvals: 0, dependencies: [] }], nextBefore: null } }));
  await page.context().route("https://external.example/**", r => r.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1>设备网页</h1>" }));
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.evaluate(() => {
    const style = document.createElement("style"); style.textContent = ":root { --safe-top: 62px; --safe-bottom: 34px; }"; document.head.append(style);
  });
  const more = page.getByRole("button", { name: "点击看更多：长消息", exact: true });
  await expect(more).toBeVisible();
  await expect(page.getByRole("button", { name: "点击看更多：用户消息", exact: true })).toHaveCount(1);
  await expect(page.locator('[data-task-id="short-message"] .message-more')).toHaveCount(0);
  const preview = page.locator('.task-report[data-task-id="long-message"] [data-testid="message-preview"]');
  const cap = await page.evaluate((fold) => {
    const n = document.createElement("div"); n.style.height = "var(--safe-height)"; document.body.append(n);
    const height = n.getBoundingClientRect().height; n.remove(); return height * fold;
  }, FOLD);
  const height = (await preview.boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(cap + 1);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留草稿");
  await more.click();
  const dialog = page.getByRole("dialog", { name: "完整消息：长消息", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(n => n.getAnimations().length)).toBe(0);
  const sheet = (await dialog.boundingBox())!;
  const view = page.viewportSize()!;
  const mobile = info.project.name.startsWith("mobile");
  if (mobile) {
    // A phone reads it as a page of its own: edge to edge, with its controls clear of the insets.
    expect(sheet).toEqual({ x: 0, y: 0, width: view.width, height: view.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(view.width);
    const back = (await dialog.getByRole("button", { name: "关闭消息" }).boundingBox())!;
    expect(back.x).toBeLessThan(view.width / 2);
    expect(back.y).toBeGreaterThanOrEqual(62);
    const scroller = (await dialog.locator(".full-message-body").boundingBox())!;
    expect(Math.abs(scroller.y + scroller.height - (view.height - 34))).toBeLessThan(1);
    expect(await page.locator(".full-message-backdrop").evaluate(n => getComputedStyle(n).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  } else {
    // A wide screen reads it in a centred window with a readable measure, clear of every edge.
    expect(sheet.width).toBeLessThanOrEqual(880);
    expect(Math.abs(sheet.x + sheet.width / 2 - view.width / 2)).toBeLessThan(2);
    expect(Math.abs(sheet.y + sheet.height / 2 - view.height / 2)).toBeLessThan(2);
    expect(sheet.y).toBeGreaterThanOrEqual(39);
    expect((await dialog.locator(".full-message-content").boundingBox())!.width).toBeLessThanOrEqual(720);
  }
  await expect(dialog.getByRole("button", { name: "关闭消息" })).toBeFocused();
  const body = dialog.locator(".full-message-body");
  await expect(dialog.locator(".bubble")).toHaveCount(0);
  expect(await dialog.locator(".full-message-content").evaluate(n => getComputedStyle(n).borderTopWidth)).toBe("0px");
  const bounds = (await body.boundingBox())!;
  expect(bounds.height).toBeGreaterThan(height * .8);
  const last = dialog.getByRole("link", { name: "末尾公开链接", exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  const popup = page.waitForEvent("popup"); await last.click(); const tab = await popup;
  await expect.poll(() => tab.url()).toBe("https://external.example/end"); await tab.close();
  expect(opened).toEqual([]);
  await page.screenshot({ path: info.outputPath("message-sheet.png") });
  await dialog.getByRole("button", { name: "关闭消息" }).click();
  await expect(dialog).toHaveCount(0); await expect(more).toBeFocused();
  await more.click();
  await dialog.getByRole("link", { name: "内网链接", exact: true }).click();
  await expect.poll(() => opened).toEqual(["http://192.168.1.8/page"]);
  await expect(page.locator(".workspace")).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留草稿");
  // Text, the bottom hint, and keyboard all reach the same reading sheet.
  await preview.locator(".markdown p").nth(1).click();
  await expect(dialog).toBeVisible(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await more.click();
  if (mobile) {
    // The system back gesture closes the page and stays on the same address; Close does not leave a stray entry.
    await expect(dialog).toBeVisible();
    const url = page.url(), depth = await page.evaluate(() => history.length);
    await page.goBack(); await expect(dialog).toHaveCount(0);
    expect(page.url()).toBe(url);
    await more.click(); await dialog.getByRole("button", { name: "关闭消息" }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (history.state as { message?: string } | null)?.message)).toBeUndefined();
    expect(await page.evaluate(() => history.length)).toBe(depth);
  } else {
    await page.locator(".full-message-backdrop").click({ position: { x: 10, y: 5 } });
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole("button", { name: "点击看更多：用户消息", exact: true }).click();
  const user = page.getByRole("dialog", { name: "完整消息：用户消息", exact: true });
  await expect(user).toContainText("用户原始需求第 90 行");
  await user.getByRole("button", { name: "关闭消息" }).click();
  if (mobile) {
    await page.setViewportSize({ width: 360, height: 640 });
    await expect.poll(async () => (await preview.boundingBox())!.height).toBeLessThanOrEqual((640 - 96) * FOLD + 1);
  }
  // A live result shrinking back below the threshold removes the hint.
  text = "更新后短需求"; report = "更新后短回答";
  await expect(page.locator(".message-more")).toHaveCount(0);
  await expect(preview).toContainText("更新后短回答");
});
