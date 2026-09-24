import { expect, test, type Page, type Route } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * In-conversation file cards, the unified preview, and the 「文档工具」 tab.
 *
 * Everything runs against the real web bundle with every control-plane call
 * mocked: no deployment, no sandbox, no browser download of a real file. The
 * point is the wiring the user actually touches — a file reference in a reply
 * becomes a card, the card opens a preview with paging and a download control,
 * a failure is visible and recoverable, and the docs tab navigates directories.
 */

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

const READINESS_READY = {
  enabled: true,
  ready: true,
  previewReady: true,
  authoringReady: true,
  version: "aio-doc-tools-v1",
  tools: { soffice: true, pdftoppm: true, pdfinfo: true, cjkFont: true, aioDocCli: true },
  python: { docx: true, openpyxl: true, pptx: true },
  missing: [],
  error: null,
  checkedAt: Date.now(),
};

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

/** Mock the document endpoints used by the card, the preview and the docs tab. */
async function mockDocuments(
  page: Page,
  opts: {
    readiness?: unknown;
    render?: { status?: number; pageCount?: number; totalPages?: number; truncated?: boolean };
    pageFail?: boolean;
    files?: Record<string, Array<{ name: string; path: string; size: number; is_directory: boolean }>>;
    convert?: { status?: number; path?: string };
  } = {},
): Promise<void> {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route((url) => url.pathname === "/api/documents/readiness", (route) =>
    json(route, opts.readiness ?? READINESS_READY),
  );
  await page.route((url) => url.pathname === "/api/documents/image", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG }),
  );
  await page.route((url) => url.pathname === "/api/documents/render", (route) => {
    if (opts.render?.status && opts.render.status !== 200) {
      return json(route, { error: "render_failed", message: "转换失败：文件可能已损坏" }, opts.render.status);
    }
    return json(route, {
      path: new URL(route.request().url()).searchParams.get("path") ?? "",
      kind: "word",
      pageCount: opts.render?.pageCount ?? 3,
      totalPages: opts.render?.totalPages ?? 3,
      truncated: opts.render?.truncated ?? false,
      size: 2048,
    });
  });
  await page.route((url) => url.pathname === "/api/documents/page", (route) => {
    if (opts.pageFail) return route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
  });
  await page.route((url) => url.pathname === "/api/documents/text", (route) =>
    json(route, { path: "", text: "hello 世界", size: 12, truncated: false }),
  );
  await page.route((url) => url.pathname === "/api/documents/convert", (route) => {
    if (opts.convert?.status && opts.convert.status !== 200) {
      return json(route, { error: "convert_failed", message: "转换失败" }, opts.convert.status);
    }
    return json(route, { path: opts.convert?.path ?? "/home/gem/workspace/report.pdf", bytes: 4096 });
  });
  await page.route((url) => url.pathname === "/api/documents/info", (route) =>
    json(route, { path: "", kind: "word", size: 2048, renderable: true, textPreviewable: false }),
  );
  await page.route((url) => url.pathname === "/api/files/list", (route) => {
    const dir = new URL(route.request().url()).searchParams.get("path") ?? "/home/gem/workspace";
    const files = opts.files?.[dir] ?? [];
    return json(route, { path: dir, files });
  });
  await page.route((url) => url.pathname === "/api/files/download", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.docx"' },
      body: TINY_PNG,
    }),
  );
}

async function openConversation(page: Page, id: string, markdown: string): Promise<void> {
  await mockConsole(page, { conversations: [makeConversation(id, "文档")], sse: { [id]: sseWithMarkdown(markdown) } });
  await page.goto("/");
  await expect(page.getByTestId("message-file-cards")).toBeVisible({ timeout: 60_000 });
}

test.describe("in-conversation file cards", () => {
  test("a Markdown file reference becomes a card with a thumbnail and a download link", async ({ page }) => {
    await mockDocuments(page);
    await openConversation(page, "conv_e2e_cards", "结果见 [报告](/home/gem/workspace/report.docx) 和 [图片](/home/gem/workspace/garden.png)");

    const cards = page.getByTestId("file-card");
    await expect(cards).toHaveCount(2);
    // Word gets a badge (no raster thumbnail); the image gets a real thumbnail.
    await expect(page.locator('[data-testid="file-card"][data-kind="word"]')).toBeVisible();
    const thumb = page.locator('[data-testid="file-card"][data-kind="image"] [data-testid="file-card-thumb"]');
    await expect(thumb).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // The card offers a direct download without opening the dialog first.
    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-testid="file-card"][data-kind="word"] [data-testid="file-card-download"]').click();
    expect((await downloadPromise).suggestedFilename()).toContain("report.docx");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a reference inside a fenced code block does not produce a card", async ({ page }) => {
    await mockDocuments(page);
    await openConversation(page, "conv_e2e_cards_code", "示例：\n\n```\n[not a file](/home/gem/workspace/fake.png)\n```\n\n真文件：[报告](/home/gem/workspace/report.docx)");

    const cards = page.getByTestId("file-card");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("data-path", "/home/gem/workspace/report.docx");
  });
});

