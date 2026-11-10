import { expect, test, type Page } from "@playwright/test";
import { mockConsole, openSettingsEntry } from "./mock-api";

type Link = { id: string; name: string; createdAt: number; lastSeenAt: number | null; online: boolean };

/** The control plane's Android links (`/api/device-links?kind=android`), kept in memory; every call is recorded. */
async function mockLinks(page: Page, links: Link[]) {
  const calls: string[] = [];
  await page.route("**/api/ios-device", (route) => { calls.push("GET /api/ios-device"); return route.fulfill({ json: { linked: false, reachable: false, abilities: null } }); });
  await page.route("**/api/device-links**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}${url.search}${req.method() === "POST" ? ` ${req.postData()}` : ""}`);
    if (req.method() === "POST") {
      const link = { id: "dlink_android", name: (req.postDataJSON() as { name: string }).name, createdAt: Date.now(), lastSeenAt: null, online: false };
      links.unshift(link);
      return route.fulfill({ json: { link, token: `dl_${"t".repeat(43)}` } });
    }
    if (req.method() === "DELETE") {
      links.splice(links.findIndex((l) => l.id === url.pathname.split("/").pop()), 1);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { links: url.searchParams.get("kind") === "android" ? links : [] } });
  });
  return calls;
}

/** The configuration page, and with `entry` its Android page (offered inside the app, or once an Android phone is linked). */
async function openSettings(page: Page, mobile: boolean, entry = true) {
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  if (entry) await openSettingsEntry(page, "Android 手机");
}

/**
 * The app's web message listener (DeviceTools.kt): records what the console sends and answers out of band with
 * its state, repeating the message's `seq`; anything it does not know is refused. Android allows the calendar
 * when asked unless `denyCalendar`; the photo picker returns two photos. `full` is the side-loaded app: it also has the
 * phone's control (PhoneControl.kt), which pairs once the person types the code into its notification (a moment after
 * `pair` here) and is then started and stopped.
 */
async function appBridge(page: Page, opts: { denyCalendar?: boolean; full?: boolean } = {}) {
  await page.addInitScript(({ denyCalendar, full }) => {
    const sent: Array<Record<string, unknown>> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const listeners: Array<(event: { data: string }) => void> = [];
    const thumb = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    let photos: Array<{ id: string; video: boolean; thumb: string }> = [];
    const state = {
      linked: false, linkId: null as string | null, state: "off", name: "Pixel 8",
      abilities: { photos: { enabled: false, permission: "authorized", shared: 0 }, calendar: { enabled: false, permission: "notDetermined" } },
      ...(full ? { control: { state: "off", paired: false, error: null as string | null, wirelessDebugging: false } } : {}),
    };
    const publish = () => window.dispatchEvent(new CustomEvent("aio-device-tools", { detail: structuredClone(state) }));
    const answer = (body: unknown) => setTimeout(() => listeners.forEach((l) => l({ data: JSON.stringify(body) })), 5);
    (window as unknown as { aioDeviceTools: unknown }).aioDeviceTools = {
      addEventListener: (type: string, listener: (event: { data: string }) => void) => { if (type === "message") listeners.push(listener); },
      postMessage: (raw: string) => {
        const msg = JSON.parse(raw) as { type: string; seq: number; linkId?: string; ability?: "photos" | "calendar"; ids?: string[] };
        sent.push(msg);
        const extra: Record<string, unknown> = {};
        switch (msg.type) {
          case "status": case "account": case "settings": break;
          case "link":
            Object.assign(state, { linked: true, linkId: msg.linkId, state: "connecting" });
            setTimeout(() => { state.state = "online"; window.dispatchEvent(new CustomEvent("aio-device-tools", { detail: structuredClone(state) })); }, 50);
            break;
          case "unlink":
            Object.assign(state, { linked: false, linkId: null, state: "off" });
            state.abilities.photos.enabled = state.abilities.calendar.enabled = false;
            photos = [];
            state.abilities.photos.shared = 0;
            break;
          case "enable":
            if (msg.ability === "calendar") state.abilities.calendar.permission = denyCalendar ? "denied" : "authorized";
            state.abilities[msg.ability!].enabled = state.abilities[msg.ability!].permission === "authorized";
            break;
          case "disable": state.abilities[msg.ability!].enabled = false; break;
          case "photosAdd":
            photos.push({ id: `p${photos.length + 1}`, video: false, thumb }, { id: `p${photos.length + 2}`, video: true, thumb });
            state.abilities.photos.shared = photos.length;
            break;
          case "photosShared": extra.photos = photos; break;
          case "control": {
            const control = (state as { control?: { state: string; paired: boolean; wirelessDebugging: boolean } }).control;
            if (!control) return answer({ error: "unknown", seq: msg.seq });
            const action = (msg as unknown as { action: string }).action;
            if (action === "pair") {
              control.state = "pairing";
              // The person types the code into the notification.
              setTimeout(() => { Object.assign(control, { state: "running", paired: true, wirelessDebugging: true }); publish(); }, 300);
            }
            if (action === "stop") Object.assign(control, { state: "stopped", wirelessDebugging: false });
            if (action === "start") {
              control.state = "connecting";
              setTimeout(() => { Object.assign(control, { state: "running", wirelessDebugging: true }); publish(); }, 300);
            }
            break;
          }
          case "photosRemove":
            photos = photos.filter((p) => !msg.ids!.includes(p.id));
            state.abilities.photos.shared = photos.length;
            break;
          default: return answer({ error: "unknown", seq: msg.seq });
        }
        answer({ ...structuredClone(state), ...extra, seq: msg.seq });
      },
    };
  }, { denyCalendar: opts.denyCalendar ?? false, full: opts.full ?? false });
}

