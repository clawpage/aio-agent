import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import { makeConversation, mockConsole } from "./mock-api";

const picture = fs.readFileSync(new URL("../../src/ui/public/icon-192.png", import.meta.url));
const result = `[报告](/home/gem/workspace/report.md)\n\n![图片](/home/gem/workspace/picture.png)\n\n[操作网页](http://192.168.1.20)\n\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#8f86ff"/></svg>\n\`\`\`\n\n\`\`\`map\n{"name":"金门大桥","address":"San Francisco","lat":37.8199,"lng":-122.4783}\n\`\`\``;
const task = { id: "safe-task", revision: 1, title: "安全区验证", text: "查看报告", conversationId: "safe-child", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: 2000 };

async function setup(page: Page) {
  await mockConsole(page, { conversations: [makeConversation(task.conversationId, task.title)] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null } }));
  await page.route("**/api/settings/dispatch-log/*", r => r.fulfill({ json: {
    task, entries: [{ at: 1000, latencyMs: 100, rounds: 1, promptChars: 1000, failed: false, repairs: [], candidates: [], searches: [], chosen: { related: [], appendTo: null, resume: null }, jev: null,
      steps: [{ kind: "context", at: 1000, timeline: "长日志内容\n".repeat(100), candidates: 0 }, { kind: "ask", at: 1000, round: 1, prompt: "完整提示\n".repeat(100), answer: "最终结果" }],
    }],
  } }));
  await page.route("**/api/documents/text**", r => r.fulfill({ json: { path: "", text: "# 报告\n\n" + "正文\n\n".repeat(150), size: 1000, truncated: false } }));
  await page.route("**/api/documents/image**", r => r.fulfill({ contentType: "image/png", body: picture }));
  await page.route("**/api/map/tiles/**", r => r.fulfill({ contentType: "image/png", body: picture }));
  await page.route("**/api/browser/tabs", r => r.fulfill({ json: { ok: true, tab: { id: "tab-1", title: "测试网页", url: "http://192.168.1.20", width: 1000, height: 800 } } }));
  await page.route("**/api/workspace/ticket", r => r.fulfill({ json: { ticket: "test", origin: "http://127.0.0.1:4288", url: "http://127.0.0.1:4288/test-desktop", expiresAt: Date.now() + 60000 } }));
  await page.route("**/test-desktop", r => r.fulfill({ contentType: "text/html", body: "<body>测试桌面</body>" }));
  await page.addInitScript(() => localStorage.setItem("aio.debug", "1"));
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
}

type Insets = { top: number; right: number; bottom: number; left: number };
// Native env() values are zero in headless browsers. Exercise the same geometry
// through the production tokens, including asymmetric landscape cutouts.
async function insets(page: Page, values: Insets) {
  await page.addStyleTag({ content: `:root { --safe-top:${values.top}px; --safe-right:${values.right}px; --safe-bottom:${values.bottom}px; --safe-left:${values.left}px; }` });
}

async function contained(page: Page, node: Locator, safe: Insets, height = page.viewportSize()!.height) {
  await expect(node).toBeVisible();
  const box = (await node.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(safe.top - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height - safe.bottom + 1);
  expect(box.x).toBeGreaterThanOrEqual(safe.left - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - safe.right + 1);
}

async function navigate(page: Page, label: string, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: label, exact: true }).click();
}

const cases = [
  { name: "desktop", width: 1440, height: 900, safe: { top: 0, right: 0, bottom: 0, left: 0 }, desktop: true },
  { name: "notch", width: 390, height: 844, safe: { top: 62, right: 0, bottom: 34, left: 0 }, desktop: false },
  { name: "android-short", width: 360, height: 640, safe: { top: 24, right: 0, bottom: 24, left: 0 }, desktop: false },
  { name: "landscape", width: 844, height: 390, safe: { top: 0, right: 32, bottom: 21, left: 59 }, desktop: false },
];

