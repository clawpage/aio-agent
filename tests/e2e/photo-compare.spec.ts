import { test, expect, type CDPSession, type Page } from "@playwright/test";
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
