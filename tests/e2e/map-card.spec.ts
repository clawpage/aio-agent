import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { mockConsole } from "./mock-api";

const TILE = fs.readFileSync(new URL("../../src/ui/public/icon-192.png", import.meta.url));

function task(result: string) {
  return { id: "task-1", revision: 1, title: "周末去哪", text: "推荐个地方", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

async function setup(page: Page, result: string) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(result)], nextBefore: null } }));
  const tiles: string[] = [];
  await page.route("**/api/map/tiles/**", (r) => { tiles.push(new URL(r.request().url()).pathname); return r.fulfill({ contentType: "image/png", body: TILE }); });
  const geocodes: string[] = [];
  await page.route("**/api/map/geocode*", (r) => {
    const q = new URL(r.request().url()).searchParams.get("q")!;
    geocodes.push(q);
    return r.fulfill({ json: { place: q.includes("找不到") ? null : { lat: 31.2304, lng: 121.4737, label: q } } });
  });
  await page.goto("/");
  return { tiles, geocodes };
}

const located = "周末可以去这里：\n\n```map\n{\"name\": \"金门大桥\", \"address\": \"Golden Gate Bridge, San Francisco, CA\", \"lat\": 37.8199, \"lng\": -122.4783}\n```\n\n记得带外套。";

/** Map apps open in a new tab on these test devices; answer them locally. */
async function stubMapSites(page: Page) {
  await page.context().route(/^https:\/\/(maps\.apple\.com|www\.google\.com|waze\.com|uri\.amap\.com|api\.map\.baidu\.com)\//, (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>map</title>" }));
}

test("a place in a reply is a map card that shows the place in a map app", async ({ page }, info) => {
  const { tiles } = await setup(page, located);
  await stubMapSites(page);
  const card = page.locator(".map-card").filter({ hasText: "金门大桥" });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("Golden Gate Bridge, San Francisco, CA");
  // In place between the two paragraphs, drawn from the console's own tile proxy.
  const bubble = page.locator(".bubble").filter({ has: card });
  await expect(bubble).toContainText("周末可以去这里");
  await expect(bubble).toContainText("记得带外套");
  await expect(bubble).not.toContainText('"lat"');
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
  expect(tiles.every((t) => /^\/api\/map\/tiles\/15\/\d+\/\d+$/.test(t))).toBe(true);
  await expect(card.locator(".map-pin")).toBeVisible();
  await page.screenshot({ path: info.outputPath("map-card.png") });

  const android = info.project.name === "mobile";
  if (android) {
    // Android: the first tap already goes to the system, which lists the installed map apps.
    await expect(card.getByRole("link", { name: "在地图应用中查看：金门大桥" })).toHaveAttribute("href", /^geo:37\.8199,-122\.4783\?q=/);
    await expect(card.locator("a.map-card-map")).toHaveAttribute("href", /^geo:37\.8199,-122\.4783\?q=/);
    await expect(card.locator(".map-card-action")).toHaveText("打开地图");
    await card.getByRole("button", { name: "换个地图应用" }).click();
  } else {
    // A page cannot see the installed apps: the first tap asks which one this device uses.
    await expect(card.locator(".map-card-action")).toHaveText("查看地图");
    await card.getByRole("button", { name: /地图：金门大桥/ }).click();
  }
  const sheet = page.getByRole("dialog", { name: "在地图中查看 金门大桥" });
  await expect(sheet).toBeVisible();
  const links = sheet.locator(".map-nav-list a");
  const ids = await links.evaluateAll((els) => els.map((el) => el.getAttribute("data-nav")));
  if (android) {
    expect(ids[0]).toBe("system");
    await expect(links.first()).toHaveAttribute("href", /^geo:37\.8199,-122\.4783\?q=/);
    await expect(links.first()).toContainText("当前");
    expect(ids).not.toContain("apple");
  } else {
    expect(ids[0]).toBe("apple");
    await expect(links.first()).toHaveAttribute("href", "https://maps.apple.com/?ll=37.8199,-122.4783&q=%E9%87%91%E9%97%A8%E5%A4%A7%E6%A1%A5");
  }
  for (const id of ["amap", "baidu", "google", "waze"]) expect(ids).toContain(id);
  // The place itself, never a route; links go to the phone's apps, never through the sandbox browser.
  for (const href of await links.evaluateAll((els) => els.map((el) => el.getAttribute("href")!))) expect(href).not.toMatch(/daddr|\/dir\/|navigat|direction/);
  await expect(sheet.locator('[data-nav="google"]')).toHaveAttribute("target", "_blank");
  await expect(sheet.locator('[data-nav="google"]')).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=37.8199,-122.4783");
  const before = tiles.length;
  await sheet.getByRole("button", { name: "放大" }).click();
  await expect.poll(() => tiles.slice(before).some((t) => t.startsWith("/api/map/tiles/17/"))).toBe(true);
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: info.outputPath("map-sheet.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(card.locator(".map-card-open, .map-card-main")).toBeFocused();

  // The pick is remembered on this device: from then on a tap opens that app directly.
  await card.locator(android ? ".map-card-switch" : ".map-card-main").click();
  const popup = page.waitForEvent("popup");
  await sheet.locator('[data-nav="google"]').click();
  await (await popup).close();
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("aio.mapApp"))).toBe("google");
  await page.reload();
  const open = card.getByRole("link", { name: "在Google 地图中查看：金门大桥" });
  await expect(open).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=37.8199,-122.4783", { timeout: 60_000 });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(card.locator(".map-card-action")).toHaveText("Google 地图");
  await page.screenshot({ path: info.outputPath("map-card-remembered.png") });
  const opened = page.waitForEvent("popup");
  await card.locator("a.map-card-map").click();
  expect((await opened).url()).toBe("https://www.google.com/maps/search/?api=1&query=37.8199,-122.4783");
  await card.getByRole("button", { name: "换个地图应用" }).click();
  await expect(sheet.locator('[data-nav="google"]')).toContainText("当前");
});

