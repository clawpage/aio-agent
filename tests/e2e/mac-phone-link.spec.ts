import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockConsole } from "./mock-api";

const evidence = "var/.playwright-artifacts/mac-phone-link";

type Link = { id: string; name: string; createdAt: number; lastSeenAt: number | null; online: boolean };

async function openSettings(page: Page, mobile: boolean) {
  if (mobile) await page.locator(".bottom-nav button", { hasText: "配置" }).click();
  else await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  await expect(page.getByRole("heading", { name: "配置" })).toBeVisible();
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

test("a browser lists the account's Macs but cannot link itself", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const calls = await mockLinks(page, [{ id: "dlink_1", name: "Office iMac", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 2), online: false }]);
  await page.goto("/");
  await openSettings(page, info.project.name.startsWith("mobile"));
  const card = page.getByRole("region", { name: "Mac 上的手机" });
  await expect(card).toContainText("在 Mac 上安装一站 App");
  await expect(card).toContainText("Office iMac");
  await expect(card.getByRole("button", { name: "连接这台 Mac 的手机" })).toHaveCount(0);
  await card.getByRole("button", { name: "移除" }).click();
  await expect(card).toContainText("还没有连接过 Mac。");
  expect(calls).toContain("DELETE /api/device-links/dlink_1");
});

test("inside the Mac app, linking hands the token to the app and shows the app's state", async ({ page }, info) => {
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
  await page.goto("/");
  const mobile = info.project.name.startsWith("mobile");
  await openSettings(page, mobile);
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
