import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

const task = (i: number) => ({ id: `task-${i}`, revision: 1, title: `任务 ${i}`, text: `第 ${i} 件事`, conversationId: `child-${i}`, status: "completed", result: `第 ${i} 件办完了。`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + i * 1000, completedAt: 1500 + i * 1000 });

test("opening the console: the mark while it loads, the shape of a conversation, then the messages rise in", async ({ page }, info) => {
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
  await expect(boot.locator(".brand-mark")).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".boot-loading")!).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: info.outputPath("boot.png") });

  releaseSession();
  // The feed has not come yet: skeletons, never the empty "把事情交给我" flash.
  const skeleton = page.locator(".feed-skeleton");
  await expect(skeleton).toBeVisible();
  await expect(page.getByText("把事情交给我")).toHaveCount(0);
  await expect(page.locator(".task-feed")).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => skeleton.evaluate((n) => getComputedStyle(n).opacity)).toBe("1");
  await page.screenshot({ path: info.outputPath("skeleton.png") });

  releaseFeed();
  await expect(page.locator(".task-feed.entering")).toHaveCount(1);
  await expect(skeleton).toHaveCount(0);
  // The latest messages rise one after another, the newest last.
  const delays = await page.locator(".task-feed.entering > .task-entry").evaluateAll((els) => els.slice(-3).map((e) => parseFloat(getComputedStyle(e).animationDelay)));
  expect(delays[0]).toBeLessThan(delays[2]!);
  await expect(page.locator(".task-feed.entering")).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator(".msg.user", { hasText: "第 6 件事" })).toBeInViewport();
  expect(await page.locator(".task-feed").evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight)).toBeLessThan(80);
});

test("an account with nothing yet sees the empty state once the feed answers", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.goto("/");
  await expect(page.getByText("把事情交给我")).toBeVisible();
  await expect(page.locator(".feed-skeleton")).toHaveCount(0);
});
