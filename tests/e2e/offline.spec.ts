import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import { API_VERSION } from "../../src/common/version";

// The service worker (src/ui/public/sw.js) opens the console from the last page that loaded,
// fast and without a network, and keeps the deployed one for the next opening; offline the
// console says it cannot reach the server and reloads itself once it can.
test.use({ serviceWorkers: "allow" });

const inbox = (page: Page) => page.getByRole("heading", { name: "主会话", exact: true });

async function setup(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  const net = { down: false };
  // Registered last, so it runs first: with the network down every API call fails like a real one.
  await page.route("**/api/**", (r) => (net.down ? r.abort("internetdisconnected") : r.fallback()));
  await page.goto("/");
  await expect(inbox(page)).toBeVisible();
  await expect.poll(() => page.evaluate(async () => Boolean(navigator.serviceWorker.controller && (await caches.match("/"))))).toBe(true);
  return net;
}

/** Puts an older deploy of the console (the same page, marked) where the worker opens it from. */
const saveOlderPage = (page: Page) => page.evaluate(async () => {
  const html = (await (await fetch("/", { cache: "no-store" })).text()).replace("<html", '<html data-deploy="old"');
  await (await caches.open("aio-console-v2")).put("/", new Response(html, { headers: { "content-type": "text/html" } }));
});
const savedIsOlder = (page: Page) => page.evaluate(async () => (await (await caches.match("/"))!.text()).includes('data-deploy="old"'));

test("opens from the saved console at once, keeps the deployed one for next time, and opens offline", async ({ page, context }) => {
  const net = await setup(page);
  // An older deploy saved: it opens without waiting on the server, which replaces the copy behind it.
  await saveOlderPage(page);
  await page.reload();
  await expect(inbox(page)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-deploy", "old");
  await expect.poll(() => savedIsOlder(page)).toBe(false);
  await page.reload();
  await expect(inbox(page)).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-deploy", "old");

  net.down = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "现在连不上一站" })).toBeVisible();
  await expect(page.getByText("这台设备没有联网。联网后会自动打开。")).toBeVisible();
  // No sign-in form stands in for a session that could not be checked.
  await expect(page.getByPlaceholder("请输入访问密码")).toHaveCount(0);

  net.down = false;
  await context.setOffline(false);
  await expect(inbox(page)).toBeVisible();
});

test("a server that cannot be reached is not a sign-out, and retrying opens the console", async ({ page }) => {
  const net = await setup(page);
  net.down = true;
  await page.reload();
  await expect(page.getByText("暂时连不上服务器，恢复后会自动打开。")).toBeVisible();
  await expect(page.getByPlaceholder("请输入访问密码")).toHaveCount(0);
  net.down = false;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(inbox(page)).toBeVisible();
});

test("a saved console the service has moved past is dropped for the deployed one, once", async ({ page }) => {
  await setup(page);
  await saveOlderPage(page);
  // The service no longer speaks this console's API: the saved page cannot be used.
  await page.route("**/api/version", (r) => r.fulfill({ json: { component: "control", version: "9.0.0", api: API_VERSION + 2, apiMin: API_VERSION + 1 } }));
  await page.reload();
  // Dropped and loaded from the server; this test's deployed page is just as old, so it then says so instead of reloading on.
  await expect(page.locator(".version-banner")).toContainText("需要更新界面");
  await expect(page.locator("html")).not.toHaveAttribute("data-deploy", "old");
});