const sentBy = (page: Page) => () => page.evaluate(() => (window as unknown as { __sent: Array<Record<string, unknown>> }).__sent.map(({ seq: _seq, ...rest }) => rest));

test("inside the Android app, one switch links this phone for the account signed in here and unlinks it again", async ({ page }, info) => {
  await appBridge(page);
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [{ id: "dlink_old", name: "Old Galaxy", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 2), online: false }]);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const sent = sentBy(page);

  // The console told the app who is signed in, as soon as it knew; every message carried a number.
  await expect.poll(sent).toContainEqual({ type: "account", account: "owner" });
  expect(await page.evaluate(() => (window as unknown as { __sent: Array<{ seq?: unknown }> }).__sent.every((m) => typeof m.seq === "number"))).toBe(true);
  // An Android app is not an iPhone: no iPhone entry for an account that never linked one.
  await expect(page.getByRole("navigation", { name: "配置项" }).getByRole("button", { name: "iPhone 能力" })).toHaveCount(0);

  const card = page.getByRole("region", { name: "Android 手机" });
  const toggle = card.getByRole("checkbox", { name: "让 AI 使用这台手机的浏览器和 App 的文件夹" });
  await expect(card.getByRole("checkbox")).toHaveCount(3);
  await expect(toggle).not.toBeChecked();
  await expect(card).toContainText("「文件」App");
  await expect(card).toContainText("只给当前登录的账号");
  await expect(card).toContainText("Old Galaxy");

  // On: this phone gets a link of its own, handed to the app.
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(card).toContainText("已连接");
  await expect(card).toContainText("一站 App 开在屏幕上时才能用");
  expect(calls).toContain(`POST /api/device-links ${JSON.stringify({ name: "Pixel 8", kind: "android" })}`);
  expect(await sent()).toContainEqual({ type: "link", token: `dl_${"t".repeat(43)}`, linkId: "dlink_android", account: "owner" });
  // This phone is not listed again as another one; the other one still is, and goes.
  await expect(card.getByRole("button", { name: "移除" })).toHaveCount(1);
  await card.screenshot({ path: info.outputPath("android-phone-app.png") });
  await card.getByRole("button", { name: "移除" }).click();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_old");
  await expect(card).not.toContainText("Old Galaxy");

  // Off: the link goes, here and on the server.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_android");
  await expect.poll(sent).toContainEqual({ type: "unlink" });
  await expect(card).not.toContainText("已连接");
  // Nothing iPhone-only was asked of the server, and the Play app has no control of other apps to offer.
  expect(calls).not.toContain("GET /api/ios-device");
  await expect(card).not.toContainText("其他 App 和屏幕");
});

test("inside the side-loaded Android app, other apps and the screen are paired once, then started and stopped", async ({ page }, info) => {
  await appBridge(page, { full: true });
  await mockConsole(page, { conversations: [] });
  await mockLinks(page, []);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const sent = sentBy(page);
  const card = page.getByRole("region", { name: "Android 手机" });
  const control = card.getByRole("listitem", { name: "其他 App 和屏幕" });
  await expect(control).toContainText("未配对");
  await expect(control).toContainText("使用配对码配对设备");
  await control.getByRole("button", { name: "配对" }).click();
  await expect.poll(sent).toContainEqual({ type: "control", action: "pair" });
  // Paired from the notification: the app says so by itself, and the steps go.
  await expect(control.getByRole("status")).toHaveText("运行中：AI 可以使用其他 App 和屏幕");
  await expect(control).not.toContainText("使用配对码配对设备");
  await card.screenshot({ path: info.outputPath("android-phone-control.png") });
  await control.getByRole("button", { name: "停止" }).click();
  await expect(control.getByRole("status")).toHaveText("已停止");
  await control.getByRole("button", { name: "开始" }).click();
  await expect(control.getByRole("status")).toHaveText("运行中：AI 可以使用其他 App 和屏幕");
  expect(await sent()).toContainEqual({ type: "control", action: "stop" });
  expect(await sent()).toContainEqual({ type: "control", action: "start" });
});

