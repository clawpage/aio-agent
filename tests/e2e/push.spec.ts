import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// Browsers cannot reach a real push service here: the browser push APIs are stubbed,
// and the test checks what the console does with them and what it sends the server.
type Calls = { pushCalls: string[] };

async function setup(page: Page) {
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
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  const bodies: Record<string, unknown> = {};
  await page.route("**/api/push", (r) => r.fulfill({ json: { supported: true, publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", devices: 0 } }));
  await page.route("**/api/push/*", (r) => {
    bodies[new URL(r.request().url()).pathname.split("/").at(-1)!] = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, devices: 1 } });
  });
  return bodies;
}

test("the configuration page has one switch for phone notifications", async ({ page }, info) => {
  const bodies = await setup(page);
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  const card = page.getByRole("region", { name: "手机通知" });
  const toggle = card.getByRole("checkbox");
  await expect(card).toContainText("已关闭");
  await expect(card.getByRole("button")).toHaveCount(0);
  await toggle.click();
  await expect(card).toContainText("已开启");
  await expect(toggle).toBeChecked();
  await card.screenshot({ path: info.outputPath("push-settings.png") });
  // Permission comes first, straight from the tap; then the worker, then the subscription.
  // (The first registration is the console's own, at load: the same worker keeps it openable offline.)
  expect(await page.evaluate(() => (window as unknown as Calls).pushCalls)).toEqual(["register:/sw.js", "permission", "register:/sw.js", "subscribe:65"]);
  expect(bodies.subscribe).toEqual({ subscription: { endpoint: "https://web.push.apple.com/fake", keys: { p256dh: "p", auth: "a" } } });
  await toggle.click();
  await expect(card).toContainText("已关闭");
  expect(bodies.unsubscribe).toEqual({ endpoint: "https://web.push.apple.com/fake" });
});

test("after the first message the console offers phone notifications, once", async ({ page }, info) => {
  const bodies = await setup(page);
  await page.route("**/api/tasks", async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    const task = { id: "task-1", revision: 1, title: String(body.text), text: body.text, conversationId: "c-1", status: "planning", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now(), completedAt: null, clientMessageId: body.clientMessageId };
    await r.fulfill({ status: 202, json: { task, duplicate: false } });
  });
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  const nudge = page.locator(".push-nudge");
  await expect(nudge).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("帮我查天气");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(nudge).toContainText("开启手机通知");
  await page.screenshot({ path: info.outputPath("push-nudge.png") });
  await nudge.getByRole("button", { name: "开启", exact: true }).click();
  await expect(nudge).toHaveCount(0);
  expect(bodies.subscribe).toBeTruthy();
  // Answered on this device: a reload and another message do not ask again.
  await page.reload();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("再查一次");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("再查一次").first()).toBeVisible();
  await expect(nudge).toHaveCount(0);
});

// The iOS app's web view has no Web Push: the console asks the app (window.webkit.messageHandlers.aioPush,
// DeviceBrowser.swift), which answers with `aio-push` events. The bridge is played here, with the
// permission the system would hold.
async function setupApp(page: Page, opts: { permission: "default" | "granted" | "denied"; apns?: boolean }) {
  await page.addInitScript((initial) => {
    const calls: string[] = [];
    (window as unknown as { pushCalls: string[] }).pushCalls = calls;
    let permission = initial;
    const answer = (detail: object) => setTimeout(() => window.dispatchEvent(new CustomEvent("aio-push", { detail })), 20);
    const granted = () => ({ permission: "granted", token: "ab".repeat(32), environment: "production" });
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioPush: { postMessage: (action: string) => {
      calls.push(action);
      if (action === "enable" && permission === "default") permission = "granted";
      if (action !== "settings") answer(permission === "granted" ? granted() : { permission });
    } } } };
  }, opts.permission);
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  const bodies: Record<string, unknown> = {};
  let subscribed = false;
  await page.route(/\/api\/push(\?.*)?$/, (r) => r.fulfill({ json: { supported: true, publicKey: "k", apns: opts.apns ?? true, devices: subscribed ? 1 : 0, subscribed } }));
  await page.route("**/api/push/*", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").at(-1)!;
    bodies[name] = r.request().postDataJSON();
    subscribed = name === "subscribe";
    return r.fulfill({ json: { ok: true, devices: subscribed ? 1 : 0, endpoint: `apns:production:${"ab".repeat(32)}` } });
  });
  const presence: unknown[] = [];
  await page.route("**/api/presence", (r) => { presence.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); });
  return { bodies, presence };
}

async function openSettings(page: Page, mobile: boolean) {
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  return page.getByRole("region", { name: "手机通知" });
}

test("in the iOS app the switch asks the app, and the server gets the device token", async ({ page }, info) => {
  const { bodies, presence } = await setupApp(page, { permission: "default" });
  const card = await openSettings(page, info.project.name.startsWith("mobile"));
  const toggle = card.getByRole("checkbox");
  await expect(card).toContainText("已关闭");
  await toggle.click();
  await expect(card).toContainText("已开启");
  expect(bodies.subscribe).toEqual({ apns: { token: "ab".repeat(32), environment: "production" } });
  expect(await page.evaluate(() => (window as unknown as Calls).pushCalls)).toContain("enable");
  await card.screenshot({ path: info.outputPath("push-app-settings.png") });
  // The console on screen names this device (in its next presence beat, every 20 s), so its own notifications wait while it is open.
  await expect.poll(() => presence.some((body) => (body as { endpoint?: string }).endpoint === `apns:production:${"ab".repeat(32)}`), { timeout: 45_000 }).toBe(true);
  await toggle.click();
  await expect(card).toContainText("已关闭");
  expect(bodies.unsubscribe).toEqual({ endpoint: `apns:production:${"ab".repeat(32)}` });
});

test("in the iOS app a refusal points to the app's page in Settings", async ({ page }, info) => {
  await setupApp(page, { permission: "denied" });
  const card = await openSettings(page, info.project.name.startsWith("mobile"));
  await expect(card).toContainText("通知已被拒绝");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await card.getByRole("button", { name: "去设置开启" }).click();
  expect(await page.evaluate(() => (window as unknown as Calls).pushCalls)).toContain("settings");
  await card.screenshot({ path: info.outputPath("push-app-denied.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("in the iOS app the nudge after the first message turns notifications on", async ({ page }) => {
  const { bodies } = await setupApp(page, { permission: "default" });
  await page.route("**/api/tasks", async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    const task = { id: "task-1", revision: 1, title: String(body.text), text: body.text, conversationId: "c-1", status: "planning", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now(), completedAt: null, clientMessageId: body.clientMessageId };
    await r.fulfill({ status: 202, json: { task, duplicate: false } });
  });
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("帮我查天气");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const nudge = page.locator(".push-nudge");
  await expect(nudge).toContainText("开启手机通知");
  await nudge.getByRole("button", { name: "开启", exact: true }).click();
  await expect(nudge).toHaveCount(0);
  expect(bodies.subscribe).toEqual({ apns: { token: "ab".repeat(32), environment: "production" } });
});

test("in the iOS app nothing is offered until the deployment can reach the app", async ({ page }, info) => {
  await setupApp(page, { permission: "default", apns: false });
  const card = await openSettings(page, info.project.name.startsWith("mobile"));
  await expect(page.getByRole("heading", { name: "配置" }).first()).toBeVisible();
  await expect(card).toHaveCount(0);
});