test("a place given only by address is located by the control plane, or shown without a map", async ({ page }, info) => {
  const result = "```map\n{\"name\": \"外滩\", \"address\": \"上海市黄浦区中山东一路\"}\n```\n\n```map\n{\"name\": \"找不到的地方\"}\n```";
  const { geocodes, tiles } = await setup(page, result);
  const found = page.locator(".map-card").filter({ hasText: "外滩" });
  const missing = page.locator(".map-card").filter({ hasText: "找不到的地方" });
  await expect(found).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => geocodes).toEqual(expect.arrayContaining(["上海市黄浦区中山东一路", "找不到的地方"]));
  await expect(found.locator(".map-pin")).toBeVisible();
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
  // Not located: no empty map, just the place and its button.
  await expect(missing.locator(".map-view")).toHaveCount(0);
  await expect(missing).not.toContainText("定位");
  await expect(missing.locator(".map-card-action")).toBeVisible();
  expect((await missing.boundingBox())!.height).toBeLessThan(80);
  await page.screenshot({ path: info.outputPath("map-card-unlocated.png") });
  if (info.project.name === "mobile") {
    await expect(missing.getByRole("link", { name: /找不到的地方/ })).toHaveAttribute("href", `geo:0,0?q=${encodeURIComponent("找不到的地方")}`);
    await expect(missing.locator("a.map-card-map")).toHaveCount(0);
    await missing.getByRole("button", { name: "换个地图应用" }).click();
  } else {
    await missing.getByRole("button", { name: /地图：找不到的地方/ }).click();
  }
  const sheet = page.getByRole("dialog", { name: "在地图中查看 找不到的地方" });
  await expect(sheet.locator(".map-sheet-map")).toHaveCount(0);
  await expect(sheet).not.toContainText("定位");
  await expect(sheet.locator('[data-nav="google"]')).toHaveAttribute("href", `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("找不到的地方")}`);
  await sheet.getByRole("button", { name: "关闭地图" }).click();
  await expect(sheet).toHaveCount(0);
});

test("a broken map block stays readable as code", async ({ page }) => {
  await setup(page, "```map\n{\"name\": 坏的}\n```");
  await expect(page.locator(".bubble pre")).toContainText("坏的", { timeout: 60_000 });
  await expect(page.locator(".map-card")).toHaveCount(0);
});
