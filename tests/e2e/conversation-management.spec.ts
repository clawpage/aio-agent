import { expect, test, type Page } from "@playwright/test";
import { makeConversation, mockConsole, type MockConversation } from "./mock-api";

/**
 * Conversation management in the sidebar. Every per-conversation action lives
 * behind a single lightweight `⋯` button; the menu offers rename + archive for
 * active rows and rename + restore for archived rows. There is deliberately no
 * delete anywhere.
 *
 * The spec runs against the local static harness with every `/api` call mocked
 * (`playwright.local.config.ts`), so it never touches a real deployment and no
 * cleanup endpoint is needed.
 */

const TITLE = "E2E 管理会话";

function seed(): MockConversation[] {
  return [makeConversation("conv_e2e_manage", TITLE)];
}

/** On mobile the sidebar is off-canvas until the 会话 nav button is tapped. */
async function showSidebar(page: Page): Promise<void> {
  const bottomNav = page.locator(".bottom-nav button", { hasText: "会话" });
  if (await bottomNav.isVisible().catch(() => false)) {
    await bottomNav.click();
    await expect(page.locator(".sidebar")).toHaveClass(/show-mobile/);
  }
}

/** The menu is portal-rendered to <body>; scope locators to it while it is open. */
function menu(page: Page): ReturnType<Page["locator"]> {
  return page.locator(".conv-menu");
}

test.describe("conversation management", () => {
  test("the row exposes only a ⋯ button; rename, archive and restore work", async ({ page }) => {
    await mockConsole(page, { conversations: seed() });
    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await showSidebar(page);

    const row = page.locator(".conv", { hasText: TITLE });
    await expect(row).toBeVisible();

    // Exactly one per-row control, labelled as the conversation's actions, and
    // no inline archive/delete buttons leaking into the row.
    const trigger = row.getByRole("button", { name: `${TITLE} 的操作` });
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toHaveText("⋯");
    // Only the title/select button plus the `⋯` trigger; no inline actions.
    await expect(row.locator(".conv-menu-button")).toHaveCount(1);
    await expect(
      row.locator("button:has-text('归档'), button:has-text('删除'), button:has-text('恢复'), .conv-action"),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /删除/ })).toHaveCount(0);

    // The menu is anchored, complete and not clipped by the sidebar.
    await trigger.click();
    const open = menu(page);
    await expect(open).toBeVisible();
    await expect(open.getByRole("menuitem")).toHaveText(["重命名", "归档"]);
    await expect(open.getByRole("menuitem", { name: /删除/ })).toHaveCount(0);
    await expect.poll(() => open.evaluate(n => n.getAnimations().length)).toBe(0);
    const box = await open.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

    // Escape closes the menu and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(open).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Rename: prefilled, saved through PATCH, reflected in the row and chat head.
    await trigger.click();
    await menu(page).getByRole("menuitem", { name: "重命名" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名会话" });
    const input = dialog.getByLabel("会话标题");
    await expect(input).toHaveValue(TITLE);
    await input.fill("E2E 改名后");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".conv", { hasText: "E2E 改名后" })).toBeVisible();
    await expect(page.locator(".chat-title h2")).toHaveText("E2E 改名后");

    // Archive: the row leaves the active list.
    await page.locator(".conv", { hasText: "E2E 改名后" }).getByRole("button", { name: "E2E 改名后 的操作" }).click();
    await menu(page).getByRole("menuitem", { name: "归档" }).click();
    await expect(page.locator(".conv", { hasText: "E2E 改名后" })).toHaveCount(0);

    // The archived row is a label (no chat pane behind it) and offers rename + restore.
    await page.getByRole("button", { name: /查看已归档/ }).click();
    const archivedRow = page.locator(".conv", { hasText: "E2E 改名后" });
    await expect(archivedRow).toBeVisible({ timeout: 20_000 });
    await expect(archivedRow.locator("button.conv-main")).toHaveCount(0);
    await expect(archivedRow.locator(".conv-main.static")).toHaveCount(1);
    await archivedRow.getByRole("button", { name: "E2E 改名后 的操作" }).click();
    await expect(menu(page).getByRole("menuitem")).toHaveText(["重命名", "恢复"]);
    await expect(menu(page).getByRole("menuitem", { name: /删除/ })).toHaveCount(0);

    // Restore: back to the active list.
    await menu(page).getByRole("menuitem", { name: "恢复" }).click();
    await expect(page.locator(".conv", { hasText: "E2E 改名后" })).toHaveCount(0);
    await page.getByRole("button", { name: /返回活跃会话/ }).click();
    await expect(page.locator(".conv", { hasText: "E2E 改名后" })).toBeVisible({ timeout: 20_000 });
  });

  test("a failed rename keeps the typed value and shows the error inline", async ({ page }) => {
    await mockConsole(page, {
      conversations: seed(),
      failPatchOnce: { status: 500, error: "server_error", message: "模拟保存失败" },
    });
    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await showSidebar(page);

    await page.locator(".conv", { hasText: TITLE }).getByRole("button", { name: `${TITLE} 的操作` }).click();
    await menu(page).getByRole("menuitem", { name: "重命名" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名会话" });
    const input = dialog.getByLabel("会话标题");
    await input.fill("不会保存的标题");
    await dialog.getByRole("button", { name: "保存" }).click();

    await expect(dialog.getByRole("alert")).toContainText("模拟保存失败");
    await expect(input).toHaveValue("不会保存的标题");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("an empty title is rejected before any request", async ({ page }) => {
    await mockConsole(page, { conversations: seed() });
    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await showSidebar(page);

    await page.locator(".conv", { hasText: TITLE }).getByRole("button", { name: `${TITLE} 的操作` }).click();
    await menu(page).getByRole("menuitem", { name: "重命名" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名会话" });
    await dialog.getByLabel("会话标题").fill("   ");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog.getByRole("alert")).toContainText("标题不能为空");
    await expect(dialog).toBeVisible();
  });
});
