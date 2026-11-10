import { expect, test, type Page } from "@playwright/test";
import { mockConsole, openSettingsEntry } from "./mock-api";

type Link = { id: string; name: string; createdAt: number; lastSeenAt: number | null; online: boolean };

/** The control plane's iPhone links (`/api/device-links?kind=ios`), kept in memory. */
async function mockLinks(page: Page, links: Link[], envs = false) {
  const calls: string[] = [];
  await page.route("**/api/device-links**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}${url.search}${req.method() === "POST" ? ` ${req.postData()}` : ""}`);
    if (req.method() === "POST") {
      const link = { id: "dlink_ios", name: (req.postDataJSON() as { name: string }).name, createdAt: Date.now(), lastSeenAt: null, online: false };
      links.unshift(link);
      return route.fulfill({ json: { link, token: `dl_${"t".repeat(43)}` } });
    }
    if (req.method() === "DELETE") {
      links.splice(links.findIndex((l) => l.id === url.pathname.split("/").pop()), 1);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { links: url.searchParams.get("kind") === "ios" ? links : [], envs } });
  });
  return calls;
}

/** The configuration page, and with `entry` its iPhone page (offered inside the app, or once an iPhone is linked). */
async function openSettings(page: Page, mobile: boolean, entry = true) {
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  if (entry) await openSettingsEntry(page, "iPhone 能力");
}

test("inside the iPhone app, each ability is switched on there: iOS asks, the first one links this iPhone, the last one off removes it", async ({ page }, info) => {
  // The app's handler (DeviceTools.swift): records what the console sends and answers with its state.
  // Photos will be allowed for a selection; Reminders were refused in iOS Settings before.
  await page.addInitScript(() => {
    const sent: Array<Record<string, unknown>> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const state = {
      linked: false, linkId: null as string | null, state: "off", name: "Mengxiao's iPhone",
      abilities: { photos: { enabled: false, permission: "notDetermined" }, reminders: { enabled: false, permission: "denied" }, calendar: { enabled: false, permission: "notDetermined" } } as Record<string, { enabled: boolean; permission: string }>,
    };
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioDeviceTools: { postMessage: async (raw: string) => {
      const msg = JSON.parse(raw) as { type: string; ability?: string; token?: string; linkId?: string; account?: string | null };
      sent.push(msg);
      const a = msg.ability ? state.abilities[msg.ability]! : null;
      if (msg.type === "enable" && a) {
        if (a.permission === "notDetermined") a.permission = msg.ability === "photos" ? "limited" : "authorized";
        a.enabled = a.permission === "authorized" || a.permission === "limited";
      }
      if (msg.type === "disable" && a) a.enabled = false;
      if (msg.type === "link") {
        Object.assign(state, { linked: true, linkId: msg.linkId, state: "connecting" });
        setTimeout(() => { state.state = "online"; window.dispatchEvent(new CustomEvent("aio-device-tools", { detail: structuredClone(state) })); }, 50);
      }
      if (msg.type === "unlink") Object.assign(state, { linked: false, linkId: null, state: "off" });
      return JSON.stringify(state);
    } } } };
  });
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, []);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const sent = () => page.evaluate(() => (window as unknown as { __sent: Array<Record<string, unknown>> }).__sent);

  // The console told the app who is signed in, as soon as it knew.
  await expect.poll(sent).toContainEqual({ type: "account", account: "owner" });

  const card = page.getByRole("region", { name: "iPhone 能力" });
  await expect(card).toContainText("只给当前登录的账号");
  const photos = card.getByRole("checkbox", { name: "相册" });
  const reminders = card.getByRole("checkbox", { name: "提醒事项" });
  await expect(photos).not.toBeChecked();
  await expect(card.getByRole("checkbox")).toHaveCount(3);
  // Refused before: shown, with the way to iOS Settings.
  await expect(card).toContainText("系统设置里没有允许");

  // Photos on: iOS asks (a selection here), then this iPhone gets a link of its own, handed to the app.
  await photos.click();
  await expect(photos).toBeChecked();
  await expect(card).toContainText("只允许了部分照片");
  await expect(card).toContainText("已连接");
  expect(calls).toContain(`POST /api/device-links ${JSON.stringify({ name: "Mengxiao's iPhone", kind: "ios" })}`);
  expect(await sent()).toContainEqual({ type: "link", token: `dl_${"t".repeat(43)}`, linkId: "dlink_ios", account: "owner" });
  // This iPhone is not listed again as another one.
  await expect(card.getByRole("button", { name: "移除" })).toHaveCount(0);

  // Reminders stay off while iOS refuses them; the button opens this app's page in iOS Settings.
  await reminders.click();
  await expect(reminders).not.toBeChecked();
  await card.getByRole("button", { name: "去设置开启" }).click();
  await expect.poll(sent).toContainEqual({ type: "settings" });
  await card.screenshot({ path: info.outputPath("iphone-abilities-app.png") });

  // The last ability off: the link goes, here and on the server.
  await photos.click();
  await expect(photos).not.toBeChecked();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_ios");
  await expect.poll(sent).toContainEqual({ type: "unlink" });
  await expect(card).not.toContainText("已连接");
});

