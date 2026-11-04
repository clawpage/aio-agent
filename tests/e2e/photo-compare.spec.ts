import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { mockConsole } from "./mock-api";

const evidence = "var/.playwright-artifacts/photo-compare";

/** A PNG drawn pixel by pixel. */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (_, x) => pixel(x, y)).flat())]));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
/** A solid-colour PNG, so the test can tell the original from the edit by their pixels. */
const solidPng = (w: number, h: number, rgb: [number, number, number]) => png(w, h, () => rgb);
const ORIGINAL = solidPng(300, 200, [200, 60, 60]);
const EDITED = solidPng(300, 200, [60, 160, 90]);

/**
 * A cropped pair: a 3:4 original with soft shapes in it (so the two can be lined up), and a 4:5
 * edit that keeps 240 × 300 of it from (30, 70), recoloured. Brightness stays within 85–100 %, so
 * each still reads as its colour anywhere.
 */
const shapes = [[60, 50, 30], [220, 120, 45], [120, 200, 40], [250, 300, 35], [90, 330, 50], [170, 360, 25], [40, 250, 20], [200, 30, 22]] as const;
const shade = (x: number, y: number) => 1 - 0.15 * Math.max(0, ...shapes.map(([cx, cy, r]) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (r * r))));
const tint = (rgb: [number, number, number], k: number) => rgb.map((c) => Math.round(c * k)) as [number, number, number];
const CROP_ORIGINAL = png(300, 400, (x, y) => tint([200, 60, 60], shade(x, y)));
const CROP_EDITED = png(240, 300, (x, y) => tint([60, 160, 90], shade(x + 30, y + 70)));
const croppedItems = [
  { before: "/home/gem/workspace/uploads/IMG_3.jpg", after: "/home/gem/workspace/tasks/task-1/IMG_3-裁剪.jpg", title: "裁掉上方空白" },
  { before: "/home/gem/workspace/uploads/IMG_4.jpg", after: "/home/gem/workspace/tasks/task-1/IMG_4-修图.jpg", title: "换了张图" },
];

const items = [
  { before: "/home/gem/workspace/uploads/IMG_1.jpg", after: "/home/gem/workspace/tasks/task-1/IMG_1-修图.jpg", title: "海边夕阳", note: "提亮人物，压回天空，自然磨皮" },
  { before: "/home/gem/workspace/uploads/IMG_2.jpg", after: "/home/gem/workspace/tasks/task-1/IMG_2-修图.jpg" },
];

async function setup(page: Page, pairs: { before: string; after: string; title?: string; note?: string }[] = items, image = (path: string) => path.includes("/uploads/") ? ORIGINAL : EDITED) {
  const result = `两张都修好了：人物更亮，天空压回来了，肤质更干净。\n\n\`\`\`compare\n${JSON.stringify({ items: pairs })}\n\`\`\`\n\n[全部照片](/home/gem/workspace/tasks/task-1/photos.zip)`;
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [{ id: "task-1", revision: 1, title: "修两张照片", text: "帮我修一下", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() }], nextBefore: null } }));
  await page.route("**/api/documents/image*", (r) => r.fulfill({ contentType: "image/png", body: image(new URL(r.request().url()).searchParams.get("path")!) }));
  await page.goto("/");
}

/** The colour on screen at a point inside the comparison, as the person sees it (a one-pixel screenshot, read in the page). */
async function rgbAt(page: Page, x: number, y: number): Promise<number[]> {
  const shot = (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, shot);
}
async function colorAt(page: Page, x: number, y: number): Promise<"original" | "edited" | "other"> {
  const [r, g] = await rgbAt(page, x, y);
  return r! > 150 && g! < 110 ? "original" : g! > 130 && r! < 110 ? "edited" : "other";
}

