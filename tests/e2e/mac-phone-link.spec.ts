import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockConsole } from "./mock-api";

const evidence = "var/.playwright-artifacts/mac-phone-link";

type Link = { id: string; name: string; createdAt: number; lastSeenAt: number | null; online: boolean };

/** Open the workspace's Phone app; `/api/phone` answers `available`. */
async function openPhoneApp(page: Page, mobile: boolean, available = false) {
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/workspace/ticket", (r) => r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/", expiresAt: Date.now() + 60000 } }));
  await page.route("http://127.0.0.1:4289/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body>sandbox</body></html>" }));
  await page.route("**/api/phone", (r) => r.fulfill({ json: available ? { available: true, reachable: true, device: { serial: "S", name: "Pixel", android: "16" } } : { available: false, device: null } }));
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("tablist", { name: "应用" }).getByRole("tab", { name: "手机" }).click();
}

/** The control plane's /api/device-links, kept in memory. */
async function mockLinks(page: Page, links: Link[]) {
  const calls: string[] = [];
  await page.route("**/api/device-links**", async (route) => {
    const req = route.request();
    calls.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (req.method() === "POST") {
      const link = { id: "dlink_new", name: (req.postDataJSON() as { name: string }).name, createdAt: Date.now(), lastSeenAt: null, online: false };
      links.unshift(link);
      return route.fulfill({ json: { link, token: `dl_${"t".repeat(43)}` } });
    }
    if (req.method() === "DELETE") {
      const id = new URL(req.url()).pathname.split("/").pop();
      links.splice(links.findIndex((l) => l.id === id), 1);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { links } });
  });
  return calls;
}

test("in a browser the Phone app lists the account's Macs but cannot link itself", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [{ id: "dlink_1", name: "Office iMac", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 2), online: false }]);
  await openPhoneApp(page, info.project.name.startsWith("mobile"));
  const card = page.getByRole("region", { name: "Mac 上的手机" });
  await expect(card).toContainText("在 Mac 上安装一站 App");
  await expect(card).toContainText("Office iMac");
  await expect(card.getByRole("button", { name: "连接这台 Mac 的手机" })).toHaveCount(0);
  await card.getByRole("button", { name: "移除" }).click();
  await expect(card).toContainText("还没有连接过 Mac。");
  expect(calls).toContain("DELETE /api/device-links/dlink_1");
});

test("inside the Mac app, the Phone app links this Mac: the token goes to the app, its state shows", async ({ page }, info) => {
  // The app's message handler: records what the console asks, answers with its state.
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as unknown as { __sent: unknown[] }).__sent = sent;
    const emit = (detail: unknown) => window.dispatchEvent(new CustomEvent("aio-device-link", { detail }));
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioDeviceLink: { postMessage(raw: string) {
      const message = JSON.parse(raw) as { type: string; linkId?: string };
      sent.push(message);
      if (message.type === "status") setTimeout(() => emit({ state: "off", name: "Mengxiao's MacBook Pro" }));
      if (message.type === "link") {
        setTimeout(() => emit({ state: "preparing", linkId: message.linkId, name: "Mengxiao's MacBook Pro", detail: "Node.js" }));
        setTimeout(() => emit({ state: "online", linkId: message.linkId, name: "Mengxiao's MacBook Pro" }), 300);
      }
      if (message.type === "unlink") setTimeout(() => emit({ state: "off", name: "Mengxiao's MacBook Pro" }));
    } } } };
  });
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, []);
  await openPhoneApp(page, info.project.name.startsWith("mobile"));
  const card = page.getByRole("region", { name: "Mac 上的手机" });
  await expect(card).toContainText("把用数据线接在这台 Mac 上的 Android 手机交给 AI 操作");
  await card.getByRole("button", { name: "连接这台 Mac 的手机" }).click();
  await expect(card).toContainText("Mengxiao's MacBook Pro （这台 Mac）");
  await expect(card.getByRole("status")).toContainText("在线");
  await expect(card).toContainText("打开 USB 调试");
  await expect(card.getByRole("button", { name: "连接这台 Mac 的手机" })).toHaveCount(0);
  expect(calls).toContain("POST /api/device-links");
  const sent = await page.evaluate(() => (window as unknown as { __sent: Array<{ type: string; token?: string; linkId?: string }> }).__sent);
  expect(sent).toContainEqual({ type: "link", token: `dl_${"t".repeat(43)}`, linkId: "dlink_new" });
  await mkdir(evidence, { recursive: true });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/${info.project.name}-linked.png`, fullPage: false });
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");

  await card.getByRole("button", { name: "移除" }).click();
  await expect(card.getByRole("button", { name: "连接这台 Mac 的手机" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sent: Array<{ type: string }> }).__sent.at(-1))).toEqual({ type: "unlink" });
});

test("with a phone the Phone app shows its screen, and the Macs one tap away", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await mockLinks(page, [{ id: "dlink_1", name: "Home Mac", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.now(), online: true }]);
  await openPhoneApp(page, info.project.name.startsWith("mobile"), true);
  await expect(page.locator(".phone-app .phone")).toBeVisible();
  await page.getByRole("button", { name: "Mac 上的手机" }).click();
  const card = page.getByRole("region", { name: "Mac 上的手机" });
  await expect(card).toContainText("Home Mac");
  await page.getByRole("button", { name: "← 返回手机画面" }).click();
  await expect(page.locator(".phone-app .phone")).toBeVisible();
});

test("settings no longer carry the Macs", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.locator(".bottom-nav button", { hasText: "配置" }).click();
  else await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  await expect(page.getByRole("heading", { name: "配置" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Mac 上的手机" })).toHaveCount(0);
});
