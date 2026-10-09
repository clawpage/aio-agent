import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const FLOW = [
  "flowchart TD",
  '  A["收到签证材料清单"] --> B{"护照有效期够 6 个月吗？"}',
  '  B -->|是| C["填写 DS-160"]',
  '  B -->|否| D["先换新护照"]',
  "  D --> C",
  '  C --> E["预约面签"]',
  '  E --> F(["拿到签证"])',
].join("\n");

function task(result: string) {
  return { id: "task-1", revision: 1, title: "签证流程", text: "画一下签证流程", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

/** The console under its production CSP (src/ui/edge.mjs), so Mermaid must work without eval or remote assets. */
async function setup(page: Page, result: string) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(result)], nextBefore: null } }));
  await page.route((url) => url.pathname === "/" || url.pathname === "/index.html", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'" } });
  });
  const violations: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.goto("/");
  return { violations };
}

test("a ```mermaid flowchart in a reply is drawn as a picture that opens full screen and downloads as a PNG", async ({ page }, info) => {
  const { violations } = await setup(page, `签证流程如下：\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n按顺序办就行。`);
  const card = page.locator(".svg-card");
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  const picture = card.locator("img.svg-image");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(100);
  const bubble = page.locator(".bubble").filter({ has: card });
  await expect(bubble).toContainText("签证流程如下");
  await expect(bubble).toContainText("按顺序办就行");
  await expect(bubble.locator("pre")).toHaveCount(0);
  // A top-down flow is drawn at its own size: taller than wide, within the message.
  const box = (await picture.boundingBox())!;
  expect(box.height).toBeGreaterThan(box.width);
  // Nothing Mermaid drew to measure text is left behind on the page.
  expect(await page.locator('body > [id^="daio-mermaid"], body > svg[id^="aio-mermaid"]').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath("mermaid-card.png") });

  await card.getByRole("button", { name: "看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "查看大图" });
  await expect(viewer).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("mermaid-viewer.png") });
  const [file] = await Promise.all([page.waitForEvent("download"), viewer.getByRole("button", { name: "下载" }).click()]);
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  expect([...fs.readFileSync((await file.path())!).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(violations).toEqual([]);
});

test("a ```mermaid block that cannot be drawn shows its source; a good one next to it still draws", async ({ page }) => {
  const broken = "flowchart TD\n  A[\"开始\" --> ((((";
  await setup(page, `坏的：\n\n\`\`\`mermaid\n${broken}\n\`\`\`\n\n好的：\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``);
  const cards = page.locator(".svg-card");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  await expect(cards.first().locator("pre.svg-source")).toContainText('A["开始"');
  await expect(cards.first()).toContainText("这段流程图无法绘制");
  await expect.poll(() => cards.nth(1).locator("img.svg-image").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(100);
  // Mermaid's own error picture is never added to the page.
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);
});

test("a flow drawn the way the executor is told (hexagon decisions, a short chain across) stays compact on a phone", async ({ page }, info) => {
  const decision = FLOW.replace('B{"护照有效期够 6 个月吗？"}', 'B{{"护照够半年？"}}');
  const chain = 'flowchart LR\n  A(["你提需求"]) --> B["AIO 调用桥接"] --> C(["Mac 执行"])';
  await setup(page, `签证流程：\n\n\`\`\`mermaid\n${decision}\n\`\`\`\n\n接入方式：\n\n\`\`\`mermaid\n${chain}\n\`\`\``);
  const pictures = page.locator(".task-report .svg-image");
  await expect(pictures).toHaveCount(2, { timeout: 60_000 });
  const size = (i: number) => pictures.nth(i).evaluate((n) => ({ w: (n as HTMLImageElement).naturalWidth, h: (n as HTMLImageElement).naturalHeight }));
  await expect.poll(async () => (await size(1)).w).toBeGreaterThan(0);
  const [flow, across] = [await size(0), await size(1)];
  // Six steps with a branch: no taller than about two phone screens' worth of the old diamond.
  expect(flow.h).toBeLessThan(420);
  // Three steps in a row: wider than tall, one line.
  expect(across.w).toBeGreaterThan(across.h * 2);
  await pictures.nth(0).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("mermaid-compact.png") });
});
