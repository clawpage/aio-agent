import { expect, test, type Page } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * Workspace file links in agent replies.
 *
 * The real report was `[下载图片](/home/gem/workspace/garden-line-drawing.png)`
 * doing nothing. The download endpoint answers with `application/octet-stream`
 * plus an attachment disposition (the AIO sandbox never inlines this PNG), so
 * the console must fetch the blob itself and show it through a typed object URL,
 * while the explicit 下载 link performs the real download.
 *
 * Every control-plane call is mocked, so this runs against the real web bundle
 * without touching a deployment or the sandbox.
 */

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

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

/**
 * Mock the authenticated *inline image* endpoint.
 *
 * The preview no longer points an `<img>` at the download endpoint: that one is
 * `application/octet-stream` with an attachment disposition, which browsers
 * refuse to render. `/api/documents/image` sniffs the bytes and answers a real
 * image content type, so that is what the console fetches.
 */
async function mockImage(page: Page, { status = 200, body = TINY_PNG }: { status?: number; body?: Buffer } = {}): Promise<void> {
  await page.route("**/api/documents/image**", (route) =>
    route.fulfill({
      status,
      contentType: status === 200 ? "image/png" : "application/json",
      body: status === 200 ? body : JSON.stringify({ error: "unsupported" }),
    }),
  );
}

/**
 * Mock the authenticated download endpoint with an attachment disposition. This
 * stays a real download in the test: clicking 下载 must still transfer the
 * original file, not the preview raster.
 */
async function mockDownload(page: Page, { status = 200, body = TINY_PNG }: { status?: number; body?: Buffer } = {}): Promise<void> {
  await page.route("**/api/files/download**", (route) =>
    route.fulfill({
      status,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="garden-line-drawing.png"',
      },
      body,
    }),
  );
}

async function openConversation(page: Page, id: string, markdown: string, linkText: string): Promise<void> {
  await mockConsole(page, {
    conversations: [makeConversation(id, "文件预览")],
    sse: { [id]: sseWithMarkdown(markdown) },
  });
  await page.goto("/");
  await expect(page.locator(`.markdown a[data-sandbox-file]`, { hasText: linkText })).toBeVisible({ timeout: 60_000 });
}

const fileLink = (page: Page, text: string) => page.locator(".markdown a[data-sandbox-file]", { hasText: text });

test.describe("workspace file links", () => {
  test("an image link opens an in-conversation preview and the 下载 button performs a real download", async ({ page }) => {
    const id = "conv_e2e_file_preview";
    await mockImage(page);
    await mockDownload(page);
    await openConversation(page, id, "[下载图片](/home/gem/workspace/garden-line-drawing.png)", "下载图片");

    const link = fileLink(page, "下载图片");
    // The workspace path must not survive as a navigable href (the sanitizer
    // strips it); the console carries it as a data attribute validated on click.
    await expect(link).not.toHaveAttribute("href", /.+/);
    const before = page.url();
    await link.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const image = page.getByTestId("file-preview-image");
    await expect(image).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(page.url()).toBe(before);

    // The explicit download goes through the real (mocked) attachment endpoint.
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("file-preview-download").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("garden-line-drawing.png");

    // Escape closes the lightbox.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the file control is keyboard operable after sanitisation (role button, Enter/Space, Escape)", async ({ page }) => {
    const id = "conv_e2e_file_preview_keyboard";
    await mockImage(page);
    await mockDownload(page);
    await openConversation(page, id, "[下载图片](/home/gem/workspace/garden-line-drawing.png)", "下载图片");

    // DOMPurify must keep role=button/tabindex=0, otherwise the control is not
    // reachable by role and cannot be operated from the keyboard.
    const control = page.getByRole("button", { name: "下载图片" });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("tabindex", "0");
    await expect(control).not.toHaveAttribute("href", /.+/);

    await control.focus();
    await expect(control).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-image")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Space must open the same preview, not scroll the page.
    await control.focus();
    await expect(control).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a failed preview shows a visible error instead of a blank dialog", async ({ page }) => {
    const id = "conv_e2e_file_preview_error";
    await mockImage(page, { status: 502 });
    await openConversation(page, id, "[下载图片](/home/gem/workspace/garden-line-drawing.png)", "下载图片");
    await fileLink(page, "下载图片").click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("alert")).toContainText("无法加载文件", { timeout: 20_000 });
    await page.getByRole("button", { name: "关闭预览" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the preview is usable at 360px width", async ({ page }) => {
    const id = "conv_e2e_file_preview_360";
    await mockImage(page);
    await mockDownload(page);
    await page.setViewportSize({ width: 360, height: 640 });
    await openConversation(page, id, "[下载图片](/home/gem/workspace/garden-line-drawing.png)", "下载图片");
    await fileLink(page, "下载图片").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-image")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-download")).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  });

  test("a text workspace file previews as safe text and still downloads the original", async ({ page }) => {
    const id = "conv_e2e_file_download";
    await mockDownload(page);
    // A .txt is a supported preview kind now, so it opens the unified preview and
    // renders escaped text through /api/documents/text rather than downloading
    // straight away. The 下载 control must still fetch the original file.
    await page.route("**/api/documents/text**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ path: "/home/gem/workspace/report.txt", text: "hello 世界", size: 12, truncated: false }),
      }),
    );
    await openConversation(page, id, "[下载文本](/home/gem/workspace/report.txt)", "下载文本");
    await fileLink(page, "下载文本").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-text")).toHaveText("hello 世界", { timeout: 20_000 });

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("file-preview-download").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("report.txt");
  });
});
