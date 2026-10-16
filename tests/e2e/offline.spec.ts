import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// The service worker (src/ui/public/sw.js) keeps the console openable without a network:
// online it is always the deployed page, offline the last one that loaded, which says it
// cannot reach the server and reloads itself once it can.
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

test("opens offline from the saved console, and online always from the server", async ({ page, context }) => {
  const net = await setup(page);
  // An old copy in the cache: online, the page still comes from the server, which also replaces the copy.
  await page.evaluate(async () => {
    const cache = await caches.open("aio-console-v1");
    await cache.put("/", new Response('<!doctype html><body data-deploy="old">old</body>', { headers: { "content-type": "text/html" } }));
  });
  await page.reload();
  await expect(inbox(page)).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-deploy", "old");
  await expect.poll(() => page.evaluate(async () => (await (await caches.match("/"))!.text()).includes('data-deploy="old"'))).toBe(false);

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
