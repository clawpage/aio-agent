import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const secretFile = process.env.PA_OWNER_SECRET_FILE ?? "var/owner-secret.txt";

// Real login flow is exercised without the shared session state.
test.use({ storageState: { cookies: [], origins: [] } });

const base = process.env.PA_E2E_BASE ?? "https://agent.zymx.tech";
const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(base);
// Repeated wrong-password logins against the public hostname can trip Cloudflare's
// edge rate limiter (Error 1015), which is not something this project controls.
// The regression therefore runs against the loopback instance; the public suite
// still performs exactly one real login in the setup project.
test.skip(
  !isLoopback && process.env.PA_E2E_LOGIN !== "1",
  "login UI regression runs on the loopback instance (set PA_E2E_LOGIN=1 to force)",
);

test.describe("login", () => {
  test("rejects a wrong password and accepts the owner password", async ({ page }) => {
    // Record every auth call (status only, never the body) so a failure shows
    // whether the click actually produced a request.
    const calls: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/api/auth/")) calls.push(`${response.request().method()} ${url.split("/api")[1]} -> ${response.status()}`);
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "个人智能体" })).toBeVisible();

    await page.getByLabel("密码").fill(`wrong-${Date.now()}`);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".banner.error"), `wrong-password attempt made no request: ${calls.join(", ")}`).toBeVisible({
      timeout: 20_000,
    });

    const password = fs.readFileSync(path.resolve(secretFile), "utf8").trim();
    const field = page.getByLabel("密码");
    await field.fill(password);
    // Guard against a fill that did not reach React state (then the retry would
    // resend the previous password and never authenticate).
    expect((await field.inputValue()) === password).toBe(true);

    const button = page.getByRole("button", { name: "登录" });
    await expect(button, `login button not enabled: ${calls.join(", ")}`).toBeEnabled({ timeout: 10_000 });
    await button.click();

    // The shell exists on both viewports; the sidebar itself is hidden on mobile.
    await expect(
      page.locator(".app"),
      `correct-password login did not reach the shell; auth calls: ${calls.join(", ")}`,
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".status-chip")).toBeVisible();
  });

  test("unauthenticated visitors never see the console", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app")).toHaveCount(0);
    await expect(page.getByLabel("密码")).toBeVisible();
  });
});
