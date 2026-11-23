import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import { releaseSave, saveLog, stubSaveMedia } from "./save-media-stub";

/**
 * A file that is not a photo or video (a PDF, a spreadsheet, an archive) in an iOS app
 * whose shell has the `aioSaveToFiles` marker goes through the `aioSaveMedia` bridge
 * `to: "files"`: the app opens the full-screen "save to Files" picker, not the share
 * sheet that iOS 26 crops at a large text size. An image keeps going to Photos; an app
 * without the marker keeps the share sheet. The bridge and the sheet are stood in for.
 */
const PATH = "/home/gem/workspace/tasks/task-1/体检报告.pdf";
const PDF = Buffer.from("%PDF-1.4\n% stand-in\n");

async function setup(page: Page, opts: { files: boolean; cancelFiles?: boolean }) {
  await stubSaveMedia(page, "ios", { files: opts.files, cancelFiles: opts.cancelFiles });
  await mockConsole(page, { conversations: [] });
  const task = { id: "task-1", revision: 1, title: "整理体检报告", text: "把体检报告整理成 PDF", conversationId: "child-1", status: "completed", result: `整理好了：[体检报告](${PATH})`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  await page.route("**/api/files/download**", (r) => r.fulfill({ headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" }, body: PDF }));
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  const download = page.locator('[data-testid="file-card"] [data-testid="file-card-download"]');
  await expect(download).toBeVisible();
  return download;
}

test("in an iOS app that can, a PDF's 下载 goes to the Files picker, not the share sheet", async ({ page }, info) => {
  const download = await setup(page, { files: true });
  await download.click();
  // The bytes are on their way; the line goes once the picker is up, so it does not sit under it.
  await expect.poll(() => saveLog(page)).toMatchObject({ begun: [{ name: "体检报告.pdf", mime: "application/pdf", to: "files" }] });
  await expect.poll(async () => (await saveLog(page)).chunks).toBe(1);
  await expect(page.locator(".save-notice")).toHaveCount(0);
  // A second tap while the picker is up asks for no second one.
  await download.click();
  await releaseSave(page);
  await expect(page.locator(".save-notice")).toHaveText("已存到文件");
  await page.screenshot({ path: info.outputPath("saved-to-files.png") });
  const log = await saveLog(page);
  expect(log.begun).toHaveLength(1);
  expect(log.saved).toEqual([PDF.length]);
  expect(log.shared).toBe(0);
});

test("closing the Files picker without saving says nothing", async ({ page }) => {
  const download = await setup(page, { files: true, cancelFiles: true });
  await download.click();
  await expect.poll(async () => (await saveLog(page)).chunks).toBe(1);
  await releaseSave(page);
  await expect.poll(async () => (await saveLog(page)).begun.length).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.locator(".save-notice")).toHaveCount(0);
  expect((await saveLog(page)).shared).toBe(0);
  // And the next tap works again.
  await download.click();
  await expect.poll(async () => (await saveLog(page)).begun.length).toBe(2);
});

test("an iOS app without the marker keeps the share sheet for a PDF", async ({ page }) => {
  const download = await setup(page, { files: false });
  await download.click();
  await expect.poll(async () => (await saveLog(page)).shared).toBe(1);
  expect((await saveLog(page)).begun).toEqual([]);
});
