import { expect, test, type Page, type Route } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * In-conversation file cards, the unified preview, and the merged 「文件」 tab.
 *
 * Everything runs against the real web bundle with every control-plane call
 * mocked: no deployment, no sandbox, no browser download of a real file. The
 * point is the wiring the user actually touches — a file reference in a reply
 * becomes a card, the card opens a preview with paging and a download control,
 * a failure is visible and recoverable, and the one 文件 tab browses directories
 * while offering document conversion for the formats the sandbox can handle.
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
  // A mutable tree: browse/upload/create/delete really change what the next
  // listing returns, so the spec asserts the wiring instead of a frozen fixture.
  const tree: Record<string, Array<{ name: string; path: string; size: number; is_directory: boolean }>> = {};
  for (const [dir, list] of Object.entries(opts.files ?? {})) tree[dir] = list.map((entry) => ({ ...entry }));
  const entryAt = (dir: string, full: string) => tree[dir]?.find((entry) => entry.path === full);

  await page.route((url) => url.pathname === "/api/files/list", (route) => {
    const dir = new URL(route.request().url()).searchParams.get("path") ?? "/home/gem/workspace";
    return json(route, { path: dir, files: tree[dir] ?? [] });
  });
  await page.route((url) => url.pathname === "/api/sandbox/upload", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { name?: string; dir?: string; contentBase64?: string };
    const dir = body.dir ?? "/home/gem/workspace";
    const name = body.name ?? "upload.bin";
    const path = `${dir}/${name}`;
    (tree[dir] ??= []).push({
      name,
      path,
      size: Buffer.from(body.contentBase64 ?? "", "base64").length,
      is_directory: false,
    });
    return json(route, { path, name, kind: "file", size: 0 });
  });
  await page.route((url) => url.pathname === "/api/files/write", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { path?: string; content?: string };
    const full = body.path ?? "";
    const dir = full.slice(0, full.lastIndexOf("/"));
    const name = full.slice(full.lastIndexOf("/") + 1);
    const existing = entryAt(dir, full);
    if (existing) existing.size = Buffer.byteLength(body.content ?? "");
    else (tree[dir] ??= []).push({ name, path: full, size: Buffer.byteLength(body.content ?? ""), is_directory: false });
    return json(route, { ok: true });
  });
  await page.route((url) => url.pathname === "/api/files/mkdir", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { path?: string };
    const full = body.path ?? "";
    const dir = full.slice(0, full.lastIndexOf("/"));
    (tree[dir] ??= []).push({ name: full.slice(full.lastIndexOf("/") + 1), path: full, size: 0, is_directory: true });
    return json(route, { ok: true });
  });
  await page.route((url) => url.pathname === "/api/files/delete", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { path?: string };
    for (const dir of Object.keys(tree)) {
      tree[dir] = tree[dir]!.filter((entry) => entry.path !== body.path);
    }
    return json(route, { ok: true });
  });
  await page.route((url) => url.pathname === "/api/files/read", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    return json(route, { path, content: "hello 世界" });
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

test.describe("unified 文件 tab", () => {
  /** Open the workspace and land on the 文件 tab. */
  async function openFiles(page: Page): Promise<void> {
    await page.getByRole("button", { name: "工作区" }).first().click();
    await page.getByRole("tab", { name: "文件" }).click();
  }

  test("there is exactly one file entry point and one file list", async ({ page }) => {
    await mockDocuments(page, { files: { "/home/gem/workspace": [] } });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_one_list", "文件")] });
    await page.goto("/");
    await openFiles(page);

    // The separate 「文档工具」 tab is gone, and 文件 is not duplicated.
    await expect(page.getByRole("tab", { name: "文档工具" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "文件" })).toHaveCount(1);
    // One directory state and one list: no second copy of the same files.
    await expect(page.locator(".file-list")).toHaveCount(1);
    await expect(page.locator(".files > .row input").first()).toHaveValue("/home/gem/workspace");
  });

  test("browse, upload, preview and convert in the same list", async ({ page }) => {
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
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_files_flow", "文件")] });
    await page.goto("/");
    await openFiles(page);

    // The workspace root has no files, only directories: click in, don't type.
    const uploads = page.locator(".file-list .file-name", { hasText: "uploads" });
    await expect(uploads).toBeVisible({ timeout: 20_000 });
    await uploads.click();
    const row = page.locator(".file-list .file-name", { hasText: "报告.docx" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".files > .row input").first()).toHaveValue("/home/gem/workspace/uploads");

    // Upload really lands in the directory on screen.
    await page.getByTestId("workspace-upload-input").setInputFiles({
      name: "笔记.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(page.locator(".file-list .file-name", { hasText: "笔记.txt" })).toBeVisible({ timeout: 20_000 });

    // Preview still opens the unified dialog from the row.
    await row.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("file-preview-download")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The conversion entry appears on the row, offering only real targets.
    await page.getByRole("button", { name: "转换 报告.docx" }).click();
    const panel = page.getByTestId("file-convert-panel");
    await expect(panel).toBeVisible();
    const options = await panel.locator("select option").allTextContents();
    expect(options).toContain("PDF");
    expect(options.some((o) => o.includes("Excel"))).toBe(false);

    await panel.getByRole("button", { name: "执行转换" }).click();
    // The panel is the durable record; the same text also appears as a toast.
    await expect(panel.locator(".banner")).toContainText("已生成 /home/gem/workspace/report.pdf", { timeout: 20_000 });
    // The output can be previewed and downloaded, and the current directory is
    // refreshed in place (still uploads/, never pulled back to the root).
    await expect(page.locator(".files > .row input").first()).toHaveValue("/home/gem/workspace/uploads");
    await expect(page.locator(".file-list .file-name", { hasText: "报告.docx" })).toBeVisible();
    const banner = panel.locator(".banner");
    await expect(banner.locator('a[download]')).toHaveAttribute("href", /documents\/download|files\/download/);
    await banner.getByRole("button", { name: "预览" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a not-ready toolchain is visible in a collapsed detail but never blocks files", async ({ page }) => {
    await mockDocuments(page, {
      readiness: { ...READINESS_READY, ready: false, authoringReady: false, missing: ["libreoffice"], error: "缺少 LibreOffice" },
      files: {
        "/home/gem/workspace": [
          { name: "报告.docx", path: "/home/gem/workspace/报告.docx", size: 2048, is_directory: false },
          { name: "说明.txt", path: "/home/gem/workspace/说明.txt", size: 32, is_directory: false },
        ],
      },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_files_bad", "文件")] });
    await page.goto("/");
    await openFiles(page);

    // Browsing and uploading ordinary files work with no document toolchain.
    await expect(page.locator(".file-list .file-name", { hasText: "报告.docx" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("workspace-upload-input")).toBeAttached();

    // The readiness detail is collapsed by default and states the real problem.
    const details = page.getByTestId("docs-processing");
    await expect(details).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("docs-readiness-badge")).not.toContainText("全部就绪");
    await details.locator(":scope > summary").click();
    await expect(page.getByRole("button", { name: "安装/修复" })).toBeVisible();
    await expect(details).toContainText("缺少 LibreOffice");
  });

  test("cancelling or leaving the directory clears the conversion selection", async ({ page }) => {
    await mockDocuments(page, {
      files: {
        "/home/gem/workspace": [
          { name: "uploads", path: "/home/gem/workspace/uploads", size: 0, is_directory: true },
        ],
        "/home/gem/workspace/uploads": [
          { name: "报告.docx", path: "/home/gem/workspace/uploads/报告.docx", size: 2048, is_directory: false },
        ],
      },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_files_stale", "文件")] });
    await page.goto("/");
    await openFiles(page);

    const pathInput = page.locator(".files > .row input").first();
    const panel = page.getByTestId("file-convert-panel");

    await page.locator(".file-list .file-name", { hasText: "uploads" }).click();
    await expect(pathInput).toHaveValue("/home/gem/workspace/uploads");

    // 取消 closes the panel and drops the selection.
    await page.getByRole("button", { name: "转换 报告.docx" }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "取消" }).click();
    await expect(panel).toHaveCount(0);

    // Leaving the directory must not carry the old selection with it.
    await page.getByRole("button", { name: "转换 报告.docx" }).click();
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "上一级" }).click();
    await expect(panel).toHaveCount(0);
    await expect(pathInput).toHaveValue("/home/gem/workspace");
  });

  test("a conversion finishing before a still-pending directory change never pulls the list back", async ({ page }) => {
    await mockDocuments(page, {
      files: {
        "/home/gem/workspace": [
          { name: "uploads", path: "/home/gem/workspace/uploads", size: 0, is_directory: true },
          { name: "projects", path: "/home/gem/workspace/projects", size: 0, is_directory: true },
        ],
        "/home/gem/workspace/uploads": [
          { name: "报告.docx", path: "/home/gem/workspace/uploads/报告.docx", size: 2048, is_directory: false },
        ],
        "/home/gem/workspace/projects": [
          { name: "计划.md", path: "/home/gem/workspace/projects/计划.md", size: 12, is_directory: false },
        ],
      },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_files_race", "文件")] });

    // Explicit gates, registered after mockDocuments so they win: the conversion
    // and the projects/ listing only answer when this spec says so. No sleeps.
    const gates: { convert?: () => void; projects?: () => void } = {};
    const convertRequests: string[] = [];
    const projectRequests: string[] = [];
    await page.route((url) => url.pathname === "/api/documents/convert", async (route) => {
      convertRequests.push(route.request().postData() ?? "");
      await new Promise<void>((resolve) => {
        gates.convert = resolve;
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ path: "/home/gem/workspace/uploads/报告.pdf", bytes: 4096 }),
      });
    });
    await page.route((url) => url.pathname === "/api/files/list", async (route) => {
      const dir = new URL(route.request().url()).searchParams.get("path") ?? "";
      if (dir === "/home/gem/workspace/projects") {
        projectRequests.push(dir);
        await new Promise<void>((resolve) => {
          gates.projects = resolve;
        });
      }
      const files =
        dir === "/home/gem/workspace"
          ? [
              { name: "uploads", path: "/home/gem/workspace/uploads", size: 0, is_directory: true },
              { name: "projects", path: "/home/gem/workspace/projects", size: 0, is_directory: true },
            ]
          : dir === "/home/gem/workspace/uploads"
            ? [{ name: "报告.docx", path: "/home/gem/workspace/uploads/报告.docx", size: 2048, is_directory: false }]
            : [{ name: "计划.md", path: "/home/gem/workspace/projects/计划.md", size: 12, is_directory: false }];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: dir, files }) });
    });

    await page.goto("/");
    await openFiles(page);

    const pathInput = page.locator(".files > .row input").first();
    const panel = page.getByTestId("file-convert-panel");

    // A: start a conversion in uploads/ and leave its response hanging.
    await page.locator(".file-list .file-name", { hasText: "uploads" }).click();
    await expect(pathInput).toHaveValue("/home/gem/workspace/uploads");
    await page.getByRole("button", { name: "转换 报告.docx" }).click();
    await panel.getByRole("button", { name: "执行转换" }).click();
    await expect.poll(() => convertRequests.length).toBe(1);

    // B: navigate to projects/ while its listing also hangs. Both requests are
    // now in flight; the still-open panel closes on navigation.
    await page.getByRole("button", { name: "上一级" }).click();
    await expect(pathInput).toHaveValue("/home/gem/workspace");
    await page.locator(".file-list .file-name", { hasText: "projects" }).click();
    await expect.poll(() => projectRequests.length).toBe(1);
    await expect(panel).toHaveCount(0);

    // Release the conversion first and let it be consumed. With the navigation
    // generation already advanced past the loading of uploads/, it must not
    // re-list the old directory (which would cancel B's pending listing).
    gates.convert?.();
    // Wait for the conversion response to be consumed (its toast is the visible
    // effect). Nothing here guesses timing: the gated listing for projects/ is
    // still pending at this point.
    await expect(page.locator(".toast")).toContainText("报告.pdf", { timeout: 20_000 });
    await expect(panel).toHaveCount(0);

    // Now let B answer: the user lands on projects/, and the old directory's
    // listing is neither restarted nor re-shown.
    gates.projects?.();
    await expect(pathInput).toHaveValue("/home/gem/workspace/projects");
    await expect(page.locator(".file-list .file-name", { hasText: "计划.md" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".file-list .file-name", { hasText: "报告.docx" })).toHaveCount(0);
    await expect(page.locator(".file-list .file-name", { hasText: "uploads" })).toHaveCount(0);
  });

  test("a slow text edit does not open its editor after the user changes directory", async ({ page }) => {
    await mockDocuments(page, {
      files: {
        "/home/gem/workspace": [
          { name: "uploads", path: "/home/gem/workspace/uploads", size: 0, is_directory: true },
        ],
        "/home/gem/workspace/uploads": [
          { name: "说明.txt", path: "/home/gem/workspace/uploads/说明.txt", size: 32, is_directory: false },
        ],
      },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_files_edit", "文件")] });
    await page.goto("/");
    await openFiles(page);

    const pathInput = page.locator(".files > .row input").first();
    const readGates: { release?: () => void } = {};
    const readRequests: string[] = [];
    await page.route((url) => url.pathname === "/api/files/read", async (route) => {
      readRequests.push(new URL(route.request().url()).searchParams.get("path") ?? "");
      await new Promise<void>((resolve) => {
        readGates.release = resolve;
      });
      const path = new URL(route.request().url()).searchParams.get("path") ?? "";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path, content: "hello" }) });
    });

    await page.locator(".file-list .file-name", { hasText: "uploads" }).click();
    await expect(pathInput).toHaveValue("/home/gem/workspace/uploads");
    await page.getByRole("button", { name: "编辑" }).click();
    await expect.poll(() => readRequests.length).toBe(1);

    // Leave the directory, then let the read come back: the editor must not open.
    await page.getByRole("button", { name: "上一级" }).click();
    await expect(pathInput).toHaveValue("/home/gem/workspace");
    readGates.release?.();
    // The stale read is dropped, so its editor never appears in the new directory.
    await expect(page.locator(".editor")).toHaveCount(0);
    await expect(pathInput).toHaveValue("/home/gem/workspace");
  });

  test("a long file name wraps its actions with no horizontal overflow on a phone", async ({ page }) => {
    const longName = "2026年第三季度财务分析与预算执行情况汇总报告最终版.docx";
    await mockDocuments(page, {
      files: {
        "/home/gem/workspace": [{ name: longName, path: `/home/gem/workspace/${longName}`, size: 2048, is_directory: false }],
      },
    });
    await mockConsole(page, { conversations: [makeConversation("conv_e2e_files_phone", "文件")] });
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/");
    await openFiles(page);

    await expect(page.locator(".file-list .file-name", { hasText: "2026年第三季度" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: `转换 ${longName}` }).click();

    // Actions wrap inside the row instead of widening the panel, and the long
    // name is truncated rather than pushing the layout out.
    const row = page.locator(".file-list li").first();
    const rowBox = await row.boundingBox();
    expect(rowBox).not.toBeNull();
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(360);

    const nameClipped = await page
      .locator(".file-list .file-name")
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(nameClipped).toBe(true);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    const panel = page.getByTestId("file-convert-panel");
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(360);
  });
});
