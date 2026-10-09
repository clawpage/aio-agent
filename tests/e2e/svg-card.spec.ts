import fs from "node:fs";
import { test, expect, type Download, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const CHART = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#4cc38a"/><circle cx="60" cy="40" r="24" fill="#8f86ff"/></svg>';
// Script inside an SVG must never run in the console, whether drawn inline or from a file.
const HOSTILE = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.__svgRan=1"><script>window.__svgRan=1</script><rect width="40" height="40" fill="#ff7369"/></svg>';

/** The size a downloaded PNG really has. */
async function pngSize(file: Download): Promise<[number, number]> {
  const bytes = fs.readFileSync((await file.path())!);
  expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function task(result: string) {
  return { id: "task-1", revision: 1, title: "画图", text: "画个图", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

async function setup(page: Page, result: string) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(result)], nextBefore: null } }));
  const images: string[] = [];
  await page.route("**/api/documents/image*", (r) => {
    const path = new URL(r.request().url()).searchParams.get("path")!;
    images.push(path);
    return r.fulfill({ contentType: "image/svg+xml", body: path.endsWith("hostile.svg") ? HOSTILE : CHART });
  });
  await page.goto("/");
  return { images };
}

test("an ```svg block in a reply is drawn as a picture that opens full screen and downloads as a PNG", async ({ page }, info) => {
  await setup(page, `图在这里：\n\n\`\`\`svg\n${CHART}\n\`\`\`\n\n绿色是背景。\n\n\`\`\`svg\n${HOSTILE}\n\`\`\``);
  const cards = page.locator(".svg-card");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  const picture = cards.first().locator("img.svg-image");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(120);
  const bubble = page.locator(".bubble").filter({ has: cards.first() });
  await expect(bubble).toContainText("图在这里");
  await expect(bubble).toContainText("绿色是背景");
  await expect(bubble.locator("pre")).toHaveCount(0);
  await bubble.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath("svg-card.png") });

  // No source button: the picture opens full screen and downloads as a picture.
  await expect(cards.first().getByRole("button", { name: "看源码" })).toHaveCount(0);
  await cards.first().getByRole("button", { name: "看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "查看大图" });
  await expect(viewer).toBeVisible();
  await expect.poll(() => viewer.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await viewer.locator("img").click();
  await expect(viewer.locator(".image-viewer-stage")).toHaveClass(/zoomed/);
  // Zoomed in, it opens on the middle of the drawing.
  await expect.poll(() => viewer.locator(".image-viewer-stage").evaluate((el) => el.scrollLeft > 0 && Math.abs(el.scrollLeft - (el.scrollWidth - el.clientWidth) / 2) < 2)).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("svg-viewer-zoomed.png") });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  // Tapping the picture itself opens it too; the download is a sharp PNG on a white page.
  await cards.first().getByRole("button", { name: "查看大图", exact: true }).click();
  await expect(viewer).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("svg-viewer.png") });
  const [file] = await Promise.all([page.waitForEvent("download"), viewer.getByRole("button", { name: "下载" }).click()]);
  expect(file.suggestedFilename()).toBe("图片.png");
  expect(await pngSize(file)).toEqual([480, 320]);
  await viewer.getByRole("button", { name: "关闭" }).click();
  await expect(viewer).toHaveCount(0);
  // The hostile one draws, and its script did not run.
  await expect.poll(() => cards.nth(1).locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(40);
  expect(await page.evaluate(() => (window as unknown as { __svgRan?: number }).__svgRan)).toBeUndefined();
});

test("a workspace SVG shows inline and as a file card picture", async ({ page }) => {
  const { images } = await setup(page, "做好了：\n\n![图表](/home/gem/workspace/out/chart.svg)\n\n另一张：[hostile.svg](/home/gem/workspace/out/hostile.svg)");
  const inline = page.locator('.markdown img[data-sandbox-image="/home/gem/workspace/out/chart.svg"]');
  await expect(inline).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => inline.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(120);
  await expect.poll(() => images).toContain("/home/gem/workspace/out/hostile.svg");
  expect(await page.evaluate(() => (window as unknown as { __svgRan?: number }).__svgRan)).toBeUndefined();
});

test("an SVG with only a viewBox fills the message width at its own proportions; a sized one keeps its size", async ({ page }, info) => {
  const WIDE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"><title>Roy 一天</title><rect width="640" height="320" fill="#eef4ff"/><circle cx="320" cy="160" r="120" fill="#8f86ff"/></svg>';
  await setup(page, `示意图：\n\n\`\`\`svg\n${WIDE}\n\`\`\`\n\n小图：\n\n\`\`\`svg\n${CHART}\n\`\`\``);
  const cards = page.locator(".svg-card");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  const wide = cards.first().locator("img.svg-image");
  await expect(wide).toBeVisible();
  // Measured once the first arrival has risen in (it scales the messages slightly on the way).
  await expect(page.locator(".task-feed.entering")).toHaveCount(0);
  const bubble = page.locator(".bubble").filter({ has: cards.first() });
  const text = await bubble.locator(".markdown").first().boundingBox();
  const box = (await wide.boundingBox())!;
  expect(box.width).toBeGreaterThan(text!.width * 0.85);
  expect(Math.abs(box.width / box.height - 2)).toBeLessThan(0.05);
  const small = (await cards.nth(1).locator("img.svg-image").boundingBox())!;
  expect(Math.round(small.width)).toBe(120);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await cards.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath("svg-fluid.png") });
  // A drawing with only a viewBox downloads at its own proportions, named by its <title>.
  const [file] = await Promise.all([page.waitForEvent("download"), cards.first().getByRole("button", { name: "下载" }).click()]);
  expect(file.suggestedFilename()).toBe("Roy_一天.png");
  expect(await pngSize(file)).toEqual([2000, 1000]);
});
