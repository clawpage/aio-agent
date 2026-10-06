import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// A 2x1 PNG: enough for the browser to decode and lay out.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63f8cfc0c0b0200000079101f0e7755c1d0000000049454e44ae426082", "hex");

function task(i: number, result = `第 ${i} 件事办完了。\n\n${"这一段写得比较长，好让主会话需要滚动。".repeat(30)}`) {
  return { id: `task-${i}`, revision: 1, title: `任务 ${i}`, text: `第 ${i} 件事`, conversationId: `child-${i}`, status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + i * 1000, completedAt: 1500 + i * 1000 };
}

/** The main feed: a live first page with a version, and older pages by `before`. */
async function setup(page: Page, feed: { first: () => { version: string; tasks: unknown[]; nextBefore: number | null }; older?: (before: number) => { tasks: unknown[]; nextBefore: number | null } }) {
  await mockConsole(page, { conversations: [] });
  const polls: Array<{ v: string | null; answered: "full" | "unchanged" }> = [];
  const olderAsked: number[] = [];
  await page.route("**/api/main*", (r) => {
    const url = new URL(r.request().url());
    const before = url.searchParams.get("before");
    if (before) { olderAsked.push(Number(before)); return r.fulfill({ json: { mode: "tasks", version: "old", ...feed.older!(Number(before)) } }); }
    const current = feed.first();
    const v = url.searchParams.get("v");
    if (v === current.version) { polls.push({ v, answered: "unchanged" }); return r.fulfill({ json: { mode: "tasks", unchanged: true, version: current.version } }); }
    polls.push({ v, answered: "full" });
    return r.fulfill({ json: { mode: "tasks", ...current } });
  });
  const web: string[] = [];
  await page.route("**/api/documents/web-image*", (r) => { web.push(new URL(r.request().url()).searchParams.get("url")!); return r.fulfill({ contentType: "image/png", body: PNG }); });
  await page.goto("/");
  return { polls, olderAsked, web };
}

