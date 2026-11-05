import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

/**
 * A video (or audio clip) a reply plays where it stands has a 下载 of its own on
 * its card: the player's controls have no save, and in the iOS app nothing on
 * the video saves it. In a browser it is a download; in the iOS app (the
 * `aioSaveFiles` marker) and a home-screen web app it is the share sheet, whose
 * "Save Video" puts it in Photos. The share sheet is stood in for here.
 */
const PATH = "/home/gem/workspace/tasks/task-1/roy-mama.mp4";
const MP4 = fs.readFileSync(new URL("../fixtures/preview.mp4", import.meta.url));

async function setup(page: Page, opts: { shell?: "app" | "old-app" } = {}) {
  if (opts.shell) {
    await page.addInitScript((marker) => {
      const handler = { postMessage: () => undefined };
      Object.assign(window, { webkit: { messageHandlers: marker ? { aioDeviceBrowser: handler, aioSaveFiles: handler } : { aioDeviceBrowser: handler } } });
      const shared: { name: string; type: string; size: number }[] = [];
      Object.assign(window, { __shared: shared });
      Object.defineProperty(navigator, "canShare", { value: () => true });
      Object.defineProperty(navigator, "share", {
        value: async (data: { files: File[] }) => { for (const f of data.files) shared.push({ name: f.name, type: f.type, size: f.size }); },
      });
    }, opts.shell === "app");
  }
  await mockConsole(page, { conversations: [] });
  const task = { id: "task-1", revision: 1, title: "保存 Roy 喊妈妈的原声视频", text: "把 Roy 喊妈妈的视频存一份", conversationId: "child-1", status: "completed", result: `存好了：\n\n![Roy 喊妈妈](${PATH})`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  await page.route("**/api/documents/media**", (r) => r.fulfill({ contentType: "video/mp4", body: MP4 }));
  await page.route("**/api/files/download**", (r) => r.fulfill({ headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" }, body: MP4 }));
  await page.goto("/");
  const card = page.locator('figure.media-card[data-kind="video"]');
  await expect(card.locator("video.inline-media")).toBeVisible();
  // The first-load cover lifts once its mark finishes a stroke.
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  const save = card.getByRole("button", { name: "下载 Roy 喊妈妈", exact: true });
  await expect(save).toBeVisible();
  await expect(save).toHaveText("下载");
  return { card, save };
}

const shared = (page: Page) => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared);

test("a video in a reply has a visible 下载 that downloads it in a browser", async ({ page }, info) => {
  const { card, save } = await setup(page);
  // On the card's title row, beside the title, and the card still fits the phone.
  const [box, cardBox] = [await save.boundingBox(), await card.boundingBox()];
  expect(box!.x + box!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await card.screenshot({ path: info.outputPath("video-card.png") });
  await page.screenshot({ path: info.outputPath("video-reply.png") });
  const download = page.waitForEvent("download");
  await save.click();
  expect((await download).suggestedFilename()).toBe("roy-mama.mp4");
  // Saving does not open the preview.
  await expect(page.getByTestId("file-preview-download")).toHaveCount(0);
});

test("from the keyboard too", async ({ page }) => {
  const { save } = await setup(page);
  const download = page.waitForEvent("download");
  await save.focus();
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toBe("roy-mama.mp4");
});

test("in the iOS app 下载 hands the video to the share sheet as a video (Save Video)", async ({ page }) => {
  const { save } = await setup(page, { shell: "app" });
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await save.click();
  await expect.poll(() => shared(page)).toEqual([{ name: "roy-mama.mp4", type: "video/mp4", size: MP4.length }]);
  expect(downloaded).toBe(false);
  await expect(page.getByTestId("file-preview-download")).toHaveCount(0);
});

test("an older iOS app without the Photos permission keeps the plain download", async ({ page }) => {
  const { save } = await setup(page, { shell: "old-app" });
  const download = page.waitForEvent("download");
  await save.click();
  expect((await download).suggestedFilename()).toBe("roy-mama.mp4");
  expect(await shared(page)).toEqual([]);
});

test("the title still opens the preview", async ({ page }) => {
  const { card } = await setup(page);
  await card.locator("figcaption a").click();
  await expect(page.getByTestId("file-preview-download")).toBeVisible();
});
