import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

const task = (i: number) => ({ id: `task-${i}`, revision: 1, title: `任务 ${i}`, text: `第 ${i} 件事`, conversationId: `child-${i}`, status: "completed", result: `第 ${i} 件办完了。`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + i * 1000, completedAt: 1500 + i * 1000 });

test("opening the console: the drawn mark until the feed is here and the drawing has finished, then the conversation as it is", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  let releaseSession!: () => void, releaseFeed!: () => void;
  const session = new Promise<void>((r) => { releaseSession = r; });
  const feed = new Promise<void>((r) => { releaseFeed = r; });
  await page.route((url) => url.pathname === "/api/auth/session", async (r) => { await session; await r.fulfill({ json: { authenticated: true, username: "owner" } }); });
  let calls = 0;
  await page.route("**/api/main*", async (r) => {
    // The app's own first look answers at once; the feed's first load waits.
    if (++calls > 1) await feed;
    await r.fulfill({ json: { mode: "tasks", version: "v1", tasks: Array.from({ length: 6 }, (_, k) => task(k + 1)), nextBefore: null } });
  });
  await page.goto("/");
  // Before the session answers: the loading screen shows the mark, and the page is not white.
  const boot = page.getByRole("status").filter({ hasText: "加载中…" });
  await expect(boot).toBeVisible();
  await expect(boot.locator(".loading-mark")).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".boot-loading")!).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: info.outputPath("boot.png") });

  releaseSession();
  // The console is there under it, but the feed has not come: still the mark, no placeholder, no empty state.
  const cover = page.locator(".boot-cover");
  await expect(cover).toBeVisible();
  await expect(page.locator(".task-feed")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".feed-skeleton, .feed-loading")).toHaveCount(0);
  await expect(page.getByText("你好，我是一站")).toHaveCount(0);
  await expect(cover.locator(".loading-mark")).toBeVisible();

  // Note where in its drawing the mark stands when the cover goes.
  await page.evaluate(() => {
    const w = window as unknown as { liftedAt?: number };
    new MutationObserver((_, observer) => {
      if (document.querySelector(".boot-cover")) return;
      w.liftedAt = performance.now() % 2800;
      observer.disconnect();
    }).observe(document.body, { childList: true });
  });
  // Released early in a drawing, the cover waits for it to finish.
  await page.waitForFunction(() => performance.now() % 2800 < 1200);
  releaseFeed();
  await expect(page.locator(".msg.user", { hasText: "第 6 件事" })).toBeAttached();
  await page.waitForTimeout(150);
  await expect(cover).toBeVisible();
  await expect(cover).toHaveCount(0, { timeout: 4000 });
  const at = await page.evaluate(() => (window as unknown as { liftedAt?: number }).liftedAt);
  // The centre has landed (76%) and the whole mark still stands (before 88%).
  expect(at).toBeGreaterThanOrEqual(2128 - 40);
  expect(at).toBeLessThan(2464);

  // The conversation is simply there: no message rising in, the latest at the bottom.
  const opacity = await page.locator(".task-feed .msg").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  expect(opacity.every((o) => o === "1")).toBe(true);
  await expect(page.locator(".msg.user", { hasText: "第 6 件事" })).toBeInViewport();
  expect(await page.locator(".task-feed").evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight)).toBeLessThan(80);
  await page.screenshot({ path: info.outputPath("conversation.png") });
});

test("a feed that does not come gives the console back, with the mark loading in its place", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  let calls = 0;
  await page.route("**/api/main*", (r) => (++calls === 1 ? r.fulfill({ json: { mode: "tasks", version: "v1", tasks: [], nextBefore: null } }) : new Promise(() => undefined)));
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toBeVisible();
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".feed-loading .loading-mark")).toBeVisible();
  await expect(page.getByText("你好，我是一站")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
});

test("an account with nothing yet is greeted once the feed answers, and a starter fills the composer", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  await expect(page.getByText("你好，我是一站")).toBeVisible();
  await expect(page.locator(".boot-cover")).toHaveCount(0);
  const starters = page.locator(".welcome-starters button");
  await expect(starters).toHaveCount(4);
  for (const button of await starters.all()) await expect(button).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("welcome.png") });
  // A starter is put in the composer, to send as is or change first; nothing is sent by itself.
  let sent = 0;
  await page.route("**/api/tasks", (r) => { sent++; return r.fallback(); });
  await page.getByRole("button", { name: "规划出游", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(composer).toHaveValue(/周末两天的短途出游/);
  await expect(composer).toBeFocused();
  expect(sent).toBe(0);
});
