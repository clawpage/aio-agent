import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

// The UI and the control plane deploy separately: a page that no longer fits the
// server it talks to says so above everything instead of half-working.
test("tells the person when the console and the service versions do not fit", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/version", (r) => r.fulfill({ json: { component: "control", version: "9.0.0", api: 3, apiMin: 2 } }));
  await page.goto("/");
  const banner = page.locator(".version-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("界面与服务版本不兼容");
  await expect(banner).toContainText("界面需要接口 v1，服务提供 v2–v3");
  await expect(banner).toContainText("需要更新界面");
  // Above the console, not pushing it around.
  const box = await banner.boundingBox();
  expect(box!.y).toBeLessThan(40);
});

test("says nothing when they fit, or when the service is too old to tell", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  let asked = false;
  await page.route("**/api/version", (r) => ((asked = true), r.fulfill({ json: { component: "control", version: "0.2.0", api: 1, apiMin: 1 } })));
  await page.goto("/");
  await expect(page.locator(".main")).toBeVisible();
  await expect.poll(() => asked).toBe(true);
  await expect(page.locator(".version-banner")).toHaveCount(0);
  await page.unroute("**/api/version");
  await page.reload();
  await expect(page.locator(".main")).toBeVisible();
  await expect(page.locator(".version-banner")).toHaveCount(0);
});
