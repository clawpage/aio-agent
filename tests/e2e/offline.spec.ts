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
  await (await caches.open("aio-console-v3")).put("/", new Response(html, { headers: { "content-type": "text/html" } }));
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

test("a saved page whose build is gone is replaced and reloaded by itself", async ({ page }) => {
  await setup(page);
  // An older deploy saved, whose stylesheet the server no longer has: it answers with the sheet that
  // hides the page and asks to reload (src/ui/edge.mjs), which reloading alone would show again.
  await page.evaluate(async () => {
    const html = (await (await fetch("/", { cache: "no-store" })).text()).replace("<html", '<html data-deploy="old"').replace(/\/assets\/index-[^"]+\.css/, "/assets/index-GONE.css");
    const cache = await caches.open("aio-console-v3");
    await cache.put("/", new Response(html, { headers: { "content-type": "text/html" } }));
    await cache.put("/assets/index-GONE.css", new Response("html { --aio-stale: 1; } body > * { display: none !important; }", { headers: { "content-type": "text/css" } }));
  });
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-deploy", "old");
  await expect(inbox(page)).toBeVisible();
});

test("the start guard keeps the saved page current where the worker does not", async ({ page }) => {
  await setup(page);
  // The cache of an older worker that is still the active one (Safari kept it so, its page request pending for good).
  const saved = () => page.evaluate(async () => (await (await (await caches.open("aio-console-v1")).match("/"))!.text()).includes('data-deploy="old"'));
  await page.evaluate(async () => {
    const html = (await (await fetch("/", { cache: "no-store" })).text()).replace("<html", '<html data-deploy="old"');
    await (await caches.open("aio-console-v1")).put("/", new Response(html, { headers: { "content-type": "text/html" } }));
  });
  expect(await saved()).toBe(true);
  await page.reload();
  await expect(inbox(page)).toBeVisible();
  await expect.poll(saved, { timeout: 15_000 }).toBe(false);
});
