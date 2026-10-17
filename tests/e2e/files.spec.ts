import { test, expect, type Page } from "@playwright/test";
import zlib from "node:zlib";
import { makeConversation, mockConsole } from "./mock-api";
import type { FileMessage } from "../../src/ui/src/types";

/** A real PNG (one flat color), so the thumbnails actually draw. */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7a)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const WS = "/home/gem/workspace";
const now = Date.now();
const message = (taskId: string, title: string, at: number, result: string | null, attachments: FileMessage["attachments"] = []): FileMessage =>
  ({ taskId, title, createdAt: at, completedAt: result ? at + 60_000 : null, attachments, result });

/** Two pages: the second comes on its own, since the first does not fill the screen. */
const PAGES: Record<string, { messages: FileMessage[]; nextBefore: number | null }> = {
  first: {
    messages: [
      message("t-report", "做一份季度报告", now - 3_600_000, `做好了：\n\n![销售趋势](${WS}/tasks/t-report/chart.png)\n\n[季度报告](${WS}/tasks/t-report/report.docx)，参考了 [官网](https://example.com/q3.pdf)。`),
      message("t-photo", "看看这张照片", now - 7_200_000, "照片里是一只猫。", [
        { path: `${WS}/uploads/cat.jpg`, name: "cat.jpg", kind: "image", size: 1 },
        { path: `${WS}/uploads/体检报告.pdf`, name: "体检报告.pdf", kind: "file", size: 1 },
      ]),
    ],
    nextBefore: 100,
  },
  older: { messages: [message("t-cry", "录一段哭声", 50, `[哭声（23 秒）](${WS}/tasks/t-cry/cry.mp3)`)], nextBefore: null },
};

async function setup(page: Page, pages = PAGES) {
  const asked: string[] = [];
  await mockConsole(page, { conversations: [makeConversation("c-report", "做一份季度报告")] });
  await page.route((url) => url.pathname === "/api/main", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null, version: "v1" } }));
  await page.route((url) => url.pathname === "/api/main/files", (r) => {
    const before = new URL(r.request().url()).searchParams.get("before");
    asked.push(before ?? "first");
    return r.fulfill({ json: before ? pages.older : pages.first });
  });
  await page.route("**/api/documents/image**", (r) => r.fulfill({ contentType: "image/png", body: solidPng(320, 240) }));
  await page.route((url) => url.pathname === "/api/tasks/t-report", (r) => r.fulfill({ json: { task: { id: "t-report", revision: 1, title: "做一份季度报告", text: "做一份季度报告", conversationId: "c-report", status: "completed", result: "做好了", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: now - 3_600_000, completedAt: now } } }));
  return asked;
}

test("the files page gathers the main session's files by type, and leads back to where each came from", async ({ page }, info) => {
  const asked = await setup(page);
  await page.goto("/u/owner");
  const mobile = (page.viewportSize()?.width ?? 1440) < 900;
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "文件库", exact: true }).click();
  await expect(page).toHaveURL(/\/u\/owner\/files$/);
  await expect(page.getByRole("heading", { name: "文件库" })).toBeVisible();
  if (mobile) {
    // The title leaves room for the menu button over the header's corner.
    const menu = (await page.getByRole("button", { name: "打开导航" }).boundingBox())!, title = (await page.getByRole("heading", { name: "文件库" }).boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(menu.x + menu.width);
  }

  const list = page.getByTestId("library-files");
  const paths = () => list.locator("li").evaluateAll((items) => items.map((li) => li.getAttribute("data-path")));
  // Newest first, the reply's files before what was sent with it, the older page after; the web link is not a file.
  await expect.poll(paths).toEqual([
    `${WS}/tasks/t-report/chart.png`, `${WS}/tasks/t-report/report.docx`,
    `${WS}/uploads/cat.jpg`, `${WS}/uploads/体检报告.pdf`, `${WS}/tasks/t-cry/cry.mp3`,
  ]);
  expect(asked).toEqual(["first", "100"]);
  await expect(page.getByText("example.com")).toHaveCount(0);
  const report = list.locator(`li[data-path="${WS}/tasks/t-report/report.docx"]`);
  await expect(report.getByTestId("file-card")).toContainText("季度报告");
  await expect(report.locator(".library-source")).toContainText("AI 回复");
  await expect(list.locator(`li[data-path="${WS}/uploads/cat.jpg"] .library-source`)).toContainText("你发送");
  await expect(page.getByText("没有更多了")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("files-all.png") });

  // Shelves by type: pictures as a grid of the pictures themselves.
  const shelf = (name: string) => page.getByRole("group", { name: "按类型筛选" }).getByRole("button", { name, exact: true });
  await shelf("图片").click();
  await expect(shelf("图片")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(paths).toEqual([`${WS}/tasks/t-report/chart.png`, `${WS}/uploads/cat.jpg`]);
  await expect(page.locator(".library-grid [data-testid=file-card-thumb]")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("files-images.png") });
  await shelf("文档").click();
  await expect.poll(paths).toEqual([`${WS}/tasks/t-report/report.docx`, `${WS}/uploads/体检报告.pdf`]);
  await shelf("音视频").click();
  await expect.poll(paths).toEqual([`${WS}/tasks/t-cry/cry.mp3`]);
  await shelf("其他").click();
  await expect(page.getByText("这一类还没有文件。")).toBeVisible();

  // A picture opens in the preview.
  await shelf("图片").click();
  await list.locator(`li[data-path="${WS}/uploads/cat.jpg"]`).getByRole("button", { name: "预览 cat.jpg" }).click();
  const dialog = page.getByRole("dialog", { name: "预览 cat.jpg" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭预览" }).click();
  await expect(dialog).toHaveCount(0);

  // The message a file came from opens, and its back button returns here.
  await shelf("全部").click();
  await report.getByRole("button", { name: "查看「做一份季度报告」的对话" }).click();
  await expect(page).toHaveURL(/\/u\/owner\/tasks\/t-report$/);
  await page.getByRole("button", { name: "← 返回文件库" }).click();
  await expect(page).toHaveURL(/\/u\/owner\/files$/);
  await expect(page.getByRole("heading", { name: "文件库" })).toBeVisible();
});

test("an account with no files yet is told how files get here", async ({ page }) => {
  await setup(page, { first: { messages: [], nextBefore: null }, older: { messages: [], nextBefore: null } });
  await page.goto("/u/owner/files");
  await expect(page.getByRole("heading", { name: "还没有文件" })).toBeVisible();
  await expect(page.getByRole("group", { name: "按类型筛选" })).toHaveCount(0);
});
