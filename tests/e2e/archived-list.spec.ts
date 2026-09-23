import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole, type MockConversation } from "./mock-api";

/**
 * Archived conversations are shown in a dedicated list with no chat pane behind
 * them, so the row title must be a plain label: clicking it used to select the
 * conversation and switch the mobile pane to a chat that is not rendered,
 * leaving a blank screen. Only the ⋯ menu (rename / restore) acts on an archived
 * row.
 */
const activeConversation: MockConversation = makeConversation("conv_e2e_active", "活跃会话");
const archivedConversation: MockConversation = { ...makeConversation("conv_e2e_archived", "已归档会话"), archived: 1 };
const conversations = [activeConversation, archivedConversation];

/** On mobile the sidebar is off-canvas until the 会话 nav button is tapped. */
async function showSidebar(page: import("@playwright/test").Page): Promise<void> {
  const bottomNav = page.locator(".bottom-nav button", { hasText: "会话" });
  if (await bottomNav.isVisible().catch(() => false)) {
    await bottomNav.click();
    await expect(page.locator(".sidebar")).toHaveClass(/show-mobile/);
  }
}

test.describe("archived conversation list", () => {
  test("the archived row title is a label, not a control", async ({ page }) => {
    await mockConsole(page, { conversations });
    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });

    // The active row still opens its chat.
    await showSidebar(page);
    const activeRow = page.locator(".conv", { hasText: "活跃会话" });
    await expect(activeRow.locator("button.conv-main")).toHaveCount(1);
    await expect(page.locator(".conv", { hasText: "已归档会话" })).toHaveCount(0);

    await page.getByRole("button", { name: /查看已归档/ }).click();
    const archivedRow = page.locator(".conv", { hasText: "已归档会话" });
    await expect(archivedRow).toBeVisible({ timeout: 20_000 });

    // No clickable title button; actions live behind the single ⋯ trigger.
    await expect(archivedRow.locator("button.conv-main")).toHaveCount(0);
    await expect(archivedRow.locator(".conv-main.static")).toHaveCount(1);
    await expect(archivedRow.locator(".conv-menu-button")).toHaveCount(1);
    await expect(archivedRow.getByRole("button", { name: /删除/ })).toHaveCount(0);

    // The pane behind the archived list is an explicit explanation, not a blank
    // screen, even on the mobile layout.
    await expect(page.locator(".empty")).toContainText("已归档会话");
    await expect(page.locator(".empty")).toContainText("恢复");
  });
});
