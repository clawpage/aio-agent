import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// A 2x1 PNG (red, green): enough for the browser to decode and lay out.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63f8cfc0c0b0200000079101f0e7755c1d0000000049454e44ae426082", "hex");

function task(result: string) {
  return { id: "task-1", revision: 1, title: "扫地机比价", text: "比较三款扫地机", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

const PRODUCTS = [
  { name: "Roborock QX Revo Ultra 2", image: "/home/gem/workspace/tasks/task-1/ultra2.jpg", price: "$899.99", was: "$979.99", store: "Costco San Jose", url: "https://www.costco.com/roborock-ultra2.html", rating: "4.5（322 条）", badge: "最推荐", points: ["80°C 热水洗拖布", "Costco 两年保修、可退换"], note: "转盘拖布，之前打折到过 $779" },
  { name: "Roborock Saros 10R", image: "https://m.media-amazon.com/images/I/saros.jpg", price: "$899", store: "Amazon", url: "https://www.amazon.com/dp/B0SAROS", rating: "4.4（1,203 条）", points: ["导航和地毯处理好"] },
  { name: "Qrevo Curv 2 Flow", image: "https://broken.example/none.jpg", price: "约 $850", store: "Amazon" },
];

async function setup(page: Page, result: string) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(result)], nextBefore: null } }));
  const local: string[] = [];
  const web: string[] = [];
  await page.route("**/api/documents/image*", (r) => { local.push(new URL(r.request().url()).searchParams.get("path")!); return r.fulfill({ contentType: "image/png", body: PNG }); });
  await page.route("**/api/documents/web-image*", (r) => {
    const url = new URL(r.request().url()).searchParams.get("url")!;
    web.push(url);
    return url.includes("broken") ? r.fulfill({ status: 502, json: { error: "fetch_failed" } }) : r.fulfill({ contentType: "image/png", body: PNG });
  });
  const opened: string[] = [];
  await page.route("**/api/browser/tabs", async (r) => { opened.push(r.request().postDataJSON().url); await r.fulfill({ json: { ok: true, message: "已打开", data: null } }); });
  await page.goto("/");
  return { local, web, opened };
}

test("a products block is drawn as cards: picture, price, store, reasons and a link", async ({ page }, info) => {
  const { local, web, opened } = await setup(page, `我最推荐 Ultra 2。\n\n\`\`\`products\n${JSON.stringify(PRODUCTS)}\n\`\`\`\n\n最看重省心选 Ultra 2，硬地板多选 Curv 2 Flow。`);
  const cards = page.getByRole("listitem").filter({ has: page.locator(".product-body") });
  await expect(cards).toHaveCount(3, { timeout: 60_000 });
  const first = cards.first();
  await expect(first).toContainText("Roborock QX Revo Ultra 2");
  await expect(first.locator(".product-badge")).toHaveText("最推荐");
  await expect(first.locator(".product-price strong")).toHaveText("$899.99");
  await expect(first.locator(".product-price s")).toHaveText("$979.99");
  await expect(first).toContainText("Costco San Jose");
  await expect(first).toContainText("80°C 热水洗拖布");
  // Pictures come through the console's own endpoints: the workspace one, and the web one via the sandbox.
  await expect.poll(() => first.locator(".product-media img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2);
  await expect.poll(() => cards.nth(1).locator(".product-media img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2);
  expect(local).toContain("/home/gem/workspace/tasks/task-1/ultra2.jpg");
  expect(web).toContain("https://m.media-amazon.com/images/I/saros.jpg");
  // A picture that cannot be fetched leaves no stand-in: the card is laid out as text, price on the right.
  await expect(cards.nth(2)).toHaveClass(/text-only/);
  await expect(cards.nth(2).locator(".product-media, img")).toHaveCount(0);
  const name = (await cards.nth(2).locator(".product-name").boundingBox())!, price = (await cards.nth(2).locator(".product-price strong").boundingBox())!;
  expect(price.x).toBeGreaterThan(name.x + name.width - 1);
  expect(Math.abs(price.y - name.y)).toBeLessThan(12);
  await expect(first).not.toHaveClass(/text-only/);
  // The text around the block stays where it was.
  const bubble = page.locator(".bubble").filter({ has: first });
  await expect(bubble).toContainText("我最推荐 Ultra 2");
  await expect(bubble).toContainText("硬地板多选 Curv 2 Flow");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const box = (await first.boundingBox())!;
  expect(box.width).toBeGreaterThan(260);
  await first.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath("product-cards.png") });

  await page.context().route("https://www.costco.com/**", r => r.fulfill({ contentType: "text/html", body: "<h1>Product</h1>" }));
  const popup = page.waitForEvent("popup");
  await first.getByRole("link", { name: "去看看" }).click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toBe("https://www.costco.com/roborock-ultra2.html");
  expect(opened).toEqual([]);
  await tab.close();
});

test("a web picture in a message loads through the sandbox, never from its host", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (req) => { if (req.url().startsWith("https://m.media-amazon.com")) outside.push(req.url()); });
  const { web } = await setup(page, "商品图：\n\n![Saros 10R](https://m.media-amazon.com/images/I/saros.jpg)\n\n不安全的：![x](http://plain.example/a.png)");
  const img = page.locator('.markdown img[data-web-image="https://m.media-amazon.com/images/I/saros.jpg"]');
  await expect(img).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(2);
  expect(web).toEqual(["https://m.media-amazon.com/images/I/saros.jpg"]);
  expect(outside).toEqual([]);
  await expect(page.locator('.markdown img[data-web-image^="http://"]')).toHaveCount(0);
});

test("products without pictures are text cards from the start, and no picture is fetched", async ({ page }, info) => {
  const items = [
    { name: "Target Up&Up 24 瓶装纯净水", price: "$3.99", was: "$4.49", store: "Target", rating: "4.7（2,031 条）", badge: "最便宜", points: ["每瓶约 $0.17", "可当天店内自提"], url: "https://www.target.com/p/water" },
    { name: "Kirkland 40 瓶装纯净水", price: "$4.99", store: "Costco", note: "会员价，需 Costco 会员" },
  ];
  const { local, web } = await setup(page, `\`\`\`products\n${JSON.stringify(items)}\n\`\`\``);
  const cards = page.getByRole("listitem").filter({ has: page.locator(".product-body") });
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  for (const card of await cards.all()) {
    await expect(card).toHaveClass(/text-only/);
    await expect(card.locator(".product-media, .product-loading, img")).toHaveCount(0);
  }
  await expect(cards.first().locator(".product-badge")).toHaveText("最便宜");
  await expect(cards.first().locator(".product-price s")).toHaveText("$4.49");
  await expect(cards.first().locator(".product-link")).toHaveText("去看看");
  await expect(cards.nth(1)).toContainText("会员价，需 Costco 会员");
  expect(local).toEqual([]);
  expect(web).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator(".product-cards").screenshot({ path: info.outputPath("text-cards.png") });
});
