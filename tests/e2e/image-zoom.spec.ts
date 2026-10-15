import { test, expect, type Page } from "@playwright/test";
import zlib from "node:zlib";
import { mockConsole } from "./mock-api";

/** A real PNG of the given size (one flat color). */
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x6a)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const PATH = "/home/gem/workspace/tasks/task-1/辅食表.png";

async function open(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockConsole(page, { conversations: [] });
  const task = { id: "task-1", revision: 1, title: "辅食表", text: "做一张辅食表", conversationId: "child-1", status: "completed", result: `做好了：\n\n![辅食表](${PATH})`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  await page.route("**/api/documents/image**", (r) => r.fulfill({ contentType: "image/png", body: solidPng(600, 1400) }));
  await page.goto("/");
  await page.locator(".bubble img.inline-media").click();
  const image = page.getByTestId("file-preview-image");
  await expect(image).toBeVisible();
  // Measured once the preview has settled (it slides in).
  let last = "";
  await expect.poll(async () => { const box = JSON.stringify(await image.boundingBox()); const same = box === last; last = box; return same; }, { intervals: [100] }).toBe(true);
  return image;
}

/** Touch pointers on the picture, as a finger would send them (Playwright has no multi-touch). */
async function touch(page: Page, type: "pointerdown" | "pointermove" | "pointerup", points: Array<[id: number, x: number, y: number]>) {
  await page.getByTestId("file-preview-image").evaluate((el, { type, points }) => {
    for (const [pointerId, clientX, clientY] of points) {
      el.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: "touch", isPrimary: pointerId === 1, clientX, clientY, bubbles: true, cancelable: true }));
    }
  }, { type, points });
}

const zoom = async (page: Page) => Number(await page.getByTestId("file-preview-image").getAttribute("data-zoom"));

test("two fingers zoom the picture around them, one finger moves it, a double tap fits it again", async ({ page }, info) => {
  const image = await open(page);
  const box = (await image.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // The picture takes its own gestures; the page never zooms.
  expect(await image.evaluate((el) => getComputedStyle(el).touchAction)).toBe("none");

  await touch(page, "pointerdown", [[1, cx - 20, cy], [2, cx + 20, cy]]);
  await touch(page, "pointermove", [[1, cx - 60, cy], [2, cx + 60, cy]]);
  await touch(page, "pointerup", [[1, cx - 60, cy], [2, cx + 60, cy]]);
  expect(await zoom(page)).toBeCloseTo(3, 1);
  // The point between the fingers stayed where it was.
  const zoomed = (await image.boundingBox())!;
  expect(zoomed.x + (cx - box.x) * 3).toBeCloseTo(cx, 0);
  expect(zoomed.y + (cy - box.y) * 3).toBeCloseTo(cy, 0);
  // Zoomed, it is clipped to the preview: nothing scrolls, the page does not widen.
  expect(await page.locator(".file-preview-body").evaluate((el) => getComputedStyle(el).overflow)).toBe("hidden");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("zoomed.png") });

  // One finger drags it; it never leaves a gap at an edge.
  await touch(page, "pointerdown", [[3, cx, cy]]);
  await touch(page, "pointermove", [[3, cx + 5000, cy + 5000]]);
  await touch(page, "pointerup", [[3, cx + 5000, cy + 5000]]);
  const dragged = (await image.boundingBox())!;
  expect(dragged.x).toBeCloseTo(box.x, 0);
  expect(dragged.y).toBeCloseTo(box.y, 0);

  // Two quick taps: back to the whole picture; two more: zoomed in where tapped.
  for (const _ of [0, 1]) { await touch(page, "pointerdown", [[4, cx, cy]]); await touch(page, "pointerup", [[4, cx, cy]]); }
  expect(await zoom(page)).toBe(1);
  for (const _ of [0, 1]) { await touch(page, "pointerdown", [[5, cx, cy]]); await touch(page, "pointerup", [[5, cx, cy]]); }
  expect(await zoom(page)).toBeCloseTo(2.5, 1);
  // Closing and opening again starts from the whole picture.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("file-preview-image")).toHaveCount(0);
  await page.locator(".bubble img.inline-media").click();
  await expect(page.getByTestId("file-preview-image")).toHaveAttribute("data-zoom", "1.00");
});

test("on a computer a trackpad pinch (ctrl+wheel) zooms and a double click fits it again", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "mouse and trackpad");
  const image = await open(page);
  const box = (await image.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(() => zoom(page)).toBeGreaterThan(2);
  // The page itself did not zoom or scroll.
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  await image.dblclick();
  expect(await zoom(page)).toBe(1);
  await image.dblclick();
  expect(await zoom(page)).toBeCloseTo(2.5, 1);
});
