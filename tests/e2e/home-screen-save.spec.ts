import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

/**
 * On an iPhone home-screen web app a download replaces the whole app with the
 * file, with no way back. There 下载 hands the file to the share sheet instead
 * ("Save Image"), and the console stays where it was. navigator.standalone and
 * the share sheet are stood in for here; elsewhere 下载 stays a real download.
 */
const PATH = "/home/gem/workspace/tasks/task-1/人物画像.png";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** standalone: a home-screen web app; app / old-app: the iOS app shell with and without the save marker. */
async function setup(page: Page, opts: { standalone?: boolean; shell?: "app" | "old-app"; refuseFirst?: boolean }) {
  if (opts.shell) {
    await page.addInitScript((marker) => {
      const handler = { postMessage: () => undefined };
      Object.assign(window, { webkit: { messageHandlers: marker ? { aioDeviceBrowser: handler, aioSaveFiles: handler } : { aioDeviceBrowser: handler } } });
    }, opts.shell === "app");
  }
  if (opts.standalone || opts.shell) {
    await page.addInitScript(({ refuseFirst, standalone }) => {
      const shared: { name: string; type: string; size: number }[] = [];
      let calls = 0;
      Object.assign(window, { __shared: shared });
      if (standalone) Object.defineProperty(navigator, "standalone", { get: () => true });
      Object.defineProperty(navigator, "canShare", { value: () => true });
      Object.defineProperty(navigator, "share", {
        value: async (data: { files: File[] }) => {
          calls += 1;
          // The tap that asked has expired by the time the file arrived.
          if (refuseFirst && calls === 1) throw new DOMException("expired", "NotAllowedError");
          for (const f of data.files) shared.push({ name: f.name, type: f.type, size: f.size });
        },
      });
    }, { refuseFirst: opts.refuseFirst ?? false, standalone: opts.standalone ?? false });
  }
  await mockConsole(page, { conversations: [] });
  const task = { id: "task-1", revision: 1, title: "画人物画像", text: "画一张我的人物画像", conversationId: "child-1", status: "completed", result: `画好了：\n\n![我眼中的你](${PATH})`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  await page.route("**/api/documents/image**", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("**/api/files/download**", (r) => r.fulfill({ headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" }, body: PNG }));
  await page.goto("/");
  await page.locator(".bubble img.inline-media").click();
  await expect(page.getByTestId("file-preview-download")).toBeVisible();
}

const shared = (page: Page) => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared);

test("on a home-screen app 下载 opens the share sheet and the console stays put", async ({ page }) => {
  await setup(page, { standalone: true });
  const before = page.url();
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.getByTestId("file-preview-download").click();
  await expect.poll(() => shared(page)).toEqual([{ name: "人物画像.png", type: "image/png", size: PNG.length }]);
  expect(downloaded).toBe(false);
  expect(page.url()).toBe(before);
  // Still the console: the preview is open and closes as before.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("when the tap has expired by the time the file arrives, one more tap saves it", async ({ page }, info) => {
  await setup(page, { standalone: true, refuseFirst: true });
  await page.getByTestId("file-preview-download").click();
  const notice = page.locator(".save-notice");
  await expect(notice).toBeVisible();
  await page.screenshot({ path: info.outputPath("save-notice.png") });
  await notice.getByRole("button").click();
  await expect.poll(() => shared(page)).toEqual([{ name: "人物画像.png", type: "image/png", size: PNG.length }]);
  await expect(notice).toHaveCount(0);
});

test("in a browser tab 下载 is still a real download", async ({ page }) => {
  await setup(page, { standalone: false });
  const download = page.waitForEvent("download");
  await page.getByTestId("file-preview-download").click();
  expect((await download).suggestedFilename()).toBe("人物画像.png");
});

test("in the iOS app 下载 opens the share sheet too, since its web view ignores download links", async ({ page }) => {
  await setup(page, { shell: "app" });
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.getByTestId("file-preview-download").click();
  await expect.poll(() => shared(page)).toEqual([{ name: "人物画像.png", type: "image/png", size: PNG.length }]);
  expect(downloaded).toBe(false);
});

test("an older iOS app without the Photos permission keeps the plain link (its Save Image tap would close it)", async ({ page }) => {
  await setup(page, { shell: "old-app" });
  const download = page.waitForEvent("download");
  await page.getByTestId("file-preview-download").click();
  expect((await download).suggestedFilename()).toBe("人物画像.png");
  expect(await shared(page)).toEqual([]);
});
