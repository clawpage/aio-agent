import { expect, test, type Page } from "@playwright/test";

/** Frames currently loaded, as a single string (works across origins). */
function frameUrls(page: Page): string {
  return page.frames().map((f) => f.url()).join(" ");
}

/** Wait for the authenticated shell. Works on desktop and mobile. */
async function ensureApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible({ timeout: 60_000 });
}

async function openWorkspace(page: Page): Promise<void> {
  await ensureApp(page);
  // Mobile uses the bottom navigation and hides the sidebar, so prefer whichever
  // workspace control is actually on screen.
  const bottomNav = page.locator(".bottom-nav button", { hasText: "工作区" });
  if (await bottomNav.isVisible().catch(() => false)) await bottomNav.click();
  else await page.getByRole("button", { name: "工作区" }).first().click();
  await expect(page.getByRole("tab", { name: "终端" })).toBeVisible({ timeout: 20_000 });
}

test.describe("workspace navigation", () => {
  test("opening the workspace then immediately tapping 终端 lands on the terminal", async ({ page }) => {
    await openWorkspace(page);
    // Immediately pick another tab; the default tab load must not win the race.
    await page.getByRole("tab", { name: "终端" }).click();

    await expect(page.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "true");
    const iframe = page.locator('iframe[title="终端"]');
    await expect(iframe).toBeVisible({ timeout: 20_000 });
    await expect(iframe).toHaveAttribute("src", /next=%2Fterminal/);
    await expect.poll(() => frameUrls(page), { timeout: 60_000 }).toContain("/terminal");
  });

  test("rapid tab switching ends on the last tab that was tapped", async ({ page }) => {
    await openWorkspace(page);

    await page.getByRole("tab", { name: "文件" }).click();
    await page.getByRole("tab", { name: "编辑器" }).click();
    await page.getByRole("tab", { name: "终端" }).click();

    await expect(page.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "编辑器" })).toHaveAttribute("aria-selected", "false");

    const iframe = page.locator('iframe[title="终端"]');
    await expect(iframe).toHaveAttribute("src", /next=%2Fterminal/, { timeout: 20_000 });
    await expect.poll(() => frameUrls(page), { timeout: 60_000 }).toContain("/terminal");

    // Switching again must replace the frame rather than stack panels.
    await page.getByRole("tab", { name: "笔记本" }).click();
    await expect(page.getByRole("tab", { name: "笔记本" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('iframe[title="笔记本"]')).toHaveAttribute("src", /next=%2Fjupyter%2Flab/, {
      timeout: 20_000,
    });
  });

  test("file manager lists real sandbox files and reaches the editor", async ({ page }) => {
    await openWorkspace(page);
    await page.getByRole("tab", { name: "文件" }).click();
    await expect(page.locator(".file-list")).toContainText("AGENTS.md", { timeout: 30_000 });

    await page.getByRole("tab", { name: "编辑器" }).click();
    await expect(page.locator('iframe[title="编辑器"]')).toHaveAttribute("src", /next=%2Fcode-server%2F/, {
      timeout: 20_000,
    });
    await expect.poll(() => frameUrls(page), { timeout: 90_000 }).toContain("/code-server");
  });

  test("composer has no model control and the config page owns the model", async ({ page }) => {
    await ensureApp(page);
    if (await page.locator(".bottom-nav button", { hasText: "新建" }).isVisible().catch(() => false)) {
      await page.locator(".bottom-nav button", { hasText: "新建" }).click();
    } else {
      await page.getByRole("button", { name: "＋ 新建会话" }).click();
    }
    await expect(page.locator(".composer textarea")).toBeVisible();
    await expect(page.locator(".status-chip")).toContainText("智能体在线", { timeout: 30_000 });
    // The conversation composer carries no model/effort control any more.
    await expect(page.locator(".composer select")).toHaveCount(0);

    // The unified config page is where the model now lives, and a fresh install
    // defaults to the app default model (not the CLI's own gpt-6-astra).
    await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
    const modelSelect = page.getByLabel("模型", { exact: true });
    await expect(modelSelect).toBeVisible();
    await expect(modelSelect).toHaveValue("gpt-6-sol");
    await expect(modelSelect.locator("option:checked")).toContainText("GPT-6-Sol（默认）");
  });
});

test.describe("layout sanity", () => {
  test("no horizontal overflow on the chat view", async ({ page }) => {
    await ensureApp(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("workspace dock does not overflow the screen", async ({ page }) => {
    await openWorkspace(page);
    const tabs = page.locator(".dock");
    await expect(tabs).toBeVisible();
    const metrics = await tabs.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(metrics.client).toBeGreaterThan(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
