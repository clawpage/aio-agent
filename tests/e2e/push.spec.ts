import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

// Browsers cannot reach a real push service here: the browser push APIs are stubbed,
// and the test checks what the console does with them and what it sends the server.
test("turns phone notifications on, tests and turns them off", async ({ page }, info) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { pushCalls: string[] }).pushCalls = calls;
    let current: { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> } | null = null;
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async (opts: { applicationServerKey: ArrayBuffer }) => {
        calls.push(`subscribe:${opts.applicationServerKey.byteLength}`);
        current = { endpoint: "https://web.push.apple.com/fake", toJSON: () => ({ endpoint: "https://web.push.apple.com/fake", keys: { p256dh: "p", auth: "a" } }), unsubscribe: async () => { current = null; calls.push("unsubscribe"); return true; } };
        return current;
      },
    };
    const registration = { pushManager };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      register: async (url: string) => { calls.push(`register:${url}`); return registration; },
      getRegistration: async () => (calls.some((c) => c.startsWith("register")) ? registration : undefined),
      ready: Promise.resolve(registration),
    } });
    (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
    let permission = "default";
    (window as unknown as { Notification: unknown }).Notification = Object.assign(function Notification() {}, {
      get permission() { return permission; },
      requestPermission: async () => { calls.push("permission"); permission = "granted"; return "granted"; },
    });
  });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  const bodies: Record<string, unknown> = {};
  await page.route("**/api/push", (r) => r.fulfill({ json: { supported: true, publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", devices: 0 } }));
  await page.route("**/api/push/*", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").at(-1)!;
    bodies[name] = r.request().postDataJSON();
    return r.fulfill({ json: name === "test" ? { sent: 1 } : { ok: true, devices: 1 } });
  });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  const control = page.locator(".sidebar").getByRole("button", { name: "开启手机通知" });
  await control.click();
  await expect(page.locator(".sidebar")).toContainText("手机通知已开启");
  // Permission comes first, straight from the tap; then the worker, then the subscription.
  expect(await page.evaluate(() => (window as unknown as { pushCalls: string[] }).pushCalls)).toEqual(["permission", "register:/sw.js", "subscribe:65"]);
  expect(bodies.subscribe).toEqual({ subscription: { endpoint: "https://web.push.apple.com/fake", keys: { p256dh: "p", auth: "a" } } });
  await page.locator(".sidebar").getByRole("button", { name: "测试", exact: true }).click();
  await expect(page.locator(".sidebar")).toContainText("测试通知已发出");
  await page.locator(".sidebar").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".sidebar").getByRole("button", { name: "开启手机通知" })).toBeVisible();
  expect(bodies.unsubscribe).toEqual({ endpoint: "https://web.push.apple.com/fake" });
});
