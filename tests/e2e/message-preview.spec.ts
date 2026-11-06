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

test("on a phone the full message page is swiped back from the left edge, following the finger", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "phone layout only");
  await mockConsole(page, { conversations: [] });
  const report = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段正文。`).join("\n\n");
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [{ id: "long-message", revision: 1, title: "长消息", text: "问题", result: report, status: "completed", conversationId: "child", attachments: [], createdAt: 1000, completedAt: 2000, approvals: 0, dependencies: [] }], nextBefore: null } }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const more = page.getByRole("button", { name: "点击看更多：长消息", exact: true });
  const dialog = page.getByRole("dialog", { name: "完整消息：长消息", exact: true });
  const x = () => dialog.evaluate(n => Math.round(n.getBoundingClientRect().x));
  /** A touch drag as the page's listeners see it; `hold` keeps the finger down before letting go (a slow release). */
  const drag = (points: [number, number][], { hold = 150, release = true } = {}) => page.evaluate(async ({ points, hold, release }) => {
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const target = document.elementFromPoint(...points[0])!;
    const fire = (type: string, [x, y]: [number, number]) => target.dispatchEvent(new PointerEvent(type, { pointerId: 51, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
    fire("pointerdown", points[0]);
    for (const point of points.slice(1)) { await wait(24); fire("pointermove", point); }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!release) return;
    await wait(hold);
    fire("pointerup", points.at(-1)!);
  }, { points, hold, release });
  await more.click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(n => n.getAnimations().length)).toBe(0);
  const depth = await page.evaluate(() => history.length), url = page.url();

  // Mid-drag the page sits under the finger, the feed showing beside it.
  await drag([[6, 420], [30, 420], [70, 420], [110, 420], [150, 420]], { release: false });
  expect(Math.abs(await x() - 144)).toBeLessThan(8);
  await page.screenshot({ path: `/Users/mengxiao/workspace/.scratch/artifacts/swipe-back/${info.project.name}-midway.png` });
  await page.evaluate(() => document.elementFromPoint(150, 420)!.dispatchEvent(new PointerEvent("pointerup", { pointerId: 51, pointerType: "touch", isPrimary: true, clientX: 150, clientY: 420, bubbles: true })));
  // Let go short of 40%, slowly: back in place, still open.
  await expect.poll(x).toBe(0);
  await expect.poll(() => dialog.evaluate(n => n.style.transform)).toBe("");
  await expect(dialog).toBeVisible();

  // A vertical move at the edge, or a sideways one away from it, leaves the page alone.
  await drag([[8, 600], [10, 560], [12, 480], [14, 380]]);
  await drag([[80, 420], [140, 420], [220, 420], [300, 420]]);
  await page.waitForTimeout(350);
  await expect(dialog).toBeVisible();
  expect(await x()).toBe(0);

  // Past 40%: the page goes, through its history entry, and the address stays.
  await drag([[6, 420], [60, 420], [120, 420], [180, 420], [240, 420]]);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (history.state as { message?: string } | null)?.message)).toBeUndefined();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(depth);

  // A short flick does it too, and the page opened again is in place.
  await more.click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(n => n.getAnimations().length)).toBe(0);
  expect(await x()).toBe(0);
  expect(await dialog.evaluate(n => n.getAttribute("style"))).toBeFalsy();
  await drag([[6, 420], [30, 420], [60, 420], [100, 420]], { hold: 0 });
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeVisible();
});
