import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockConsole } from "./mock-api";

const evidence = "/Users/mengxiao/workspace/.scratch/artifacts/edge-swipe";
const tasks = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, revision: 1, title: `任务 ${i}`, text: `第 ${i} 个请求`, result: `第 ${i} 个结果\n\n` + "正文\n\n".repeat(6), status: "completed", conversationId: `c${i}`, attachments: [], createdAt: 1000 + i, completedAt: 2000 + i, approvals: 0, dependencies: [] }));

async function setup(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks, nextBefore: null } }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator(".chat-scroll").first()).toBeVisible();
  await expect(page.locator(".boot-cover")).toHaveCount(0);
}

type Point = [x: number, y: number];

/** A touch drag as the page's own listeners see it: pointer events (and touch moves) with a pause between steps. */
async function drag(page: Page, points: Point[], { step = 24, hold = 0 } = {}) {
  await page.evaluate(async ({ points, step, hold }) => {
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const target = document.elementFromPoint(...points[0])!;
    const fire = (type: string, [x, y]: Point) => target.dispatchEvent(new PointerEvent(type, { pointerId: 41, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
    fire("pointerdown", points[0]);
    for (const point of points.slice(1)) { await wait(step); fire("pointermove", point); }
    if (hold) await wait(hold);
    fire("pointerup", points.at(-1)!);
  }, { points, step, hold });
}

/** Holds the finger mid-drag and returns what is on screen then. */
async function midway(page: Page, points: Point[]) {
  await page.evaluate(async points => {
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const target = document.elementFromPoint(...points[0])!;
    (window as any).heldTarget = target;
    const fire = (type: string, [x, y]: Point) => target.dispatchEvent(new PointerEvent(type, { pointerId: 42, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
    fire("pointerdown", points[0]);
    for (const point of points.slice(1)) { await wait(24); fire("pointermove", point); }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, points);
  return page.evaluate(() => ({
    right: document.querySelector(".sidebar")!.getBoundingClientRect().right,
    scrim: Number(getComputedStyle(document.querySelector(".mobile-menu-backdrop")!).opacity),
    swiping: document.querySelector(".sidebar")!.classList.contains("swiping"),
  }));
}
async function letGo(page: Page, point: Point, hold = 150) {
  await page.evaluate(async ({ point: [x, y], hold }) => {
    await new Promise(r => setTimeout(r, hold));
    (window as any).heldTarget.dispatchEvent(new PointerEvent("pointerup", { pointerId: 42, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
  }, { point, hold });
}

const nav = (page: Page) => page.getByRole("dialog", { name: "导航" });
const settledOpen = async (page: Page) => {
  await expect(nav(page)).toBeVisible();
  await expect.poll(() => page.locator(".sidebar").evaluate(n => Math.round(n.getBoundingClientRect().x))).toBe(0);
  await expect.poll(() => page.locator(".sidebar").evaluate(n => n.style.transform)).toBe("");
};
const closed = async (page: Page) => {
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".mobile-menu-backdrop")).toHaveCount(0);
};

test.describe("phones", () => {
  test.skip(({ isMobile }) => !isMobile, "phone layout only");

  test("a drag from the left edge pulls the drawer out under the finger", async ({ page }, info) => {
    await setup(page);
    const y = 500;
    const seen = await midway(page, [[6, y], [30, y], [70, y], [110, y], [150, y]]);
    // The drawer's edge is at the finger (the closed position is -102%, so within a few px), the scrim part-way in.
    expect(seen.swiping).toBe(true);
    expect(Math.abs(seen.right - 150)).toBeLessThan(16);
    expect(seen.scrim).toBeGreaterThan(0.3);
    expect(seen.scrim).toBeLessThan(0.7);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/${info.project.name}-pull-midway.png` });
    // Moving back follows too.
    await page.evaluate(() => (window as any).heldTarget.dispatchEvent(new PointerEvent("pointermove", { pointerId: 42, pointerType: "touch", isPrimary: true, clientX: 200, clientY: 500, bubbles: true })));
    await expect.poll(() => page.locator(".sidebar").evaluate(n => Math.round(n.getBoundingClientRect().right))).toBeGreaterThan(180);
    await letGo(page, [200, y]);
    await settledOpen(page);
    await page.screenshot({ path: `${evidence}/${info.project.name}-pull-open.png` });
    // Opened by a finger, it still closes with its own motion and gives focus back.
    await page.getByRole("button", { name: "关闭导航" }).click();
    await closed(page);
    await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  });

  test("a short pull springs back, a flick opens", async ({ page }) => {
    await setup(page);
    await drag(page, [[8, 400], [30, 400], [60, 400], [80, 400]], { hold: 150 });
    await closed(page);
    await expect(page.getByRole("button", { name: "打开导航" })).not.toBeFocused();
    // 25% of the drawer, but fast.
    await drag(page, [[8, 400], [30, 400], [55, 400], [85, 400]], { step: 12 });
    await settledOpen(page);
  });

  test("dragging the open drawer or its scrim left pushes it shut", async ({ page }, info) => {
    await setup(page);
    await page.getByRole("button", { name: "打开导航" }).click();
    await settledOpen(page);
    const seen = await midway(page, [[260, 450], [240, 450], [200, 450], [160, 450]]);
    expect(seen.swiping).toBe(true);
    // 100px of 300 pushed back (-102% when shut).
    expect(Math.abs(seen.right - 300 + 100 * 1.02)).toBeLessThan(16);
    await page.screenshot({ path: `${evidence}/${info.project.name}-push-midway.png` });
    // Let go at a third: back open, and the row under the finger was not clicked.
    await letGo(page, [160, 450]);
    await settledOpen(page);
    await expect(page.locator(".sidebar button.active")).toHaveText("主会话");
    await drag(page, [[260, 450], [230, 450], [180, 450], [120, 450], [80, 450]], { hold: 150 });
    await closed(page);
    // From the scrim.
    await page.getByRole("button", { name: "打开导航" }).click();
    await settledOpen(page);
    await drag(page, [[370, 300], [350, 300], [300, 300], [220, 300]], { hold: 150 });
    await closed(page);
  });

  test("vertical moves, sheets and drags away from the edge leave the page alone", async ({ page }) => {
    await setup(page);
    await drag(page, [[8, 600], [10, 580], [12, 520], [14, 420]], { hold: 50 });
    await drag(page, [[60, 500], [100, 500], [160, 500], [220, 500]], { hold: 50 });
    await page.evaluate(() => { const sheet = document.createElement("div"); sheet.setAttribute("aria-modal", "true"); sheet.id = "fake-sheet"; document.body.append(sheet); });
    await drag(page, [[8, 500], [60, 500], [120, 500], [200, 500]], { hold: 50 });
    await page.evaluate(() => document.getElementById("fake-sheet")!.remove());
    // Something at the edge with its own gestures (a zoomable picture, a remote screen).
    await page.evaluate(() => { const own = document.createElement("div"); own.style.cssText = "position:fixed;left:0;top:300px;width:120px;height:120px;touch-action:none;z-index:50"; own.id = "own-gestures"; document.body.append(own); });
    await drag(page, [[8, 350], [60, 350], [120, 350], [200, 350]], { hold: 50 });
    await page.waitForTimeout(350);
    await closed(page);
  });

  test.describe("360 wide", () => {
    test.use({ viewport: { width: 360, height: 780 } });
    test("the pull follows the finger on a narrow phone", async ({ page }, info) => {
      await setup(page);
      const seen = await midway(page, [[6, 450], [40, 450], [90, 450], [130, 450]]);
      expect(Math.abs(seen.right - 130)).toBeLessThan(16);
      await page.screenshot({ path: `${evidence}/${info.project.name}-360-pull-midway.png` });
      await letGo(page, [130, 450]);
      await settledOpen(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    });
  });
});

test.describe("real touches", () => {
  test.skip(({ browserName, isMobile }) => browserName !== "chromium" || !isMobile, "CDP touch input");

  /** Touches through the browser's own input pipeline, where its panning can take a drag over. */
  async function touch(page: Page, points: Point[], step = 16) {
    const cdp = await page.context().newCDPSession(page);
    const at = ([x, y]: Point) => [{ x, y, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(points[0]) });
    for (const point of points.slice(1)) { await page.waitForTimeout(step); await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(point) }); }
    await page.waitForTimeout(150);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  test("an edge pull is not lost to panning, and a vertical swipe at the edge still scrolls", async ({ page }) => {
    await setup(page);
    const feed = page.locator(".chat-scroll").first();
    const before = await feed.evaluate(n => n.scrollTop);
    await touch(page, [[8, 250], [9, 300], [10, 400], [10, 500], [10, 600], [10, 700]]);
    await expect.poll(() => feed.evaluate(n => n.scrollTop)).not.toBe(before);
    await closed(page);
    await touch(page, [[6, 500], [16, 501], [60, 502], [120, 503], [180, 504], [220, 504]]);
    await settledOpen(page);
    await touch(page, [[250, 400], [240, 400], [200, 400], [140, 400], [90, 400], [60, 400]]);
    await closed(page);
  });
});

test("desktop ignores touches at the edge", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop layout");
  await setup(page);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  await drag(page, [[8, 500], [60, 500], [120, 500], [200, 500]], { hold: 50 });
  await expect(sidebar).not.toHaveClass(/swiping/);
  expect(await sidebar.evaluate(n => n.getAttribute("style"))).toBeNull();
  await expect(page.locator(".mobile-menu-backdrop")).toHaveCount(0);
});