/** A finger pressing and lifting at a point: real touches where the browser can take them (Chromium), touch pointers otherwise. */
const touchSessions = new WeakMap<Page, CDPSession>();
async function finger(page: Page, type: "down" | "up", x: number, y: number) {
  if (page.context().browser()?.browserType().name() === "chromium") {
    // One session for the whole touch: the browser ties a touch's end to the session that started it.
    let cdp = touchSessions.get(page);
    if (!cdp) touchSessions.set(page, cdp = await page.context().newCDPSession(page));
    await cdp.send("Input.dispatchTouchEvent", { type: type === "down" ? "touchStart" : "touchEnd", touchPoints: type === "down" ? [{ x, y }] : [] });
    return;
  }
  await page.evaluate(({ type, x, y }) => {
    const el = document.elementFromPoint(x, y)!;
    el.dispatchEvent(new PointerEvent(type === "down" ? "pointerdown" : "pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, { type, x, y });
}

test("a compare block shows each retouched photo, and its original while it is held", async ({ page }, info) => {
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
  const stage = first.getByRole("button", { name: "按住看原图" });
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("aria-pressed", "false");
  // Both pictures are loaded before anyone presses, so the original never flashes in blank.
  await expect.poll(() => first.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([300, 300]);
  // Nothing else to work: no slider, no mode switches.
  await expect(first.getByRole("slider")).toHaveCount(0);
  await expect(first.getByRole("button")).toHaveCount(2);
  const hint = first.locator(".photo-compare-hint");
  await expect(hint).toHaveText("按住看原图");
  // A long press gets no system menu, no picture drag, no text selection.
  expect(await stage.evaluate((el) => { const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string }; return [s.webkitTouchCallout ?? "none", s.userSelect || s.webkitUserSelect]; })).toEqual(["none", "none"]);
  expect(await first.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).draggable))).toEqual([false, false]);
  expect(await stage.evaluate((el) => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  // Same shape, nothing cropped: no outline, no zoom.
  await expect(first).not.toHaveClass(/cropped/);
  await expect(first.locator(".photo-compare-kept")).toHaveCount(0);
  // The frame takes the photo's shape.
  const box = (await stage.boundingBox())!;
  expect(Math.abs(box.width / box.height - 1.5)).toBeLessThan(0.03);
  // No frame around it: the figure is as wide as the photo, so title and buttons sit on its edges,
  // and it stays an inline picture's height rather than filling the screen.
  const figure = (await first.boundingBox())!;
  expect(Math.abs(figure.x - box.x)).toBeLessThan(1);
  expect(Math.abs(figure.width - box.width)).toBeLessThan(1);
  expect(box.height).toBeLessThanOrEqual(421);

  const x = box.x + box.width * 0.5, y = box.y + box.height * 0.6;
  await mkdir(evidence, { recursive: true });
  // The edit shows by default.
  expect(await colorAt(page, x, y)).toBe("edited");
  // Pressing shows the original; letting go brings the edit back.
  if (info.project.use.hasTouch) await finger(page, "down", x, y);
  else { await page.mouse.move(x, y); await page.mouse.down(); }
  await expect(stage).toHaveAttribute("aria-pressed", "true");
  await expect(hint).toHaveText("原图");
  expect(await colorAt(page, x, y)).toBe("original");
  await page.screenshot({ path: `${evidence}/${info.project.name}-held.png` });
  if (info.project.use.hasTouch) await finger(page, "up", x, y);
  else await page.mouse.up();
  await expect(stage).toHaveAttribute("aria-pressed", "false");
  await expect(hint).toHaveText("按住看原图");
  expect(await colorAt(page, x, y)).toBe("edited");
  await page.screenshot({ path: `${evidence}/${info.project.name}-normal.png` });
  // Pressing never opens the message the comparison sits in.
  await expect(page.locator(".full-message")).toHaveCount(0);
  // A press the browser takes over (a scroll, say) lets go too.
  await stage.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0 });
  await expect(stage).toHaveAttribute("aria-pressed", "true");
  await stage.dispatchEvent("pointercancel", { pointerId: 7, pointerType: "touch" });
  await expect(stage).toHaveAttribute("aria-pressed", "false");
  // Holding Space shows the original too.
  await stage.focus();
  await page.keyboard.down(" ");
  await expect(stage).toHaveAttribute("aria-pressed", "true");
  expect(await colorAt(page, x, y)).toBe("original");
  await page.keyboard.up(" ");
  await expect(stage).toHaveAttribute("aria-pressed", "false");
  expect(await colorAt(page, x, y)).toBe("edited");

  // Full size opens the edit in the file preview.
  await first.getByRole("button", { name: "查看大图" }).click();
  await expect(page.getByRole("dialog")).toContainText("IMG_1-修图.jpg");
  await page.keyboard.press("Escape");

  // The zip below the block stays a file link, and the page never scrolls sideways.
  await expect(page.locator("[data-sandbox-file='/home/gem/workspace/tasks/task-1/photos.zip']").first()).toBeVisible();
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("holding a cropped edit shows the whole original with the kept part outlined", async ({ page }, info) => {
  await setup(page, croppedItems, (path) => path.includes("IMG_3.jpg") ? CROP_ORIGINAL : path.includes("IMG_3-") ? CROP_EDITED
    : path.includes("/uploads/") ? CROP_ORIGINAL : png(240, 300, (x, y) => tint([60, 160, 90], 1 - 0.15 * ((Math.floor(x / 37) + Math.floor(y / 23)) % 2))));
  const cards = page.locator(".photo-compare");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator(".boot-cover")).toHaveCount(0);
  const card = cards.first();
  const stage = card.getByRole("button", { name: "按住看原图" });
  await stage.scrollIntoViewIfNeeded();
  await expect.poll(() => card.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([240, 300]);
  // The frame keeps the edit's shape.
  const box = (await stage.boundingBox())!;
  expect(Math.abs(box.width / box.height - 0.8)).toBeLessThan(0.02);
  // Lined up once, before anyone presses.
  await expect(card).toHaveClass(/cropped/);
  const x = box.x + box.width * 0.5, y = box.y + box.height * 0.5;
  expect(await colorAt(page, x, y)).toBe("edited");

  if (info.project.use.hasTouch) await finger(page, "down", x, y);
  else { await page.mouse.move(x, y); await page.mouse.down(); }
  await expect(stage).toHaveAttribute("aria-pressed", "true");
  // The card does not change size while the picture zooms out, nor after.
  for (let i = 0; i < 4; i++) {
    expect((await stage.boundingBox())!).toEqual(box);
    await page.waitForTimeout(60);
  }
  // The original whole: its own 3:4 shape, fitted inside the frame, not stretched or cut.
  const fit = card.locator(".photo-compare-fit");
  await expect.poll(async () => { const f = (await fit.boundingBox())!; return Math.abs(f.height - box.height) < 1 && Math.abs(f.width / f.height - 0.75) < 0.01; }).toBe(true);
  const f = (await fit.boundingBox())!;
  expect(f.x).toBeGreaterThanOrEqual(box.x - 0.5);
  expect(f.x + f.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  // The kept part is outlined where the edit was cut from: (30, 70) to (270, 370) of 300 × 400.
  const kept = (await card.locator(".photo-compare-kept").boundingBox())!;
  const rel = [(kept.x - f.x) / f.width, (kept.y - f.y) / f.height, kept.width / f.width, kept.height / f.height];
  [0.1, 0.175, 0.8, 0.75].forEach((v, i) => expect(Math.abs(rel[i]! - v)).toBeLessThan(0.03));
  // Inside it the original as it is; above it, the cut-away top, still the original but dimmed.
  await expect.poll(() => colorAt(page, x, y)).toBe("original");
  const [r, g] = await rgbAt(page, f.x + f.width * 0.5, f.y + f.height * 0.08);
  expect(r!).toBeGreaterThan(g! + 20);
  expect(r!).toBeLessThan(140);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${info.project.name}-cropped-held.png` });

  if (info.project.use.hasTouch) await finger(page, "up", x, y);
  else await page.mouse.up();
  await expect(stage).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => colorAt(page, x, y)).toBe("edited");
  expect((await stage.boundingBox())!).toEqual(box);
  await page.screenshot({ path: `${evidence}/${info.project.name}-cropped-normal.png` });

  // An edit that is not a crop of its original: the original just shows whole, nothing outlined.
  const other = cards.nth(1);
  const otherStage = other.getByRole("button", { name: "按住看原图" });
  await otherStage.scrollIntoViewIfNeeded();
  await expect.poll(() => other.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([240, 300]);
  await otherStage.focus();
  await page.keyboard.down(" ");
  await expect(otherStage).toHaveAttribute("aria-pressed", "true");
  await expect(other).not.toHaveClass(/cropped/);
  await expect(other.locator(".photo-compare-kept")).toHaveCount(0);
  // Near its top: on a phone the long message is folded under the second picture.
  const ob = (await otherStage.boundingBox())!;
  await expect.poll(() => colorAt(page, ob.x + ob.width * 0.5, ob.y + ob.height * 0.2)).toBe("original");
  await page.screenshot({ path: `${evidence}/${info.project.name}-not-a-crop-held.png` });
  await page.keyboard.up(" ");
  await expect(otherStage).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
