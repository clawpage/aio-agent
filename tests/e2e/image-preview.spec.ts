import { test, expect, type Page } from "@playwright/test";
import zlib from "node:zlib";
import { mockConsole } from "./mock-api";

/** A real PNG of the given size (one flat color): the preview's layout depends on the picture's proportions. */
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9a)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const PATH = "/home/gem/workspace/tasks/task-1/人物画像.png";

async function setup(page: Page, picture: Buffer) {
  await mockConsole(page, { conversations: [] });
  const task = { id: "task-1", revision: 1, title: "画人物画像", text: "画一张我的人物画像", conversationId: "child-1", status: "completed", result: `画好了：\n\n![我眼中的你](${PATH})\n\n要换风格告诉我。`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  await page.route("**/api/documents/image**", (r) => r.fulfill({ contentType: "image/png", body: picture }));
  await page.goto("/");
}

/** The whole picture lies inside the preview and inside the screen, nothing to scroll. */
async function fits(page: Page) {
  const image = page.getByTestId("file-preview-image");
  const body = page.locator(".file-preview-body");
  const [img, box, head] = await Promise.all([image.boundingBox(), body.boundingBox(), page.locator(".file-preview-head").boundingBox()]);
  const scrolls = await body.evaluate((n) => n.scrollHeight > n.clientHeight + 1);
  return { img: img!, box: box!, head: head!, scrolls };
}

for (const [label, size] of [["portrait", [1024, 1536]], ["landscape", [1536, 1024]]] as const) {
  test(`a generated ${label} picture opens whole in the preview, top included`, async ({ page }, info) => {
    await setup(page, solidPng(size[0], size[1]));
    const inline = page.locator(".bubble img.inline-media");
    await expect.poll(() => inline.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 60_000 }).toBe(size[0]);
    const viewports = info.project.name.startsWith("mobile") ? [page.viewportSize()!, { width: 390, height: 664 }, { width: 360, height: 640 }] : [page.viewportSize()!];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await inline.click();
      const image = page.getByTestId("file-preview-image");
      await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(size[0]);
      await expect.poll(async () => { const { img, box } = await fits(page); return img.y >= box.y - 1 && img.y + img.height <= box.y + box.height + 1; }).toBe(true);
      const { img, box, head, scrolls } = await fits(page);
      expect(scrolls).toBe(false);
      // The preview's own header is on screen, and so is the picture's bottom edge.
      expect(head.y).toBeGreaterThanOrEqual(0);
      expect(img.y + img.height).toBeLessThanOrEqual(viewport.height);
      expect(img.width / img.height).toBeCloseTo(size[0] / size[1], 1);
      // As large as the room allows: it fills the preview's width or its height, whichever binds.
      expect(img.width > box.width * 0.85 || img.height > box.height * 0.85).toBe(true);
      // Drawn, not just laid out: a decoded picture paints its pixels into the preview.
      await image.evaluate((el) => (el as HTMLImageElement).decode());
      await page.screenshot({ path: info.outputPath(`${label}-${viewport.width}x${viewport.height}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });
}
