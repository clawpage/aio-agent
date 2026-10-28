import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { mockConsole } from "./mock-api";

const evidence = "var/.playwright-artifacts/photo-compare";

/** A solid-colour PNG, so the test can tell the original from the edit by their pixels. */
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const ORIGINAL = solidPng(300, 200, [200, 60, 60]);
const EDITED = solidPng(300, 200, [60, 160, 90]);

const items = [
  { before: "/home/gem/workspace/uploads/IMG_1.jpg", after: "/home/gem/workspace/tasks/task-1/IMG_1-修图.jpg", title: "海边夕阳", note: "提亮人物，压回天空，自然磨皮" },
  { before: "/home/gem/workspace/uploads/IMG_2.jpg", after: "/home/gem/workspace/tasks/task-1/IMG_2-修图.jpg" },
];

async function setup(page: Page) {
  const result = `两张都修好了：人物更亮，天空压回来了，肤质更干净。\n\n\`\`\`compare\n${JSON.stringify({ items })}\n\`\`\`\n\n[全部照片](/home/gem/workspace/tasks/task-1/photos.zip)`;
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [{ id: "task-1", revision: 1, title: "修两张照片", text: "帮我修一下", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() }], nextBefore: null } }));
  await page.route("**/api/documents/image*", (r) => r.fulfill({ contentType: "image/png", body: new URL(r.request().url()).searchParams.get("path")!.includes("/uploads/") ? ORIGINAL : EDITED }));
  await page.goto("/");
}

/** The colour on screen at a point inside the comparison, as the person sees it (a one-pixel screenshot, read in the page). */
async function colorAt(page: Page, x: number, y: number): Promise<"original" | "edited" | "other"> {
  const shot = (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString("base64");
  const [r, g] = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, shot);
  return r! > 150 && g! < 110 ? "original" : g! > 130 && r! < 110 ? "edited" : "other";
}

test("a compare block shows each retouched photo against its original: slide, hold, side by side, full size", async ({ page }, info) => {
  await setup(page);
  const cards = page.locator(".photo-compare");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  // What the person sees: the loading cover over the feed lifts at the end of its animation.
  await expect(page.locator(".boot-cover")).toHaveCount(0);
  const first = cards.first();
  await expect(first.locator(".photo-compare-title")).toHaveText("海边夕阳");
  await expect(first.locator(".photo-compare-note")).toHaveText("提亮人物，压回天空，自然磨皮");
  // Untitled photos are numbered.
  await expect(cards.nth(1).locator(".photo-compare-title")).toHaveText("第 2 张");
  const stage = first.getByRole("slider", { name: "拖动对比原图和修后" });
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("aria-valuenow", "50");
  await expect.poll(() => first.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([300, 300]);
  await expect(first.locator(".photo-compare-label.before")).toHaveText("原图");
  await expect(first.locator(".photo-compare-label.after")).toHaveText("修后");
  // The frame takes the photo's shape.
  const box = (await stage.boundingBox())!;
  expect(Math.abs(box.width / box.height - 1.5)).toBeLessThan(0.03);

  // The original is left of the handle, the edit right of it.
  const y = box.y + box.height * 0.6;

  expect(await colorAt(page, box.x + box.width * 0.25, y)).toBe("original");
  expect(await colorAt(page, box.x + box.width * 0.75, y)).toBe("edited");
  // Tap or drag moves the handle.
  await page.mouse.click(box.x + box.width * 0.1, y);
  await expect.poll(async () => Number(await stage.getAttribute("aria-valuenow"))).toBeLessThan(15);
  // Moving it never opens the message the comparison sits in.
  await expect(page.locator(".full-message")).toHaveCount(0);
  expect(await colorAt(page, box.x + box.width * 0.25, y)).toBe("edited");
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await stage.getAttribute("aria-valuenow"))).toBeGreaterThan(85);
  expect(await colorAt(page, box.x + box.width * 0.75, y)).toBe("original");
  // Keys too.
  await stage.focus();
  await page.keyboard.press("Home");
  await expect(stage).toHaveAttribute("aria-valuenow", "0");
  await page.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("aria-valuenow", "5");

  // Holding the button shows the whole original; letting go brings the edit back.
  const hold = first.getByRole("button", { name: "按住看原图" });
  const held = (await hold.boundingBox())!;
  await page.mouse.move(held.x + held.width / 2, held.y + held.height / 2);
  await page.mouse.down();
  expect(await colorAt(page, box.x + box.width * 0.75, y)).toBe("original");
  await page.mouse.up();
  expect(await colorAt(page, box.x + box.width * 0.75, y)).toBe("edited");

  // Side by side, and back.
  await first.getByRole("button", { name: "并排看" }).click();
  await expect(first.locator(".photo-compare-side img")).toHaveCount(2);
  await mkdir(evidence, { recursive: true });
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/${info.project.name}-side.png` });
  await first.getByRole("button", { name: "滑动对比" }).click();
  await expect(first.getByRole("slider")).toBeVisible();
  await page.screenshot({ path: `${evidence}/${info.project.name}-slider.png` });

  // Full size opens the edit in the file preview.
  await first.getByRole("button", { name: "查看大图" }).click();
  await expect(page.getByRole("dialog")).toContainText("IMG_1-修图.jpg");
  await page.keyboard.press("Escape");

  // The zip below the block stays a file link, and the page never scrolls sideways.
  await expect(page.locator("[data-sandbox-file='/home/gem/workspace/tasks/task-1/photos.zip']").first()).toBeVisible();
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
