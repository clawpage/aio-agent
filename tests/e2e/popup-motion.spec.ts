import { test, expect, type Page } from "@playwright/test";
import { mockConsole, makeConversation } from "./mock-api";

const content = "[文件](/home/gem/workspace/report.md)\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 100\"><rect width=\"200\" height=\"100\" fill=\"purple\"/></svg>\n```\n\n```map\n{\"name\":\"金门大桥\",\"lat\":37.82,\"lng\":-122.48}\n```\n\n[内网网页](http://192.168.1.20)\n\n" + "长消息正文\n\n".repeat(100);
const task = { id: "motion", revision: 1, title: "动画验证", text: "查看", result: content, status: "completed", conversationId: "child", attachments: [], createdAt: 1000, completedAt: 2000, approvals: 0, dependencies: [] };

async function setup(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null } }));
  await page.route("**/api/documents/text**", r => r.fulfill({ json: { text: "# 报告", size: 8, truncated: false } }));
  await page.route("**/api/map/tiles/**", r => r.fulfill({ status: 204 }));
  await page.route("**/api/settings/dispatch-log/*", r => r.fulfill({ json: { task, entries: [] } }));
  await page.route("**/api/workspace/ticket", r => r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/desktop", expiresAt: Date.now() + 60000 } }));
  await page.route("http://127.0.0.1:4289/**", r => r.fulfill({ contentType: "text/html", body: "<body>沙箱桌面</body>" }));
  await page.route("**/api/browser/tabs", async r => {
    await new Promise(resolve => setTimeout(resolve, 700));
    await r.fulfill({ json: { ok: true, tab: { id: "tab", title: "内网页面", url: "http://192.168.1.20" } } }).catch(() => undefined);
  });
  await page.addInitScript(() => localStorage.setItem("aio.debug", "1"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
}

/** Observe real rendered positions during CSS animations, without disabling motion. */
async function audit(page: Page, selector: string) {
  await page.evaluate(selector => {
    const logs: Record<string, { start: number; middle?: number; connected?: boolean }> = {};
    (window as any).motionAudit = logs;
    document.addEventListener("animationstart", event => {
      const target = event.target as HTMLElement;
      if (!target.matches(selector) || !["popup-up", "popup-down"].includes(event.animationName)) return;
      const log: (typeof logs)[string] = logs[event.animationName] = { start: target.getBoundingClientRect().y };
      const animation = target.getAnimations().find(a => (a as CSSAnimation).animationName === event.animationName)!;
      const sample = () => {
        if (!target.isConnected) return;
        if (Number(animation.currentTime) >= 70) { log.middle = target.getBoundingClientRect().y; log.connected = target.isConnected; }
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { capture: true });
  }, selector);
}

async function entered(page: Page, selector: string) {
  await expect.poll(() => page.evaluate(() => (window as any).motionAudit["popup-up"]?.middle !== undefined)).toBe(true);
  const log = await page.evaluate(() => (window as any).motionAudit["popup-up"]);
  expect(log.middle).toBeLessThan(log.start - 20);
  await expect.poll(() => page.locator(selector).evaluate(n => n.getAnimations().length)).toBe(0);
}

async function exited(page: Page, selector: string) {
  await expect(page.locator(selector)).toHaveCount(0);
  const log = await page.evaluate(() => (window as any).motionAudit["popup-down"]);
  expect(log.connected).toBe(true);
  expect(log.middle).toBeGreaterThan(log.start + 20);
}

test("reading, nested previews, maps, logs, browser/loading and mobile navigation slide up and down", async ({ page }, info) => {
  await setup(page);
  if (info.project.name.startsWith("mobile")) {
    await audit(page, ".sidebar");
    await page.getByRole("button", { name: "打开导航" }).click(); await entered(page, ".sidebar");
    await page.getByRole("button", { name: "关闭导航" }).click(); await exited(page, ".sidebar");
    await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  }
  await audit(page, ".dispatch-log");
  await page.getByRole("button", { name: "派单日志：动画验证" }).click(); await entered(page, ".dispatch-log");
  await page.locator(".dispatch-log").getByRole("button", { name: "关闭", exact: true }).click(); await exited(page, ".dispatch-log");
  await audit(page, ".full-message");
  const more = page.getByRole("button", { name: "点击看更多：动画验证", exact: true });
  await more.click(); await entered(page, ".full-message");
  const sheet = page.locator(".full-message");
  for (const [selector, open, close] of [
    [".file-preview", () => sheet.getByRole("button", { name: "预览 文件", exact: true }).click(), () => page.getByRole("button", { name: "关闭预览" }).click()],
    [".image-viewer", () => sheet.getByRole("button", { name: "查看大图", exact: true }).click(), () => page.keyboard.press("Escape")],
    [".map-sheet", () => sheet.locator(".map-card-switch, .map-card-main").first().click(), () => page.getByRole("button", { name: "关闭地图" }).click()],
  ] as const) {
    await audit(page, selector); await open(); await entered(page, selector);
    await close(); await exited(page, selector);
    await expect(sheet).toHaveCount(1);
  }
  await audit(page, ".full-message");
  await sheet.getByRole("button", { name: "关闭消息" }).click(); await exited(page, ".full-message");
  await expect(more).toBeFocused();
  // A delayed request keeps the loading card alive for its entry and exit.
  await audit(page, ".opening-card");
  await page.locator(".task-report").getByRole("link", { name: "内网网页", exact: true }).evaluate(n => (n as HTMLAnchorElement).click());
  await entered(page, ".opening-card"); await exited(page, ".opening-card");
  const console = page.locator(".task-console");
  await expect(console).toBeVisible();
  if (info.project.name.startsWith("mobile")) {
    const ratio = await console.locator(".desktop-frame").evaluate(n => n.querySelector("iframe")!.clientWidth / n.clientWidth);
    expect(ratio).toBeCloseTo(1.3, 2);
  }
  await audit(page, ".task-console");
  await console.getByRole("button", { name: "关闭操作面板" }).click(); await exited(page, ".task-console");
  await audit(page, ".workspace");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "工作区", exact: true }).click();
  await entered(page, ".workspace");
  await page.getByRole("button", { name: "关闭工作区" }).click(); await exited(page, ".workspace");
});

test("reduced motion removes the sheet promptly and restores focus and draft", async ({ page }) => {
  await setup(page); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("草稿");
  const more = page.getByRole("button", { name: "点击看更多：动画验证", exact: true });
  await more.click();
  expect(await page.locator(".full-message").evaluate(n => n.getAnimations().length)).toBe(0);
  await page.getByRole("button", { name: "关闭消息" }).click();
  expect(await page.locator(".full-message").count()).toBe(0);
  await expect(more).toBeFocused();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("草稿");
});

test("legacy menu and rename use the same exit lifecycle after cancel and successful save", async ({ page }, info) => {
  await mockConsole(page, { conversations: [makeConversation("rename", "改名验证")] });
  await page.emulateMedia({ reducedMotion: "no-preference" }); await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "会话", exact: true }).click();
  await audit(page, ".conv-menu");
  await page.getByRole("button", { name: "改名验证 的操作", exact: true }).click(); await entered(page, ".conv-menu");
  await page.keyboard.press("Escape"); await exited(page, ".conv-menu");
  for (const save of [false, true]) {
    await page.getByRole("button", { name: "改名验证 的操作", exact: true }).click();
    await audit(page, ".modal"); await page.getByRole("menuitem", { name: "重命名" }).click(); await entered(page, ".modal");
    if (save) await page.getByLabel("会话标题").fill("已经改名");
    await page.locator(".modal").getByRole("button", { name: save ? "保存" : "取消", exact: true }).click(); await exited(page, ".modal");
  }
  await audit(page, ".conv-menu");
  await page.getByRole("button", { name: "已经改名 的操作", exact: true }).click(); await entered(page, ".conv-menu");
  await page.getByRole("menuitem", { name: "归档" }).click(); await exited(page, ".conv-menu");
});


test("reopening during exit cancels dismissal of the new navigation popup", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"));
  await setup(page); await audit(page, ".sidebar");
  await page.getByRole("button", { name: "打开导航" }).click(); await entered(page, ".sidebar");
  await page.getByRole("button", { name: "关闭导航" }).click();
  await expect(page.locator(".sidebar")).toHaveAttribute("data-popup-motion", "exit");
  await page.getByRole("button", { name: "打开导航" }).click(); await entered(page, ".sidebar");
  await expect(page.locator(".sidebar")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭导航" }).click(); await exited(page, ".sidebar");
});
