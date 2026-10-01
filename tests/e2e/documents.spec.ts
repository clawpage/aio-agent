import { HTML_PREVIEW_CSP, htmlPreviewDocument } from "../../src/server/documents/html";
import { expect, test, type Page, type Route } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";
import fs from "node:fs";

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

test.describe("rich messages", () => {
  test("an embedded workspace image shows where it was written, loads through the documents API and opens the preview", async ({ page }) => {
    await mockDocuments(page);
    const id = "conv_e2e_inline_image";
    await mockConsole(page, { conversations: [makeConversation(id, "图文")], sse: { [id]: sseWithMarkdown("花园如下：\n\n![花园](/home/gem/workspace/garden.png)\n\n后面的说明文字") } });
    await page.goto("/");
    const img = page.locator(".markdown img[data-sandbox-image]");
    await expect(img).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // In place, between the two paragraphs, and not repeated as a card below.
    const order = await page.locator(".markdown").last().evaluate((el) => [...el.children].map((c) => c.tagName === "P" ? (c.querySelector("img") ? "IMG" : c.textContent) : c.tagName));
    expect(order).toEqual(["花园如下：", "IMG", "后面的说明文字"]);
    await expect(page.getByTestId("message-file-cards")).toHaveCount(0);
    await img.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("a share page link becomes a card with the full address that copies and opens", async ({ page, browserName }, info) => {
    if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    const id = "conv_e2e_share_card";
    const url = "https://agent-workspace.clawpage.ai/u/owner/share/tokyo-trip/";
    await mockConsole(page, { conversations: [makeConversation(id, "分享")], sse: { [id]: sseWithMarkdown(`页面做好了：[东京三日行程](${url})，代码里的 \`${url}\` 不算。`) } });
    await page.goto("/");
    const card = page.getByTestId("share-card");
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    await expect(card).toContainText("东京三日行程");
    await expect(card.getByTestId("share-card-url")).toHaveText(url);
    await expect(card.getByRole("link", { name: "打开" })).toHaveAttribute("href", url);
    await expect(card.getByRole("link", { name: "打开" })).toHaveAttribute("target", "_blank");
    await card.getByRole("button", { name: "复制链接" }).click();
    if (browserName === "chromium") {
      await expect(card.getByRole("button", { name: "已复制" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    } else {
      await expect(card.getByRole("button", { name: /已复制|复制失败/ })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("share-card.png") });
  });
});

test.describe("in-conversation file cards", () => {
  test("MP4 card plays, seeks, closes and opens from the workspace on mobile too",async({page},info)=>{
    const videoPath='/home/gem/workspace/demo.MP4';
    const bytes=fs.readFileSync(new URL('../fixtures/preview.mp4',import.meta.url));
    await mockDocuments(page,{files:{'/home/gem/workspace':[{name:'demo.MP4',path:videoPath,size:bytes.length,is_directory:false}]}});
    await page.route('**/api/documents/video**',route=>{
      const range=route.request().headers()['range'];const match=/bytes=(\d+)-(\d*)/.exec(range??'');
      const start=match?Number(match[1]):0,end=match?.[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
      return route.fulfill({status:match?206:200,headers:{'content-type':'video/mp4','accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)});
    });
    await openConversation(page,'mp4-preview','[演示视频](/home/gem/workspace/demo.MP4)');
    await expect(page.getByTestId('file-card')).toHaveAttribute('data-kind','video');
    await expect(page.getByTestId('file-card')).toContainText('MP4 视频');
    await page.getByRole('button',{name:'预览 演示视频',exact:true}).click();
    const player=page.getByTestId('file-preview-video');
    await expect.poll(()=>player.evaluate(node=>(node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await expect(player).toHaveAttribute('playsinline','');await expect(player).toHaveJSProperty('paused',true);
    await player.evaluate(async node=>{const v=node as HTMLVideoElement;v.muted=true;await v.play();});
    await expect.poll(()=>player.evaluate(node=>(node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    await player.evaluate(node=>{const v=node as HTMLVideoElement;v.pause();v.currentTime=2;});
    await expect.poll(()=>player.evaluate(node=>(node as HTMLVideoElement).seeking)).toBe(false);
    await expect(player).toHaveJSProperty('currentTime',2);
    if(info.project.name.startsWith('mobile')) await page.setViewportSize({width:360,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:info.outputPath('mp4-preview.png')});
    await expect(page.getByTestId('file-preview-download')).toBeVisible();
    await page.getByRole('button',{name:'关闭预览'}).click();await expect(player).toHaveCount(0);
    await page.getByRole('button',{name:'工作区',exact:true}).first().click();await page.getByRole('tab',{name:'文件',exact:true}).click();
    await page.locator('.file-list > li').filter({hasText:'demo.MP4'}).getByRole('button',{name:'预览',exact:true}).click();
    await expect.poll(()=>player.evaluate(node=>(node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  });
  test("MP4 failures show a retry and preserve original download",async({page})=>{
    await mockDocuments(page);await page.route('**/api/documents/video**',r=>r.fulfill({status:404,body:'missing'}));
    await openConversation(page,'mp4-missing','[视频](/home/gem/workspace/missing.mp4)');
    await page.getByRole('button',{name:'预览 视频',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('视频无法播放');await expect(page.getByTestId('file-preview-download')).toBeVisible();
    await page.getByRole('button',{name:'重试',exact:true}).click();await expect(page.getByRole('alert')).toContainText('视频无法播放');
  });
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

test("Markdown deliverables have readable titles, formatted preview, source toggle and safe links", async ({ page }, info) => {
  await mockDocuments(page);
  const md = '# 三天两晚完整行程\n\n先看 **安排重点**。\n\n## 每日安排\n\n| 日期 | 活动 |\n| --- | --- |\n| 第一天 | 抵达休息 |\n| 第二天 | 湖边散步 |\n\n> 出发前确认开放时间。\n\n[官方信息](https://example.com/travel)\n\n' + Array.from({length:24},(_,i)=>`### 第 ${i+1} 项提醒\n\n保持舒适的节奏，预留休息时间。`).join('\n\n') + '\n\n最后一项检查';
  await page.route('**/api/documents/text**', r => r.fulfill({json:{text:md,truncated:false}}));
  let opened: string | null = null;
  await openConversation(page,'conv_markdown_reader','已整理好 [完整三天行程](/home/gem/workspace/long-trip-document.md)。');
  await page.route('**/api/browser/tabs',r=>{opened=r.request().postDataJSON().url;return r.fulfill({json:{ok:true}});});
  const card=page.getByTestId('file-card');
  await expect(card.locator('.file-card-name')).toHaveText('完整三天行程');
  await expect(card.locator('.file-card-badge')).toHaveText('MD');
  await card.getByRole('button',{name:'预览 完整三天行程'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{level:1})).toHaveText('三天两晚完整行程');
  await expect(dialog.locator('table')).toContainText('抵达休息');
  await expect(dialog.locator('blockquote')).toContainText('确认开放时间');
  await dialog.getByRole('button',{name:'原文',exact:true}).click();
  await expect(dialog.getByTestId('file-preview-text')).toContainText('# 三天两晚完整行程');
  await dialog.getByRole('button',{name:'阅读',exact:true}).click();
  for(const width of info.project.name.startsWith('mobile')?[390,360]:[1440]) {
    await page.setViewportSize({width,height:844});
    const body=dialog.locator('.file-preview-body');
    expect(await body.evaluate(el=>el.scrollHeight)).toBeGreaterThan(await body.evaluate(el=>el.clientHeight));
    await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await expect(dialog.getByText('最后一项检查',{exact:true})).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await body.evaluate(el=>{el.scrollTop=0;});
  }
  await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-result-preview/${info.project.name}-reader.png`,animations:'disabled'});
  await dialog.getByRole('link',{name:'官方信息'}).click();
  await expect.poll(()=>opened).toBe('https://example.com/travel');
  await expect(dialog).toHaveCount(0);
});

test("Markdown preview cannot execute HTML and truncated HTML stays source",async({page})=>{
  await mockDocuments(page);
  const content='# 安全文档\n\n<script>window.previewPwned=1</script><form action="https://evil.example"><input name="secret"><button>发送秘密</button></form><iframe src="https://evil.example"></iframe><img src=x onerror="window.previewPwned=1"><a href="javascript:alert(1)">危险链接</a>\n\n**可阅读内容**';
  await page.route('**/api/documents/text**',r=>r.fulfill({json:{text:content,truncated:true}}));
  await openConversation(page,'conv_safe_reader','[文档](/home/gem/workspace/safe.md) [网页源码](/home/gem/workspace/source.html)');
  await page.getByRole('button',{name:'预览 文档',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:'安全文档'})).toBeVisible();
  await expect(dialog.locator('script,iframe,form,input')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).previewPwned)).toBeUndefined();
  await expect(dialog.getByRole('status')).toContainText('仅显示开头部分');
  await dialog.getByRole('button',{name:'关闭预览'}).click();
  await page.getByRole('button',{name:'预览 网页源码',exact:true}).click();
  await expect(page.getByTestId('file-preview-text')).toContainText('<script>');
  await expect(page.getByTestId('file-preview-markdown')).toHaveCount(0);
});

test("HTML cards render interactive isolated pages with source and download on mobile",async({page},info)=>{
  await mockDocuments(page);
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:20px;font:16px system-ui;background:#eef4ff}button{padding:12px}.card{padding:16px;background:white;border-radius:16px}</style></head><body><h1>周末安排</h1><div class="card"><button onclick="this.textContent='已展开'">展开安排</button><p id="isolation"></p></div><script>
    try { parent.document.body.dataset.compromised='yes'; } catch(e) { document.querySelector('#isolation').textContent='已隔离'; }
    try { localStorage.setItem('bad','yes'); } catch(e) { document.body.dataset.storage='blocked'; }
    fetch('/api/status').then(()=>document.body.dataset.network='allowed').catch(()=>document.body.dataset.network='blocked');
  </script></body></html>`;
  await page.route('**/api/documents/text**',r=>r.fulfill({json:{text:html,truncated:false}}));
  await page.route('**/api/documents/html**',r=>r.fulfill({headers:{'content-type':'text/html; charset=utf-8','content-security-policy':HTML_PREVIEW_CSP},body:htmlPreviewDocument(html)}));
  await openConversation(page,'html-demo','[周末安排](/home/gem/workspace/demo.html)');
  await page.route('**/api/workspace/ticket',r=>r.fulfill({json:{url:'/api/documents/html?path=demo.html'}}));
  await page.getByRole('button',{name:'预览 周末安排',exact:true}).click();
  const frame=page.frameLocator('[data-testid="file-preview-html"]');
  await expect(frame.getByRole('heading',{name:'周末安排'})).toBeVisible();
  await frame.getByRole('button',{name:'展开安排'}).click();
  await expect(frame.getByRole('button',{name:'已展开'})).toBeVisible();
  await expect(frame.locator('#isolation')).toHaveText('已隔离');
  await expect(frame.locator('body')).toHaveAttribute('data-storage','blocked');
  await expect(frame.locator('body')).toHaveAttribute('data-network','blocked');
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'源码',exact:true}).click();
  await expect(page.getByTestId('file-preview-text')).toContainText('<script>');
  await dialog.getByRole('button',{name:'页面',exact:true}).click();
  await expect(frame.getByRole('heading',{name:'周末安排'})).toBeVisible();
  await expect(page.getByTestId('file-preview-download')).toBeVisible();
  for(const width of info.project.name.startsWith('mobile')?[390,360]:[1440]){
    await page.setViewportSize({width,height:844});
    const box=await page.getByTestId('file-preview-html').boundingBox();expect(box!.height).toBeGreaterThan(400);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-natural-followups/html-${info.project.name}.png`});
});
