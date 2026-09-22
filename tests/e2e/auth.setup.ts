import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const STORAGE_STATE = process.env.PA_E2E_STATE ?? "var/.auth/state.json";
const secretFile = process.env.PA_OWNER_SECRET_FILE ?? "var/owner-secret.txt";

/**
 * Log in once through the real UI and persist the session for the other specs.
 * The state file holds a live session cookie and lives under the git-ignored
 * `var/` directory; it is never copied anywhere else.
 */
setup("authenticate as owner", async ({ page }) => {
  const password = fs.readFileSync(path.resolve(secretFile), "utf8").trim();
  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "个人智能体" })).toBeVisible();
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("button", { name: "＋ 新建会话" })).toBeVisible({ timeout: 60_000 });
  await page.context().storageState({ path: STORAGE_STATE });
});
