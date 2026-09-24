import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * Browser lifecycle in the workspace panel.
 *
 * The panel is the only thing that keeps Chromium awake for a human, so these
 * specs assert the *observable* contract against a fully mocked control plane:
 * a visible browser panel claims a viewer lease, hiding the panel or the whole
 * document releases it, a released browser shows an honest restore affordance
 * instead of a dead frame, and a manual pin keeps it running.
 *
 * Everything is mocked, so this never touches a deployment and never stops a
 * real browser; the container-side behaviour is owned by the runtime tests.
 */

const CONV_ID = "conv_e2e_browser_lifecycle";

function replayOnly(): string {
  return `retry: 3000\n\nevent: replay.complete\ndata: ${JSON.stringify({ lastEventId: 0, replayed: 0 })}\n\n`;
}

test.describe("browser lifecycle panel", () => {
  test("a visible browser panel claims a viewer lease and shows the status bar", async ({ page, isMobile }) => {
    test.skip(isMobile, "the workspace overlay is desktop-first here; the mobile project covers layout only");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: {},
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();

    // The browser tab is the default; the lifecycle bar appears with it.
    const bar = page.locator(".browser-status");
    await expect(bar).toBeVisible({ timeout: 20_000 });
    await expect(bar).toContainText("浏览器已就绪");
    await expect(bar).toContainText("本窗口观看中");
  });

  test("switching away from the browser tab releases the viewer lease", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop keyboard/mouse tab switching");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: {},
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();
    await expect(page.locator(".browser-status")).toBeVisible({ timeout: 20_000 });

    // Leaving the browser tab unmounts the frame and drops the lease, so the bar
    // (which only describes the browser panel) goes with it.
    await page.getByRole("tab", { name: "终端" }).click();
    await expect(page.locator(".browser-status")).toHaveCount(0);
  });

  test("a released browser offers an honest restore action instead of a dead frame", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only restore affordance");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: { startAsleep: true },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();

    // The frame is replaced by an explicit restore prompt, never a blank page.
    await expect(page.getByRole("button", { name: "启动并恢复浏览器" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".workspace iframe")).toHaveCount(0);

    await page.getByRole("button", { name: "启动并恢复浏览器" }).click();
    // After the mocked wake the panel mounts the frame again.
    await expect(page.locator(".workspace iframe")).toBeVisible({ timeout: 20_000 });
  });

  test("manual keep-alive pin is reflected in the status bar", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only control");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: {},
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();
    const bar = page.locator(".browser-status");
    await expect(bar).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "保留浏览器" }).click();
    await expect(page.getByRole("button", { name: "取消保留" })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("browser lifecycle panel responsiveness", () => {
  test("the status bar fits 1440, 390 and 360 without horizontal overflow", async ({ page, isMobile }) => {
    test.skip(isMobile, "this spec drives its own viewports from the desktop project");
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [360, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await mockConsole(page, {
        conversations: [makeConversation(`${CONV_ID}_${width}`, "浏览器生命周期")],
        sse: { [`${CONV_ID}_${width}`]: replayOnly() },
        browser: {},
      });

      await page.goto("/");
      await page.getByRole("button", { name: "工作区" }).first().click();
      // The workspace is an overlay on mobile; assert the bar itself never
      // overflows whatever width the workspace actually has.
      const bar = page.locator(".browser-status");
      await expect(bar).toBeVisible({ timeout: 20_000 });
      const box = (await bar.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(width + 1);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
  });
});
