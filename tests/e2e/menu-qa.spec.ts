import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * Visual QA captures for the conversation menu, the rename dialog and the agent
 * activity state. Runs against the fully mocked local harness only (fake
 * conversation titles and a fake account), and writes PNGs to the artifacts
 * directory so the parent session can review the real rendering.
 *
 * Guarded to the desktop project: it drives both the 1440×900 and the 360px
 * layouts itself via `setViewportSize`.
 */

const OUT = "var/.playwright-artifacts/menu-qa";

/** Wait for entry animations to settle so a screenshot shows the final frame. */
async function settle(page: import("@playwright/test").Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

function sseWithConversation(): string {
  const messages = [
    { id: 1, type: "item/completed", payload: { item: { id: "u1", type: "userMessage", text: "帮我查一下今天的日程。" } } },
    {
      id: 2,
      type: "item/completed",
      payload: { item: { id: "a1", type: "agentMessage", text: "好的，我正在读取日历并整理今天的安排。" } },
    },
    {
      id: 3,
      type: "item/started",
      payload: { item: { id: "t1", type: "commandExecution", command: "aio shell exec 'date'" } },
    },
  ];
  const frames = messages.map(
    (m) =>
      `id: ${m.id}\nevent: ${m.type}\ndata: ${JSON.stringify({
        id: m.id,
        type: m.type,
        turnId: "t1",
        createdAt: Date.now(),
        payload: m.payload,
      })}\n\n`,
  );
  return ["retry: 3000", "", ...frames, `event: replay.complete\ndata: ${JSON.stringify({ lastEventId: 3, replayed: 3 })}\n\n`].join(
    "\n",
  );
}

test.describe("menu QA screenshots", () => {
  test("capture menu, rename dialog and running state on desktop and 360px", async ({ page, isMobile }) => {
    test.skip(isMobile, "captured once from the desktop project; this spec drives its own viewports");
    fs.mkdirSync(OUT, { recursive: true });
    // Capture the product's default dark look.
    await page.emulateMedia({ colorScheme: "dark" });

    const conversation = makeConversation("conv_e2e_qa", "整理今天的日程");

    for (const [label, width, height] of [
      ["desktop", 1440, 900],
      ["mobile360", 360, 844],
    ] as const) {
      await page.setViewportSize({ width, height });

      // --- menu + rename dialog (idle conversation) ---
      await mockConsole(page, { conversations: [{ ...conversation }] });
      await page.goto("/");
      await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });

      const bottomNav = page.locator(".bottom-nav button", { hasText: "会话" });
      if (await bottomNav.isVisible().catch(() => false)) {
        await bottomNav.click();
        await expect(page.locator(".sidebar")).toHaveClass(/show-mobile/);
      }

      const trigger = page
        .locator(".conv", { hasText: conversation.title })
        .getByRole("button", { name: `${conversation.title} 的操作` });
      await trigger.click();
      await expect(page.locator(".conv-menu")).toBeVisible();
      await settle(page, ".conv-menu");
      await page.screenshot({ path: `${OUT}/${label}-menu.png` });

      await page.locator(".conv-menu").getByRole("menuitem", { name: "重命名" }).click();
      await expect(page.getByRole("dialog", { name: "重命名会话" })).toBeVisible();
      await settle(page, ".modal");
      await page.screenshot({ path: `${OUT}/${label}-rename.png` });
      await page.keyboard.press("Escape");

      // --- running state ---
      const running = { ...conversation, status: "running" };
      await mockConsole(page, {
        conversations: [running],
        sse: { [running.id]: sseWithConversation() },
      });
      await page.goto("/");
      await expect(page.locator(".chat")).toHaveClass(/\brunning\b/, { timeout: 20_000 });
      await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
      await settle(page, ".msg");
      await page.screenshot({ path: `${OUT}/${label}-running.png` });
    }
  });
});