for (const c of cases) {
  test(`${c.name}: pages and fixed surfaces keep controls inside one safe area`, async ({ page }, info) => {
    test.skip(c.desktop !== (info.project.name === "desktop"));
    await page.setViewportSize({ width: c.width, height: c.height });
    await setup(page);
    await insets(page, c.safe);
    const mobile = !c.desktop;
    await contained(page, page.locator(".task-chat .chat-head"), c.safe);
    if (mobile) {
      await contained(page, page.getByRole("button", { name: "打开导航" }), c.safe);
      await page.getByRole("button", { name: "打开导航" }).click();
      await contained(page, page.getByRole("button", { name: "关闭导航" }), c.safe);
      await page.getByRole("button", { name: "关闭导航" }).click();
    }
    await navigate(page, "配置", mobile);
    await contained(page, page.locator(".settings-head"), c.safe);
    // The safe area belongs to the app, not each header: title clears the
    // status bar, and the settings header does not gain a second notch height.
    await contained(page, page.getByRole("heading", { name: "配置", exact: true }), c.safe);
    expect((await page.locator(".settings-head").boundingBox())!.height).toBeLessThan(80);
    await page.locator(".settings").evaluate(n => { n.scrollTop = n.scrollHeight; });
    await contained(page, page.locator(".settings-head"), c.safe);
    await page.getByRole("button", { name: "← 返回会话" }).click();

    await navigate(page, "任务列表", mobile);
    await contained(page, page.locator(".task-list-page > .chat-head"), c.safe);
    await page.getByRole("button", { name: `打开任务：${task.title}`, exact: true }).click();
    await contained(page, page.locator(".task-detail-bar"), c.safe);
    await contained(page, page.locator(".task-detail .chat-head"), c.safe);
    await navigate(page, "主会话", mobile);

    await page.getByRole("button", { name: `派单日志：${task.title}` }).click();
    const log = page.getByRole("dialog", { name: "派单日志" });
    await expect(log).toContainText("最终结果");
    await contained(page, log, c.safe);
    await contained(page, log.getByRole("button", { name: "关闭", exact: true }), c.safe);
    await log.locator(".dispatch-log-body").evaluate(n => { n.scrollTop = n.scrollHeight; });
    await contained(page, log.locator(".file-preview-head"), c.safe);
    await page.screenshot({ path: info.outputPath(`${c.name}-dispatch-safe.png`) });
    await log.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(log).toHaveCount(0);

    const more = page.getByRole("button", { name: `点击看更多：${task.title}`, exact: true });
    const expanded = await more.isVisible();
    if (expanded) await more.click();
    const message = expanded ? page.getByRole("dialog", { name: `完整消息：${task.title}`, exact: true }) : page.locator(".task-report");
    if (expanded) await contained(page, message.getByRole("button", { name: "关闭消息" }), c.safe);

    for (const name of ["报告", "图片"]) {
      if (name === "图片") await message.locator("img.inline-media").click();
      else await message.getByRole("button", { name: `预览 ${name}`, exact: true }).click();
      const preview = page.locator(".file-preview");
      await contained(page, preview, c.safe);
      await contained(page, preview.getByRole("button", { name: "关闭预览" }), c.safe);
      await contained(page, preview.locator(".file-preview-foot"), c.safe);
      await preview.getByRole("button", { name: "关闭预览" }).click();
    }

    await message.getByRole("button", { name: "查看大图", exact: true }).click();
    await contained(page, page.locator(".image-viewer-bar"), c.safe);
    await page.keyboard.press("Escape");
    await message.locator(".map-card-switch, .map-card-main").first().click();
    await contained(page, page.locator(".map-sheet"), c.safe);
    await page.keyboard.press("Escape");

    await message.getByRole("link", { name: "操作网页", exact: true }).click();
    const console = page.getByRole("dialog", { name: "操作网页" });
    await contained(page, console, c.safe);
    await contained(page, console.getByRole("button", { name: "关闭操作面板" }), c.safe);
    await page.screenshot({ path: info.outputPath(`${c.name}-console-safe.png`) });
    await console.getByRole("button", { name: "关闭操作面板" }).click();

    await navigate(page, "工作区", mobile);
    await contained(page, page.locator(".workspace .ws-head"), c.safe);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
}


test("keyboard viewport removes the covered home inset and restores it; login also clears the cutouts", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"));
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const safe = { top: 62, right: 0, bottom: 34, left: 0 };
  await insets(page, safe);
  await page.getByRole("textbox", { name: "消息", exact: true }).focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 420 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.locator(".app").evaluate(n => n.clientHeight)).toBe(420);
  await contained(page, page.locator(".composer"), { ...safe, bottom: 0 }, 420);
  expect(await page.locator(".app").evaluate(n => getComputedStyle(n).paddingBottom)).toBe("0px");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    delete (window.visualViewport! as unknown as Record<string, unknown>).height;
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.locator(".app").evaluate(n => n.clientHeight)).toBe(844);
  expect(await page.locator(".app").evaluate(n => getComputedStyle(n).paddingBottom)).toBe("34px");
  await contained(page, page.locator(".composer"), safe);
  await page.route("**/api/auth/session", r => r.fulfill({ json: { authenticated: false } }));
  await page.reload();
  await insets(page, safe);
  await contained(page, page.locator(".login-card"), safe);
});
