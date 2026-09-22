import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const secretFile = process.env.PA_OWNER_SECRET_FILE ?? "var/owner-secret.txt";

// Real login flow is exercised without the shared session state.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("login", () => {
  test("rejects a wrong password and accepts the owner password", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "个人智能体" })).toBeVisible();

    await page.getByLabel("密码").fill(`wrong-${Date.now()}`);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".banner.error")).toBeVisible({ timeout: 20_000 });

    const password = fs.readFileSync(path.resolve(secretFile), "utf8").trim();
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    // The shell exists on both viewports; the sidebar itself is hidden on mobile.
    await expect(page.locator(".app")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".status-chip")).toBeVisible();
  });

  test("unauthenticated visitors never see the console", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app")).toHaveCount(0);
    await expect(page.getByLabel("密码")).toBeVisible();
  });
});
