import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** Where the desktop's picture sits in its frame (on a phone it is zoomed and panned by the console's gestures). */
async function desktopGeometry(frame: import("@playwright/test").Locator) {
  return frame.evaluate((el) => {
    const box = el.getBoundingClientRect(), pic = el.querySelector("iframe")!.getBoundingClientRect();
    return { box: box.width, frame: pic.width, left: pic.left - box.left, top: pic.top - box.top, scroll: el.scrollWidth - el.clientWidth };
  });
}

test("the workspace is a desktop: a menu bar, one app window, a Dock, and minimizing back to the desktop", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/workspace/ticket", (r) => {
    const path = r.request().postDataJSON().next;
    return r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: `http://127.0.0.1:4289${path}`, expiresAt: Date.now() + 60000 } });
  });
  await page.route("http://127.0.0.1:4289/**", (r) =>
    r.fulfill({ contentType: "text/html", body: '<html><meta charset="utf-8"><body style="margin:0;background:#fff;font:14px system-ui;padding:16px">沙箱页面</body></html>' }),
  );
  const mobile = info.project.name.startsWith("mobile");
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "工作区", exact: true }).click();

  const desk = page.locator(".workspace.desktop");
  const dock = page.getByRole("tablist", { name: "应用" });
  await expect(desk.locator(".menubar")).toBeVisible();
  await expect(dock.getByRole("tab")).toHaveCount(9);
  await expect(dock.getByRole("tab", { name: "沙盒浏览器" })).toHaveAttribute("aria-selected", "true");
  await expect(desk.locator(".menubar-app")).toHaveText("沙盒浏览器");
  await expect(desk.locator(".window-title")).toHaveText("沙盒浏览器");
  await expect(desk.locator(".window iframe")).toBeVisible();
  // On a phone the browser desktop opens 1.3 times the width, on its middle; on a wide screen it fits.
  const frame = desk.locator(".desktop-frame");
  await expect.poll(() => desk.evaluate(n => n.getAnimations().length)).toBe(0);
  const geometry = await desktopGeometry(frame);
  if (mobile) {
    expect(Math.abs(geometry.frame - geometry.box * 1.3)).toBeLessThan(2);
    expect(Math.abs(geometry.left - (geometry.box - geometry.frame) / 2)).toBeLessThan(2);
    // No strip to scroll sideways any more: the picture itself moves under the fingers.
    expect(geometry.scroll).toBeLessThanOrEqual(1);
    const bar = page.getByRole("toolbar", { name: "桌面操作" });
    await expect(bar).toContainText("双指缩放");
    // (Touch gestures are synthesised through Chromium's CDP; WebKit checks the layout only.)
    const cdp = info.project.name === "mobile-webkit" ? null : await page.context().newCDPSession(page);
    const stage = desk.locator(".remote-touch");
    const centre = async () => { const at = (await stage.boundingBox())!; return { x: at.x + at.width / 2, y: at.y + at.height / 2 }; };
    const pageScroll = () => page.evaluate(() => document.scrollingElement!.scrollTop);
    if (cdp) {
      // One finger sideways pans the zoomed picture; up and down it scrolls the desktop's page, never the console.
      const c = await centre();
      await cdp.send("Input.synthesizeScrollGesture", { x: c.x, y: c.y, xDistance: -120, yDistance: 0, gestureSourceType: "touch", speed: 600 });
      await expect.poll(async () => (await desktopGeometry(frame)).left).toBeLessThan(geometry.left - 40);
      const panned = await desktopGeometry(frame);
      await cdp.send("Input.synthesizeScrollGesture", { x: c.x, y: c.y, xDistance: 0, yDistance: -200, gestureSourceType: "touch", speed: 600 });
      expect((await desktopGeometry(frame)).top).toBeCloseTo(panned.top, 0);
      expect(await pageScroll()).toBe(0);
      // Two fingers pinch the picture larger; a double tap goes back to the whole desktop.
      await cdp.send("Input.synthesizePinchGesture", { x: c.x, y: c.y, scaleFactor: 2, relativeSpeed: 600, gestureSourceType: "touch" });
      await expect.poll(async () => (await desktopGeometry(frame)).frame).toBeGreaterThan(geometry.frame * 1.6);
      await cdp.send("Input.synthesizeTapGesture", { x: c.x, y: c.y, tapCount: 2, gestureSourceType: "touch" });
      await expect.poll(async () => Math.round((await desktopGeometry(frame)).frame)).toBe(Math.round(geometry.box));
      await page.screenshot({ path: info.outputPath("desktop-browser-fitted.png") });
    }
    // A short panel keeps the picture's scale (a keyboard, say), clipped above the toolbar.
    const width = (await desktopGeometry(frame)).frame;
    await page.setViewportSize({ width: 390, height: 520 });
    await expect.poll(async () => (await desktopGeometry(frame)).frame).toBeCloseTo(width, 0);
    const fit = await frame.evaluate((el) => {
      const pic = el.querySelector("iframe")!.getBoundingClientRect(), bar = el.querySelector(".desktop-bar")!.getBoundingClientRect(), box = el.getBoundingClientRect();
      return { top: pic.top - box.top, bottom: bar.bottom - box.bottom, barTop: bar.top - box.top };
    });
    expect(fit.top).toBeGreaterThanOrEqual(-1);
    expect(fit.bottom).toBeLessThanOrEqual(1);
    expect(fit.barTop).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: info.outputPath("desktop-browser-short.png") });
    if (cdp) {
      const c = await centre();
      await cdp.send("Input.synthesizeScrollGesture", { x: c.x, y: c.y, xDistance: 0, yDistance: -300, gestureSourceType: "touch", speed: 600 });
      expect(await pageScroll()).toBe(0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  } else {
    expect(Math.abs(geometry.frame - geometry.box)).toBeLessThan(2);
  }
  await page.screenshot({ path: info.outputPath("desktop-browser.png") });

  // The Dock switches apps in the one window.
  await dock.getByRole("tab", { name: "文件" }).click();
  await expect(desk.locator(".window-title")).toHaveText("文件");
  await expect(dock.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");

  // Minimize: the window goes, the desktop shows its icons, and no app frame stays mounted.
  await dock.getByRole("tab", { name: "编辑器" }).click();
  await expect(desk.locator('iframe[title="编辑器"]')).toBeVisible();
  await desk.getByRole("button", { name: "最小化" }).click();
  await expect(desk.locator(".window")).toHaveCount(0);
  await expect(desk.locator("iframe")).toHaveCount(0);
  await expect(desk.locator(".menubar-app")).toHaveText("桌面");
  await expect(desk.locator(".desktop-icon")).toHaveCount(9);
  await expect(dock.getByRole("tab", { name: "编辑器" })).toHaveAttribute("aria-selected", "false");
  // The app that was open keeps its Dock dot.
  await expect(dock.getByRole("tab", { name: "编辑器" })).toHaveClass(/running/);
  await page.screenshot({ path: info.outputPath("desktop-empty.png") });

  // A desktop icon opens its app again.
  await desk.locator(".desktop-icon", { hasText: "笔记本" }).click();
  await expect(desk.locator(".window-title")).toHaveText("笔记本");
  await expect(desk.locator('iframe[title="笔记本"]')).toBeVisible();

  // Green is full screen: the window takes the screen, the menu bar and Dock step aside.
  await desk.getByRole("button", { name: "全屏" }).click();
  await expect(page.locator(".workspace.fullscreen")).toBeVisible();
  await expect(dock).toBeHidden();
  await desk.getByRole("button", { name: "退出全屏" }).click();
  await expect(dock).toBeVisible();

  // Closing the window also returns to the desktop; closing the workspace removes it.
  await desk.getByRole("button", { name: "关闭窗口" }).click();
  await expect(desk.locator(".desktop-icon")).toHaveCount(9);
  await dock.getByRole("tab", { name: "沙盒浏览器" }).click();
  await expect(desk.locator(".window iframe")).toBeVisible();
  if (mobile) await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const box = (await dock.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: info.outputPath("desktop-final.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: info.outputPath("desktop-dark.png") });
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await expect(page.locator(".workspace")).toHaveCount(0);
});