test("an app with its own browser has a switch for it: on links this iPhone with nothing else on, off removes it", async ({ page }, info) => {
  // The 0.1.5 app (docs/EXEC-ENVS.md) says its version; the account has the execution environments.
  await page.addInitScript(() => {
    const sent: Array<Record<string, unknown>> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const off = () => ({ photos: { enabled: false, permission: "notDetermined" }, reminders: { enabled: false, permission: "notDetermined" }, calendar: { enabled: false, permission: "notDetermined" } }) as Record<string, { enabled: boolean; permission: string }>;
    const state = { linked: false, linkId: null as string | null, state: "off", name: "Mengxiao's iPhone", app: "0.1.5", abilities: off() };
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioDeviceTools: { postMessage: async (raw: string) => {
      const msg = JSON.parse(raw) as { type: string; ability?: string; linkId?: string };
      sent.push(msg);
      const a = msg.ability ? state.abilities[msg.ability]! : null;
      if (msg.type === "enable" && a) Object.assign(a, { enabled: true, permission: "authorized" });
      if (msg.type === "disable" && a) a.enabled = false;
      if (msg.type === "link") Object.assign(state, { linked: true, linkId: msg.linkId, state: "online" });
      // The app forgets everything with its link (Store.forget).
      if (msg.type === "unlink") Object.assign(state, { linked: false, linkId: null, state: "off", abilities: off() });
      return JSON.stringify(state);
    } } } };
  });
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [], true);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const sent = () => page.evaluate(() => (window as unknown as { __sent: Array<Record<string, unknown>> }).__sent);
  const card = page.getByRole("region", { name: "iPhone 能力" });
  const browser = card.getByRole("checkbox", { name: "浏览器和 App 的文件夹" });
  const calendar = card.getByRole("checkbox", { name: "日历" });
  await expect(card.getByRole("checkbox")).toHaveCount(4);
  await expect(browser).not.toBeChecked();
  await expect(card).toContainText("下单、付款这类操作前会先问你");

  // On, with no ability on: this iPhone is linked, which is all the browser and the folder need.
  await browser.click();
  await expect(browser).toBeChecked();
  await expect(card).toContainText("已连接");
  expect(calls).toContain(`POST /api/device-links ${JSON.stringify({ name: "Mengxiao's iPhone", kind: "ios" })}`);
  expect(await sent()).toContainEqual({ type: "link", token: `dl_${"t".repeat(43)}`, linkId: "dlink_ios", account: "owner" });
  await card.screenshot({ path: info.outputPath("iphone-browser-switch.png") });

  // An ability on and off again: the link stays, for the browser.
  await calendar.click();
  await expect(calendar).toBeChecked();
  await calendar.click();
  await expect(calendar).not.toBeChecked();
  await expect(browser).toBeChecked();
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

  // Off: the link goes, here and on the server, and every ability with it.
  await calendar.click();
  await browser.click();
  await expect(browser).not.toBeChecked();
  await expect(calendar).not.toBeChecked();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_ios");
  await expect.poll(sent).toContainEqual({ type: "unlink" });

  // An ability turned on first links the iPhone, so its browser is on too.
  await calendar.click();
  await expect(calendar).toBeChecked();
  await expect(browser).toBeChecked();
});

for (const [why, app, envs] of [["an older app", "0.1.4", true], ["an account without the environments", "0.1.5", false]] as const) {
  test(`no browser switch where it would do nothing: ${why}`, async ({ page }, info) => {
    await page.addInitScript((version) => {
      const state = { linked: false, linkId: null, state: "off", name: "iPhone", app: version,
        abilities: { photos: { enabled: false, permission: "notDetermined" }, reminders: { enabled: false, permission: "notDetermined" }, calendar: { enabled: false, permission: "notDetermined" } } };
      (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioDeviceTools: { postMessage: async () => JSON.stringify(state) } } };
    }, app);
    await mockConsole(page, { conversations: [] });
    await mockLinks(page, [], envs);
    await openSettings(page, info.project.name.startsWith("mobile"));
    const card = page.getByRole("region", { name: "iPhone 能力" });
    await expect(card.getByRole("checkbox")).toHaveCount(3);
    await expect(card.getByRole("checkbox", { name: "浏览器和 App 的文件夹" })).toHaveCount(0);
  });
}

test("in a browser the card lists the iPhones the account linked, with what is on, and removes one", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [{ id: "dlink_1", name: "Rui's iPhone", createdAt: Date.UTC(2026, 10, 1), lastSeenAt: Date.UTC(2026, 10, 3), online: true }]);
  await page.route("**/api/ios-device", (r) => r.fulfill({ json: { linked: true, reachable: true, abilities: { photos: { enabled: true, permission: "authorized" }, reminders: { enabled: false, permission: "notDetermined" }, calendar: { enabled: true, permission: "authorized" } } } }));
  await openSettings(page, info.project.name.startsWith("mobile"));
  const card = page.getByRole("region", { name: "iPhone 能力" });
  await expect(card).toContainText("在 iPhone 上的一站 App 里打开后");
  await expect(card).toContainText("Rui's iPhone");
  await expect(card).toContainText("在线");
  await expect(card).toContainText("已打开：相册、日历");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await card.screenshot({ path: info.outputPath("iphone-abilities-web.png") });
  await card.getByRole("button", { name: "移除" }).click();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_1");
  // Nothing left to show in a browser: the card goes.
  await expect(card).toHaveCount(0);
});

test("in a browser an account that never linked an iPhone has no card", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, []);
  await openSettings(page, info.project.name.startsWith("mobile"), false);
  await expect(page.getByRole("region", { name: "配置" }).first()).toBeVisible();
  // Nothing to show: no entry to open it either.
  await expect(page.getByRole("navigation", { name: "配置项" }).getByRole("button", { name: "iPhone 能力" })).toHaveCount(0);
  await expect.poll(() => calls).toContain("GET /api/device-links?kind=ios");
  await expect(page.getByRole("region", { name: "iPhone 能力" })).toHaveCount(0);
});
