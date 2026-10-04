import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * Assistant Markdown links: a private IP http/https link in an agent reply must
 * open as a real tab in the sandbox browser through the authenticated
 * control-plane API, never as a host browser tab. Every control-plane call is
 * mocked by `mockConsole`, so the spec is deterministic and never depends on a
 * real deployment. Server-side URL validation and the real sandbox call are
 * covered by the integration suite against the fake AIO sandbox.
 */

const CONV_ID = "conv_e2e_browser_link";
const LINK = "http://192.168.1.20/e2e-target";

function sseWithMarkdown(markdown: string): string {
  const event = {
    id: 1,
    type: "item/completed",
    turnId: "t1",
    createdAt: Date.now(),
    payload: { item: { id: "i1", type: "agentMessage", text: markdown } },
  };
  return [
    "retry: 3000",
    "",
    `id: 1\nevent: item/completed\ndata: ${JSON.stringify(event)}\n\n`,
    `event: replay.complete\ndata: ${JSON.stringify({ lastEventId: 1, replayed: 1 })}\n\n`,
  ].join("\n");
}

test.describe("assistant markdown links", () => {
  test("a private IP http link opens in the sandbox browser, not a host tab", async ({ page }) => {
    let requested: string | null = null;
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "链接测试")],
      sse: { [CONV_ID]: sseWithMarkdown(`请打开 [示例链接](${LINK}) 查看。`) },
      onBrowserTab: (url) => {
        requested = url;
      },
    });

    let popupOpened = false;
    page.on("popup", () => {
      popupOpened = true;
    });

    await page.goto("/");
    const link = page.getByRole("link", { name: "示例链接" });
    await expect(link).toBeVisible({ timeout: 60_000 });
    await link.click();

    await expect.poll(() => requested).toBe(LINK);
    // The workspace opens on its browser view instead of a host tab.
    await expect(page.locator(".workspace")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
    expect(popupOpened).toBe(false);
    expect(page.context().pages().length).toBe(1);
  });

  test("a mailto link is inert: no host mail program, no sandbox API", async ({ page }) => {
    let requested = false;
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "链接测试")],
      sse: { [CONV_ID]: sseWithMarkdown("联系 [邮件](mailto:owner@example.com)。") },
      onBrowserTab: () => {
        requested = true;
      },
    });

    let popupOpened = false;
    page.on("popup", () => {
      popupOpened = true;
    });

    await page.goto("/");
    const before = page.url();
    // The sanitizer drops the mailto href, so the anchor is no longer a link and
    // cannot hand the address to a host program. Its text stays selectable.
    const anchor = page.locator(".markdown a");
    await expect(anchor).toHaveText("邮件", { timeout: 60_000 });
    await expect(anchor).not.toHaveAttribute("href", /.+/);
    await anchor.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(400);
    expect(requested).toBe(false);
    expect(popupOpened).toBe(false);
    await expect(page.locator(".workspace")).toHaveCount(0);
    expect(page.url()).toBe(before);
  });

  test("when the workspace is already open on another tab, a link switches it back to the browser", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only: the workspace overlay covers the chat on mobile");
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "链接测试")],
      sse: { [CONV_ID]: sseWithMarkdown(`[示例链接](${LINK})`) },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();
    await expect(page.getByRole("tab", { name: "终端" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "终端" }).click();
    await expect(page.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("link", { name: "示例链接" }).click();
    // The already-open workspace switches back to the browser view (a fresh
    // one-time ticket) instead of opening a second panel.
    await expect(page.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  });

  test("a relative link is inert and cannot open the control-plane origin in the sandbox", async ({ page }) => {
    let requested = false;
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "链接测试")],
      sse: { [CONV_ID]: sseWithMarkdown("打开 [相对链接](/settings/profile)。") },
      onBrowserTab: () => {
        requested = true;
      },
    });

    await page.goto("/");
    const before = page.url();
    // The sanitizer removes the relative href entirely, so the anchor has no
    // navigable destination and cannot be resolved against the current origin.
    const anchor = page.locator(".markdown a");
    await expect(anchor).toHaveText("相对链接", { timeout: 60_000 });
    await expect(anchor).not.toHaveAttribute("href", /.+/);
    await anchor.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    expect(requested).toBe(false);
    await expect(page.locator(".workspace")).toHaveCount(0);
    expect(page.url()).toBe(before);
  });
});
