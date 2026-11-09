import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

const appScript = (url: URL) => /^\/assets\/index-[^/]+\.js$/.test(url.pathname);

test("an app script lost on the way is loaded again, and the console opens", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  let failed = 0;
  await page.route(appScript, (r) => (failed++ === 0 ? r.abort("connectionreset") : r.continue()));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible({ timeout: 20_000 });
  expect(failed).toBeGreaterThanOrEqual(2);
});

test("an app script that never arrives ends in words and a way to try again, not an endless splash", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  let asked = 0;
  await page.route(appScript, (r) => { asked++; return r.abort("connectionreset"); });
  await page.goto("/");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("页面没能加载完成", { timeout: 20_000 });
  await expect(alert).toContainText(/script not loaded: index-.*\.js/);
  // Loaded three times in all: as opened, again, and again without the saved copies.
  expect(asked).toBe(3);
  await page.screenshot({ path: info.outputPath("boot-failed.png") });
  await page.unroute(appScript);
  await alert.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "页面没能加载完成" })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("#root")).not.toBeEmpty();
});
