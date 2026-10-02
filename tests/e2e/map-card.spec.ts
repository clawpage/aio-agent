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

test("a place in a reply is a map card that opens the navigation apps", async ({ page }, info) => {
  const { tiles } = await setup(page, located);
  const card = page.getByRole("button", { name: /地图：金门大桥/ });
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

  await card.click();
  const sheet = page.getByRole("dialog", { name: "导航到 金门大桥" });
  await expect(sheet).toBeVisible();
  const links = sheet.locator(".map-nav-list a");
  const ids = await links.evaluateAll((els) => els.map((el) => el.getAttribute("data-nav")));
  if (info.project.name === "mobile") {
    // Android: the system lists the installed navigation apps.
    expect(ids[0]).toBe("system");
    await expect(links.first()).toHaveAttribute("href", /^geo:37\.8199,-122\.4783\?q=/);
    expect(ids).not.toContain("apple");
  } else {
    expect(ids[0]).toBe("apple");
    await expect(links.first()).toHaveAttribute("href", "https://maps.apple.com/?daddr=37.8199,-122.4783&q=%E9%87%91%E9%97%A8%E5%A4%A7%E6%A1%A5&dirflg=d");
  }
  for (const id of ["amap", "baidu", "google", "waze"]) expect(ids).toContain(id);
  // Links go to the phone's apps, never through the sandbox browser.
  await expect(sheet.locator('[data-nav="google"]')).toHaveAttribute("target", "_blank");
  await expect(sheet.locator('[data-nav="google"]')).toHaveAttribute("href", /destination=37\.8199,-122\.4783/);
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
  await expect(card).toBeFocused();
});

test("a place given only by address is located by the control plane, or still navigable by address", async ({ page }) => {
  const result = "```map\n{\"name\": \"外滩\", \"address\": \"上海市黄浦区中山东一路\"}\n```\n\n```map\n{\"name\": \"找不到的地方\"}\n```";
  const { geocodes, tiles } = await setup(page, result);
  const found = page.getByRole("button", { name: /地图：外滩/ });
  const missing = page.getByRole("button", { name: /地图：找不到的地方/ });
  await expect(found).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => geocodes).toEqual(expect.arrayContaining(["上海市黄浦区中山东一路", "找不到的地方"]));
  await expect(found.locator(".map-pin")).toBeVisible();
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
  await expect(missing).toContainText("未能在地图上定位");
  await missing.click();
  const sheet = page.getByRole("dialog", { name: "导航到 找不到的地方" });
  await expect(sheet).toContainText("没能在地图上定位");
  await expect(sheet.locator('[data-nav="google"]')).toHaveAttribute("href", /destination=%E6%89%BE/);
  await sheet.getByRole("button", { name: "关闭地图" }).click();
  await expect(sheet).toHaveCount(0);
});

test("a broken map block stays readable as code", async ({ page }) => {
  await setup(page, "```map\n{\"name\": 坏的}\n```");
  await expect(page.locator(".bubble pre")).toContainText("坏的", { timeout: 60_000 });
  await expect(page.locator(".map-card")).toHaveCount(0);
});
