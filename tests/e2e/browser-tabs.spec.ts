import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { mockConsole } from "./mock-api";

const picture = fs.readFileSync(new URL("../../src/ui/public/icon-512.png", import.meta.url));
const pages = [
  { target: "AAAA0000AAAA0000", title: "Walmart 收纳箱搜索结果", url: "https://www.walmart.com/search?q=storage", tab: "t1", owner: "task", task: "在沃尔玛找收纳箱", holder: "ai", front: true },
  { target: "BBBB1111BBBB1111", title: "我的订单", url: "https://www.amazon.com/orders", tab: "t2", owner: "person", task: null, holder: "human", front: false },
  { target: "CCCC2222CCCC2222", title: "", url: "https://example.org/a-very-long-path/that/keeps/going", tab: null, owner: null, task: null, holder: null, front: false },
];

async function openBrowser(page: Page) {
  await mockConsole(page, { conversations: [], browser: {} });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/workspace/ticket", r => r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/test-desktop", expiresAt: Date.now() + 60_000 } }));
  await page.route("**/test-desktop", r => r.fulfill({ contentType: "text/html", body: "<body style='background:#222'></body>" }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  const workspace = page.getByRole("button", { name: "工作区", exact: true });
  if (!(await workspace.isVisible())) await page.getByRole("button", { name: /菜单|打开导航/ }).first().click();
  await workspace.click();
  const icon = page.locator(".desktop-icon", { hasText: "浏览器" });
  if (await icon.isVisible().catch(() => false)) await icon.click();
  await expect(page.locator(".workspace .desktop-frame iframe")).toBeVisible();
}

test("the workspace browser shows every open page with a preview and switches to the one chosen", async ({ page }, info) => {
  const fronted: string[] = [];
  let shots = 0;
  await page.route("**/api/browser/overview", r => r.fulfill({ json: { pages } }));
  await page.route("**/api/browser/overview/shot*", r => { shots += 1; return r.fulfill({ contentType: "image/png", body: picture }); });
  await page.route("**/api/browser/overview/front", r => { fronted.push(r.request().postDataJSON().target); return r.fulfill({ json: { target: fronted.at(-1) } }); });
  await openBrowser(page);
  await page.getByRole("button", { name: "标签页", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "浏览器标签页" });
  await expect(panel).toContainText("标签页 · 3");
  const cards = panel.locator(".browser-tab-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("Walmart 收纳箱搜索结果");
  await expect(cards.nth(0)).toContainText("正在显示");
  await expect(cards.nth(0)).toContainText("AI 在用 · 在沃尔玛找收纳箱");
  await expect(cards.nth(1)).toContainText("你打开的");
  await expect(cards.nth(2)).toContainText("example.org");
  await expect(cards.nth(2)).toContainText("未归属");
  await expect.poll(() => shots).toBeGreaterThanOrEqual(3);
  await expect.poll(() => panel.locator("img").evaluateAll(imgs => imgs.every(i => (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  for (const card of await cards.all()) {
    const box = (await card.boundingBox())!;
    expect(box.width).toBeGreaterThan(120);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("browser-tabs.png") });
  await page.getByRole("button", { name: "切换到：我的订单" }).click();
  await expect.poll(() => fronted).toEqual(["BBBB1111BBBB1111"]);
  await expect(panel).toHaveCount(0);
  // Escape closes it too.
  await page.getByRole("button", { name: "标签页", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "浏览器标签页" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "浏览器标签页" })).toHaveCount(0);
});

test("a tab overview that cannot be read says so and a closed page reports back", async ({ page }) => {
  let fail = true;
  await page.route("**/api/browser/overview", r => fail ? r.fulfill({ status: 503, json: { error: "unavailable", message: "浏览器暂不可用，请稍后重试" } }) : r.fulfill({ json: { pages } }));
  await page.route("**/api/browser/overview/shot*", r => r.fulfill({ contentType: "image/png", body: picture }));
  await page.route("**/api/browser/overview/front", r => r.fulfill({ status: 404, json: { error: "no_page", message: "这个标签页已经关闭" } }));
  await openBrowser(page);
  await page.getByRole("button", { name: "标签页", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "浏览器标签页" });
  await expect(panel).toContainText("浏览器暂时打不开标签页列表");
  fail = false;
  await expect(panel.locator(".browser-tab-card")).toHaveCount(3, { timeout: 10_000 });
  await panel.locator(".browser-tab-card").nth(2).click();
  await expect(page.getByText("这个标签页已经关闭")).toBeVisible();
  await expect(panel).toBeVisible();
});

test("an open overview keeps its list live but retakes a preview only when that page changed or it has gone stale", async ({ page }) => {
  // Every preview is one screenshot exec in the (possibly remote) sandbox: four-second refreshes of every page were far too many.
  const live = pages.map(p => ({ ...p }));
  let lists = 0;
  const shots: string[] = [];
  await page.clock.install();
  await page.route("**/api/browser/overview", r => { lists += 1; return r.fulfill({ json: { pages: live } }); });
  await page.route("**/api/browser/overview/shot*", r => { shots.push(new URL(r.request().url()).searchParams.get("target")!); return r.fulfill({ contentType: "image/png", body: picture }); });
  await openBrowser(page);
  await page.getByRole("button", { name: "标签页", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "浏览器标签页" });
  await expect(panel.locator(".browser-tab-card")).toHaveCount(3);
  await expect.poll(() => shots.length).toBe(3);
  const listed = lists;
  // Two list refreshes with nothing changed: the list is read again, no preview is retaken.
  await page.clock.runFor(8_500);
  await expect.poll(() => lists).toBeGreaterThanOrEqual(listed + 2);
  await page.waitForTimeout(300);
  expect(shots).toHaveLength(3);
  // A page that navigated gets a new preview on the next refresh; the others keep theirs.
  live[1]!.title = "订单详情";
  await page.clock.runFor(4_000);
  await expect(panel).toContainText("订单详情");
  await expect.poll(() => shots.slice(3)).toEqual(["BBBB1111BBBB1111"]);
  // Past the slower cadence every preview is retaken once.
  await page.clock.runFor(4_000);
  await expect.poll(() => [...shots.slice(4)].sort()).toEqual(["AAAA0000AAAA0000", "CCCC2222CCCC2222"]);
});