test.describe("unified preview", () => {
  test("a rasterised document previews with working paging", async ({ page }) => {
    await mockDocuments(page, { render: { pageCount: 3, totalPages: 5, truncated: true } });
    await openConversation(page, "conv_e2e_preview_pages", "[报告](/home/gem/workspace/report.docx)");

    await page.getByTestId("file-card").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-page")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-pageno")).toContainText("1 / 3");
    // The truncation must be stated, not silently hidden.
    await expect(page.getByTestId("file-preview-pageno")).toContainText("共 5 页");

    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByTestId("file-preview-pageno")).toContainText("2 / 3");
    await page.getByRole("button", { name: "上一页" }).click();
    await expect(page.getByTestId("file-preview-pageno")).toContainText("1 / 3");

    // Download stays available from the preview footer.
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("file-preview-download").click();
    expect((await downloadPromise).suggestedFilename()).toContain("report.docx");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a failed conversion shows a recoverable error, never a blank success", async ({ page }) => {
    await mockDocuments(page, { render: { status: 422 } });
    await openConversation(page, "conv_e2e_preview_fail", "[报告](/home/gem/workspace/report.docx)");

    await page.getByTestId("file-card").first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("alert")).toContainText("转换失败", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
    // The original file is still downloadable even though the preview failed.
    await expect(page.getByTestId("file-preview-download")).toBeVisible();
  });

  test("a page that cannot be displayed reports it instead of an empty frame", async ({ page }) => {
    await mockDocuments(page, { pageFail: true });
    await openConversation(page, "conv_e2e_preview_pagefail", "[报告](/home/gem/workspace/report.docx)");
    await page.getByTestId("file-card").first().click();
    await expect(page.getByRole("alert")).toContainText("这一页无法显示", { timeout: 20_000 });
  });

  test("the preview fits a 360px viewport without horizontal overflow", async ({ page }) => {
    await mockDocuments(page, { render: { pageCount: 2, totalPages: 2 } });
    await page.setViewportSize({ width: 360, height: 640 });
    await openConversation(page, "conv_e2e_preview_360", "[报告](/home/gem/workspace/report.docx)");
    await page.getByTestId("file-card").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
    // The page itself must not scroll sideways either.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("文档工具 tab", () => {
  test("lists directories so uploads/ is reachable, and converts a selected file", async ({ page }) => {
    await mockDocuments(page, {
      files: {
        "/home/gem/workspace": [
          { name: "uploads", path: "/home/gem/workspace/uploads", size: 0, is_directory: true },
          { name: "projects", path: "/home/gem/workspace/projects", size: 0, is_directory: true },
        ],
        "/home/gem/workspace/uploads": [
          { name: "报告.docx", path: "/home/gem/workspace/uploads/报告.docx", size: 2048, is_directory: false },
        ],
      },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_docs", "文档")] });
    await page.goto("/");

    await page.getByRole("button", { name: "工作区" }).first().click();
    await page.getByRole("tab", { name: "文档工具" }).click();

    // Readiness is shown honestly, with the underlying library collapsed.
    await expect(page.getByTestId("docs-readiness-badge")).toContainText("全部就绪");

    // The workspace root has no files, only directories: the user must be able
    // to click into uploads/ instead of typing an absolute path.
    const uploads = page.locator(".docs-dirs .file-name", { hasText: "uploads" });
    await expect(uploads).toBeVisible({ timeout: 20_000 });
    await uploads.click();
    await expect(page.locator(".file-list .file-name", { hasText: "报告.docx" })).toBeVisible({ timeout: 20_000 });

    // Selecting it enables conversion, and only supported targets are offered.
    await page.locator(".file-list .file-name", { hasText: "报告.docx" }).click();
    const target = page.locator(".docs-actions select");
    await expect(target).toBeEnabled();
    const options = await target.locator("option").allTextContents();
    expect(options).toContain("PDF");
    expect(options.some((o) => o.includes("Excel"))).toBe(false);

    await page.getByRole("button", { name: "转换" }).click();
    // Scope to the panel's own status banner: the same text is also raised as a
    // toast (with a longer suffix), so a bare getByText would match two nodes and
    // fail strict mode. The banner is the panel's durable record of the result.
    await expect(page.locator(".docs-actions .banner")).toHaveText("已生成 /home/gem/workspace/report.pdf", {
      timeout: 20_000,
    });
  });

  test("reports a not-ready toolchain and offers install instead of pretending", async ({ page }) => {
    await mockDocuments(page, {
      readiness: { ...READINESS_READY, ready: false, authoringReady: false, missing: ["libreoffice"], error: "缺少 LibreOffice" },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_docs_bad", "文档")] });
    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();
    await page.getByRole("tab", { name: "文档工具" }).click();

    await expect(page.getByTestId("docs-readiness-badge")).not.toContainText("全部就绪");
    await expect(page.getByRole("button", { name: "安装/修复" })).toBeVisible();
    await expect(page.getByText("缺少 LibreOffice")).toBeVisible();
  });
});