test("inside the Android app, the calendar and the photos the person picks are turned on one by one, the first one linking the phone", async ({ page }, info) => {
  await appBridge(page);
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, []);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const sent = sentBy(page);
  const card = page.getByRole("region", { name: "Android 手机" });
  const link = card.getByRole("checkbox", { name: "让 AI 使用这台手机的浏览器和 App 的文件夹" });
  const calendar = card.getByRole("checkbox", { name: "日历" });
  const photos = card.getByRole("checkbox", { name: "相册" });
  await expect(calendar).not.toBeChecked();
  await expect(card).toContainText("看不到整个相册");

  // The calendar on: the app asks Android for the permission then; this phone was not linked, so now it is.
  await calendar.click();
  await expect(calendar).toBeChecked();
  await expect(card.getByRole("status").filter({ hasText: "已允许" })).toBeVisible();
  await expect(link).toBeChecked();
  expect(await sent()).toContainEqual({ type: "enable", ability: "calendar" });
  expect(calls).toContain(`POST /api/device-links ${JSON.stringify({ name: "Pixel 8", kind: "android" })}`);
  await expect.poll(sent).toContainEqual({ type: "link", token: `dl_${"t".repeat(43)}`, linkId: "dlink_android", account: "owner" });

  // Photos on: nothing is shared until the person picks some in the system's picker; then they are listed.
  await photos.click();
  await expect(photos).toBeChecked();
  await expect(card).toContainText("还没有分享照片");
  await card.getByRole("button", { name: "选择照片" }).click();
  await expect(card).toContainText("已分享 2 张");
  await expect(card.getByRole("img", { name: "分享给 AI 的照片" })).toHaveCount(1);
  await expect(card.getByRole("img", { name: "分享给 AI 的视频" })).toHaveCount(1);
  await card.screenshot({ path: info.outputPath("android-phone-abilities.png") });
  await card.getByRole("button", { name: "移除这张" }).first().click();
  await expect(card).toContainText("已分享 1 张");
  expect(await sent()).toContainEqual({ type: "photosRemove", ids: ["p1"] });
  // Only one link for the phone, however many abilities are on.
  expect(calls.filter((c) => c.startsWith("POST "))).toHaveLength(1);

  // An ability off leaves the phone linked; the main switch off turns everything off.
  await calendar.click();
  await expect(calendar).not.toBeChecked();
  expect(await sent()).toContainEqual({ type: "disable", ability: "calendar" });
  await expect(link).toBeChecked();
  await link.click();
  await expect(link).not.toBeChecked();
  await expect(photos).not.toBeChecked();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_android");
  expect(calls).not.toContain("GET /api/ios-device");
});

test("inside the Android app, a calendar Android refuses says so and opens the phone's settings", async ({ page }, info) => {
  await appBridge(page, { denyCalendar: true });
  await mockConsole(page, { conversations: [] });
  await mockLinks(page, []);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const card = page.getByRole("region", { name: "Android 手机" });
  const calendar = card.getByRole("checkbox", { name: "日历" });
  await calendar.click();
  await expect(card).toContainText("系统设置里没有允许");
  await expect(calendar).not.toBeChecked();
  // Nothing turned on, so the phone is not linked for it.
  await expect(card.getByRole("checkbox", { name: "让 AI 使用这台手机的浏览器和 App 的文件夹" })).not.toBeChecked();
  await card.getByRole("button", { name: "去设置开启" }).click();
  await expect.poll(sentBy(page)).toContainEqual({ type: "settings" });
});

test("in a browser the card lists the Android phones the account linked, and removes one", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [{ id: "dlink_1", name: "Rui's Pixel", createdAt: Date.UTC(2026, 10, 1), lastSeenAt: Date.UTC(2026, 10, 3), online: true }]);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const card = page.getByRole("region", { name: "Android 手机" });
  await expect(card).toContainText("在 Android 手机上的一站 App 里打开后");
  await expect(card).toContainText("Rui's Pixel");
  await expect(card).toContainText("在线");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await card.screenshot({ path: info.outputPath("android-phone-web.png") });
  await card.getByRole("button", { name: "移除" }).click();
  await expect.poll(() => calls).toContain("DELETE /api/device-links/dlink_1");
  await expect(card).toHaveCount(0);
  expect(calls).not.toContain("GET /api/ios-device");
});

test("in a browser an account that never linked an Android phone has no entry", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, []);
  await openSettings(page, info.project.name.startsWith("mobile"), false);
  await expect(page.getByRole("region", { name: "配置" }).first()).toBeVisible();
  await expect.poll(() => calls).toContain("GET /api/device-links?kind=android");
  await expect(page.getByRole("navigation", { name: "配置项" }).getByRole("button", { name: "Android 手机" })).toHaveCount(0);
});
