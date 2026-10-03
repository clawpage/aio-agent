import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** The desktop frame's geometry: on a phone 1.6 times the box's width, panned by scrolling the box. */
async function desktopGeometry(frame: import("@playwright/test").Locator) {
  return frame.evaluate((el) => ({ box: el.clientWidth, frame: el.querySelector("iframe")!.getBoundingClientRect().width, scroll: el.scrollWidth }));
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
  await expect(dock.getByRole("tab")).toHaveCount(7);
  await expect(dock.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
  await expect(desk.locator(".menubar-app")).toHaveText("浏览器");
  await expect(desk.locator(".window-title")).toHaveText("浏览器");
  await expect(desk.locator(".window iframe")).toBeVisible();
  // On a phone the browser desktop is drawn 1.6 times the width and pans; on a wide screen it fits.
  const frame = desk.locator(".desktop-frame");
  const geometry = await desktopGeometry(frame);
  if (mobile) {
    expect(Math.abs(geometry.frame - geometry.box * 1.6)).toBeLessThan(2);
    expect(geometry.scroll).toBeGreaterThan(geometry.box * 1.5);
    // It opens on the middle of the desktop, not its left edge.
    expect(Math.abs((await frame.evaluate((el) => el.scrollLeft)) - (geometry.scroll - geometry.box) / 2)).toBeLessThan(2);
    await frame.evaluate((el) => { el.scrollLeft = 150; });
    expect(await frame.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    // A finger on the black strip pans sideways only; a vertical swipe moves neither the view nor the page.
    // (Touch gestures are synthesised through Chromium's CDP; WebKit checks the layout only.)
    const strip = page.getByRole("toolbar", { name: "桌面操作" });
    const cdp = info.project.name === "mobile-webkit" ? null : await page.context().newCDPSession(page);
    const swipe = cdp && (async (xDistance: number, yDistance: number) => {
      const at = (await strip.boundingBox())!;
      await cdp.send("Input.synthesizeScrollGesture", { x: at.x + at.width / 2, y: at.y + at.height / 2, xDistance, yDistance, gestureSourceType: "touch", speed: 1200 });
    });
    const at = () => frame.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop, page: document.scrollingElement!.scrollTop }));
    if (swipe) {
      const before = await at();
      await swipe(0, -300);
      expect(await at()).toEqual(before);
      await swipe(-120, 0);
      expect((await at()).left).toBeGreaterThan(before.left + 60);
    }
    // Too short for the zoomed picture (an open keyboard, a short panel), it shrinks to fit the height instead
    // of growing a vertical scroll, and the whole picture stays above the toolbar.
    await page.setViewportSize({ width: 390, height: 520 });
    await expect.poll(() => frame.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
    const fit = await frame.evaluate((el) => {
      const pic = el.querySelector("iframe")!.getBoundingClientRect(), bar = el.querySelector(".desktop-bar")!.getBoundingClientRect();
      return { top: pic.top - el.getBoundingClientRect().top, gap: bar.top - pic.bottom, width: pic.width, fitted: Math.min(el.clientWidth * 1.6, (el.clientHeight - 52) * 1.25) };
    });
    expect(fit.top).toBeGreaterThanOrEqual(0);
    expect(fit.gap).toBeGreaterThanOrEqual(-1);
    expect(Math.abs(fit.width - fit.fitted)).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath("desktop-browser-short.png") });
    if (swipe) {
      const short = await at();
      await swipe(0, -300);
      expect(await at()).toEqual(short);
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
  await expect(desk.locator(".desktop-icon")).toHaveCount(7);
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
  await expect(desk.locator(".desktop-icon")).toHaveCount(7);
  await dock.getByRole("tab", { name: "浏览器" }).click();
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
