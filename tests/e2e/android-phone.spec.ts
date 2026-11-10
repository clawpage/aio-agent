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

test("inside the Android app, one switch links this phone for the account signed in here and unlinks it again", async ({ page }, info) => {
  // The app's web message listener (DeviceTools.kt): records what the console sends and answers out of band
  // with its state, repeating the message's `seq`; anything it does not know is refused.
  await page.addInitScript(() => {
    const sent: Array<Record<string, unknown>> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const listeners: Array<(event: { data: string }) => void> = [];
    const state = { linked: false, linkId: null as string | null, state: "off", name: "Pixel 8", abilities: {} };
    const answer = (body: unknown) => setTimeout(() => listeners.forEach((l) => l({ data: JSON.stringify(body) })), 5);
    (window as unknown as { aioDeviceTools: unknown }).aioDeviceTools = {
      addEventListener: (type: string, listener: (event: { data: string }) => void) => { if (type === "message") listeners.push(listener); },
      postMessage: (raw: string) => {
        const msg = JSON.parse(raw) as { type: string; seq: number; linkId?: string };
        sent.push(msg);
        if (!["status", "account", "link", "unlink"].includes(msg.type)) return answer({ error: "unknown", seq: msg.seq });
        if (msg.type === "link") {
          Object.assign(state, { linked: true, linkId: msg.linkId, state: "connecting" });
          setTimeout(() => { state.state = "online"; window.dispatchEvent(new CustomEvent("aio-device-tools", { detail: structuredClone(state) })); }, 50);
        }
        if (msg.type === "unlink") Object.assign(state, { linked: false, linkId: null, state: "off" });
        answer({ ...state, seq: msg.seq });
      },
    };
  });
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [{ id: "dlink_old", name: "Old Galaxy", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 2), online: false }]);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const sent = () => page.evaluate(() => (window as unknown as { __sent: Array<Record<string, unknown>> }).__sent.map(({ seq: _seq, ...rest }) => rest));

  // The console told the app who is signed in, as soon as it knew; every message carried a number.
  await expect.poll(sent).toContainEqual({ type: "account", account: "owner" });
  expect(await page.evaluate(() => (window as unknown as { __sent: Array<{ seq?: unknown }> }).__sent.every((m) => typeof m.seq === "number"))).toBe(true);
  // An Android app is not an iPhone: no iPhone entry for an account that never linked one.
  await expect(page.getByRole("navigation", { name: "配置项" }).getByRole("button", { name: "iPhone 能力" })).toHaveCount(0);

  const card = page.getByRole("region", { name: "Android 手机" });
  const toggle = card.getByRole("checkbox", { name: "让 AI 使用这台手机的浏览器和 App 的文件夹" });
  await expect(card.getByRole("checkbox")).toHaveCount(1);
  await expect(toggle).not.toBeChecked();
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
  // Nothing iPhone-only was asked of the server.
  expect(calls).not.toContain("GET /api/ios-device");
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
