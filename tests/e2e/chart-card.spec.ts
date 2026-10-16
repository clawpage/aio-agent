import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** 120 trading days of a made-up stock: long enough for the slider and both moving averages. */
function bars(n = 120) {
  let close = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = close;
    close = Math.round((open * (1 + Math.sin(i / 7) * 0.02 + (i % 5 === 0 ? -0.015 : 0.006))) * 100) / 100;
    const day = new Date(Date.UTC(2026, 4, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return { date: day, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close, volume_lots: 20_000 + (i % 9) * 3_000 };
  });
}

const KLINE = { type: "candlestick", title: "示例股份 日K（前复权）", note: "东方财富 · 截至 2026-08-28", data: bars(), ma: [5, 20] };
const REVENUE = { type: "bar", title: "营收与增速", unit: "亿元", unitRight: "%", x: ["2022", "2023", "2024", "2025"], series: [{ name: "营收", data: [1276, 1505, 1741, 1801] }, { name: "增速", type: "line", axis: "right", data: [16.9, 18, 15.7, 3.4] }] };
const SHARE = { type: "pie", title: "持仓占比", data: [{ name: "茅台", value: 45 }, { name: "腾讯", value: 30 }, { name: "苹果", value: 25 }] };
const TREND = { type: "line", title: "三只股票近 5 日涨跌", unit: "%", x: ["10-12", "10-13", "10-14", "10-15", "10-16"], series: [{ name: "茅台", data: [1.98, -1.02, 0.87, 2.1, 0.01] }, { name: "腾讯", data: [0.5, -0.4, 1.2, -1.3, 0.8] }] };

const block = (spec: unknown) => `\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``;

function task(result: string) {
  return { id: "task-1", revision: 1, title: "看看走势", text: "画一下走势", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

/** The console under its production CSP (src/ui/edge.mjs): the chart library must work without eval or remote assets. */
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
  // The feed renders under the boot cover; wait for both, or a tap lands on the cover.
  await page.locator(".bubble").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  return { violations };
}

/** Every canvas of a chart, to see that something was drawn again. */
async function pixels(card: ReturnType<Page["locator"]>) {
  return (await card.locator("canvas").evaluateAll((cs: HTMLCanvasElement[]) => cs.map((c) => c.toDataURL()))).join("|");
}

/** How much of a chart's canvas is painted, so a blank canvas fails. */
async function painted(page: Page, card: ReturnType<Page["locator"]>) {
  return await card.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 16) if (data[i]! > 0) n++;
    return n / (data.length / 16);
  });
}

test("a ```chart K-line in a reply is a live chart: candles, moving averages, volume, a slider, values on tap, saved as a PNG", async ({ page }, info) => {
  const { violations } = await setup(page, `示例股份最近走势：\n\n${block(KLINE)}\n\n整体先涨后跌。`);
  const card = page.locator(".chart-card");
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card).toHaveAttribute("aria-label", "图表：示例股份 日K（前复权）");
  await expect(card.getByRole("button", { name: "保存图片" })).toBeVisible();
  const canvas = card.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => painted(page, card)).toBeGreaterThan(0.02);
  const bubble = page.locator(".bubble").filter({ has: card });
  await expect(bubble).toContainText("示例股份最近走势");
  await expect(bubble).toContainText("整体先涨后跌");
  // No raw JSON left in the message, and nothing wider than the screen.
  await expect(bubble.locator("pre")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const box = (await canvas.boundingBox())!;
  const bubbleBox = (await bubble.boundingBox())!;
  expect(box.width).toBeGreaterThan(Math.min(300, bubbleBox.width - 40));
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await card.screenshot({ path: info.outputPath("kline.png") });
  await page.screenshot({ path: info.outputPath("page.png") });

  // A tap (or hover) in the plot shows that day's values, drawn on the canvas rather than as HTML.
  const before = await pixels(card);
  if (info.project.use.hasTouch) await canvas.tap({ position: { x: box.width * 0.6, y: box.height * 0.35 } });
  else await canvas.hover({ position: { x: box.width * 0.6, y: box.height * 0.35 } });
  await expect.poll(() => pixels(card)).not.toBe(before);
  await card.screenshot({ path: info.outputPath("kline-tooltip.png") });
  await expect(page.getByText(/MA20 \d/)).toHaveCount(0);

  const [file] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "保存图片" }).click()]);
  expect(file.suggestedFilename()).toBe("示例股份_日K（前复权）.png");
  expect([...fs.readFileSync((await file.path())!).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(violations).toEqual([]);
});

test("bar + line on two axes, a multi-line trend and a pie draw side by side; a bad block stays code; fits a 360 px phone", async ({ page }, info) => {
  if (info.project.use.isMobile || info.project.use.hasTouch) await page.setViewportSize({ width: 360, height: 780 });
  const { violations } = await setup(page, [`占比：\n\n${block(SHARE)}`, `营收：\n\n${block(REVENUE)}`, `走势：\n\n${block(TREND)}`, "坏的：\n\n```chart\n{\"type\": \"radar\"}\n```"].join("\n\n"));
  const cards = page.locator(".chart-card");
  await expect(cards).toHaveCount(3, { timeout: 60_000 });
  for (let i = 0; i < 3; i++) await expect.poll(() => painted(page, cards.nth(i))).toBeGreaterThan(0.01);
  await expect(page.locator(".bubble pre")).toContainText('"radar"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  for (const [i, name] of ["pie", "revenue", "trend"].entries()) {
    // To the middle of the screen, clear of the floating composer.
    await cards.nth(i).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(200);
    await cards.nth(i).screenshot({ path: info.outputPath(`${name}.png`) });
  }
  expect(violations).toEqual([]);
});

test("a chart repaints in the light theme's colors when the theme switches", async ({ page }, info) => {
  await setup(page, block(KLINE));
  const card = page.locator(".chart-card");
  await expect.poll(() => painted(page, card), { timeout: 60_000 }).toBeGreaterThan(0.02);
  const dark = await pixels(card);
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; });
  await expect.poll(() => pixels(card)).not.toBe(dark);
  await card.screenshot({ path: info.outputPath("kline-other-theme.png") });
});
