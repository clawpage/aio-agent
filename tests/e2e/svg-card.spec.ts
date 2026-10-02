import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const CHART = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#4cc38a"/><circle cx="60" cy="40" r="24" fill="#8f86ff"/></svg>';
// Script inside an SVG must never run in the console, whether drawn inline or from a file.
const HOSTILE = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.__svgRan=1"><script>window.__svgRan=1</script><rect width="40" height="40" fill="#ff7369"/></svg>';

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

test("an ```svg block in a reply is drawn as a picture, with its source one tap away", async ({ page }, info) => {
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

  await cards.first().getByRole("button", { name: "看源码" }).click();
  await expect(cards.first().locator("pre.svg-source")).toContainText('<circle cx="60"');
  await cards.first().getByRole("button", { name: "看图" }).click();
  await expect(cards.first().locator("img.svg-image")).toBeVisible();
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