test("an unchanged feed is not downloaded again, a new version is", async ({ page }) => {
  let state = { version: "v1", tasks: [task(1)], nextBefore: null as number | null };
  const { polls } = await setup(page, { first: () => state });
  await expect(page.locator(".msg.user", { hasText: "第 1 件事" })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => polls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  // Only the start (the app's one mode check and the feed's first load) downloads the page;
  // every later poll names v1 and gets the few-byte answer.
  expect(polls.slice(0, 2)).toEqual([{ v: null, answered: "full" }, { v: null, answered: "full" }]);
  expect(polls.slice(2).every((p) => p.v === "v1" && p.answered === "unchanged")).toBe(true);
  await expect(page.locator(".msg.user", { hasText: "第 1 件事" })).toBeVisible();

  state = { version: "v2", tasks: [task(1), task(2, "第二件也办完了。")], nextBefore: null };
  await expect(page.locator(".msg.user", { hasText: "第 2 件事" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("第二件也办完了。")).toBeVisible();
  const at = polls.length;
  await expect.poll(() => polls.length, { timeout: 15_000 }).toBeGreaterThan(at);
  expect(polls.at(-1)).toEqual({ v: "v2", answered: "unchanged" });
});

test("older tasks load by themselves near the top, and what was on screen stays put", async ({ page }, info) => {
  const recent = Array.from({ length: 8 }, (_, k) => task(11 + k));
  const { olderAsked } = await setup(page, {
    first: () => ({ version: "v1", tasks: recent, nextBefore: recent[0]!.createdAt }),
    older: () => ({ tasks: Array.from({ length: 10 }, (_, k) => task(1 + k)), nextBefore: null }),
  });
  const feed = page.locator(".task-feed");
  const oldestShown = page.locator('.task-entry[data-task-id="task-11"]');
  await expect(oldestShown).toBeAttached({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "加载更早的任务" })).toHaveCount(0);
  // Opened at the bottom, far from the top: nothing older is fetched yet.
  await page.waitForTimeout(800);
  expect(olderAsked).toEqual([]);

  await feed.evaluate((n) => { n.scrollTop = 0; });
  const before = await oldestShown.evaluate((el) => el.getBoundingClientRect().top);
  await expect.poll(() => olderAsked).toEqual([recent[0]!.createdAt]);
  await expect(page.locator('.task-entry[data-task-id="task-10"]')).toBeAttached();
  await expect(page.locator(".feed-older")).toHaveCount(0);
  // The older tasks went in above; the task that was at the top did not move on screen.
  await expect.poll(() => oldestShown.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(before, -1);
  expect(await feed.evaluate((n) => n.scrollTop)).toBeGreaterThan(1000);
  await page.screenshot({ path: info.outputPath("older-loaded.png") });
});

test("a product card's picture far up the feed is fetched only when it comes near", async ({ page }) => {
  const products = [{ name: "Roborock Saros 10R", image: "https://m.media-amazon.com/images/I/saros.jpg", price: "$899", store: "Amazon" }];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#6b5bd6"/></svg>';
  const first = task(1, `比价结果：\n\n\`\`\`products\n${JSON.stringify(products)}\n\`\`\`\n\n\`\`\`svg\n${svg}\n\`\`\``);
  const { web } = await setup(page, { first: () => ({ version: "v1", tasks: [first, ...Array.from({ length: 8 }, (_, k) => task(2 + k))], nextBefore: null }) });
  const card = page.locator(".product-card");
  await expect(card).toBeAttached({ timeout: 60_000 });
  // The drawing holds its room while it waits off screen, so the feed does not jump when it is drawn.
  const drawing = page.locator(".svg-image");
  await expect(drawing).toHaveAttribute("loading", "lazy");
  await expect(drawing).toHaveAttribute("width", "400");
  await expect(drawing).toHaveAttribute("height", "200");
  await page.waitForTimeout(800);
  expect(web).toEqual([]);

  await page.locator(".task-feed").evaluate((n) => { n.scrollTop = 0; });
  await expect.poll(() => web).toEqual(["https://m.media-amazon.com/images/I/saros.jpg"]);
  await expect(card.locator(".product-media img")).toBeVisible();
  await expect.poll(() => drawing.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test("coming back to the main feed from another view keeps it at the latest message", async ({ page }) => {
  const recent = Array.from({ length: 8 }, (_, k) => task(11 + k));
  const { olderAsked } = await setup(page, {
    first: () => ({ version: "v1", tasks: recent, nextBefore: recent[0]!.createdAt }),
    older: () => ({ tasks: Array.from({ length: 10 }, (_, k) => task(1 + k)), nextBefore: null }),
  });
  await page.route("**/api/tasks*", (r) => r.fulfill({ json: { tasks: [], nextBefore: null } }));
  const feed = page.locator(".task-feed");
  await expect(page.locator('.task-entry[data-task-id="task-18"]')).toBeAttached({ timeout: 60_000 });
  const gap = () => feed.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);
  await expect.poll(gap).toBeLessThan(80);
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => { history.pushState(null, "", location.pathname.replace(/\/?$/, "/tasks")); dispatchEvent(new PopStateEvent("popstate")); });
    await expect(feed).toBeHidden();
    await page.waitForTimeout(300);
    await page.evaluate(() => history.back());
    await expect(feed).toBeVisible();
    await page.waitForTimeout(600);
    expect(await gap()).toBeLessThan(80);
  }
  expect(olderAsked).toEqual([]);
  await expect(page.locator(".feed-older .muted")).not.toHaveText("正在加载更早的任务…");
});

test("coming back to the main feed after reading a little way up keeps the same place", async ({ page }) => {
  const recent = Array.from({ length: 8 }, (_, k) => task(11 + k));
  const { olderAsked } = await setup(page, {
    first: () => ({ version: "v1", tasks: recent, nextBefore: recent[0]!.createdAt }),
    older: () => ({ tasks: Array.from({ length: 10 }, (_, k) => task(1 + k)), nextBefore: null }),
  });
  await page.route("**/api/tasks*", (r) => r.fulfill({ json: { tasks: [], nextBefore: null } }));
  const feed = page.locator(".task-feed");
  await expect(page.locator('.task-entry[data-task-id="task-18"]')).toBeAttached({ timeout: 60_000 });
  await expect.poll(() => feed.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight)).toBeLessThan(80);
  await feed.evaluate((n) => { n.scrollTop -= 300; });
  await page.waitForTimeout(200);
  const before = await feed.evaluate((n) => n.scrollTop);
  await page.evaluate(() => { history.pushState(null, "", location.pathname.replace(/\/?$/, "/tasks")); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(feed).toBeHidden();
  await page.waitForTimeout(300);
  await page.evaluate(() => history.back());
  await expect(feed).toBeVisible();
  await page.waitForTimeout(600);
  expect(Math.abs(await feed.evaluate((n) => n.scrollTop) - before)).toBeLessThan(5);
  expect(olderAsked).toEqual([]);
});
