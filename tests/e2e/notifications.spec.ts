import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

// Phone notifications (public/sw.js and main.tsx): none while the console is on screen, and opening
// the console clears the ones already there. Pushes are delivered to the worker through DevTools.
// The new headless Chromium: the old headless shell refuses notifications whatever is granted.
test.use({ serviceWorkers: "allow", channel: "chromium" });

test("no notification while the console is on screen, and opening it clears the rest", async ({ page, context, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "pushes are delivered through Chromium DevTools");
  await context.grantPermissions(["notifications"], { origin: new URL(baseURL!).origin });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  // DevTools from a page of another origin, which stays open while the console closes.
  const devtoolsPage = await context.newPage();
  const cdp = await context.newCDPSession(devtoolsPage);
  const registration = new Promise<string>((resolve) => cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    const found = registrations.find((r: { scopeURL: string; isDeleted: boolean }) => !r.isDeleted && r.scopeURL.startsWith(baseURL!));
    if (found) resolve(found.registrationId);
  }));
  await cdp.send("ServiceWorker.enable");
  const registrationId = await registration;
  const origin = new URL(baseURL!).origin;
  const push = (title: string) => cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: JSON.stringify({ title, body: "", tag: title }) });
  const worker = context.serviceWorkers().find((w) => w.url().startsWith(origin)) ?? await context.waitForEvent("serviceworker");
  // The worker's own globals, which this file's DOM types do not describe.
  type Scope = { registration: ServiceWorkerRegistration; clients: { matchAll(o: object): Promise<{ url: string }[]> }; location: Location };
  const shown = () => worker.evaluate(async () => (await (self as unknown as Scope).registration.getNotifications()).map((n: Notification) => n.title));

  // Pushes go only to an activated worker (the first opening also fills its cache while installing).
  await expect.poll(() => worker.evaluate(() => (self as unknown as Scope).registration.active?.state)).toBe("activated");
  await push("while open");
  await page.close();
  // The worker learns of the closed page a moment later.
  await expect.poll(() => worker.evaluate(async () => (await (self as unknown as Scope).clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((client) => new URL(client.url).origin === (self as unknown as Scope).location.origin).length)).toBe(0);
  await push("while closed");
  // Pushes are handled in order: the first one was dropped, not just late.
  await expect.poll(shown).toEqual(["while closed"]);

  const reopened = await context.newPage();
  await mockConsole(reopened, { conversations: [] });
  await reopened.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await reopened.goto("/");
  await expect.poll(shown).toEqual([]);
});
