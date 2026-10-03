import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** The desktop frame's geometry: on a phone twice the box's width, panned by scrolling the box. */
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
  // On a phone the browser desktop is drawn twice the width and pans; on a wide screen it fits.
  const frame = desk.locator(".desktop-frame");
  const geometry = await desktopGeometry(frame);
  if (mobile) {
    expect(Math.abs(geometry.frame - geometry.box * 2)).toBeLessThan(2);
    expect(geometry.scroll).toBeGreaterThan(geometry.box * 1.9);
    await frame.evaluate((el) => { el.scrollLeft = 150; });
    expect(await frame.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
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
