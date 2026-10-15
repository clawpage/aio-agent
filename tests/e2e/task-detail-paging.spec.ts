import { test, expect } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

const at = Date.now() - 600_000;
const row = { id: "task-1", revision: 1, title: "长任务", text: "第 1 轮要求", conversationId: "child-1", status: "completed", result: "都办完了。", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: at, completedAt: at + 1000 };

/** Turn `n` of the task's process: the ask, a long answer, done. Event ids are 10n…10n+2. */
function turn(n: number) {
  const ev = (k: number, type: string, payload: Record<string, unknown>) => ({ id: n * 10 + k, type, turnId: `t${n}`, createdAt: at + n * 1000 + k, payload });
  return [
    ev(0, "turn.queued", { turnId: `t${n}`, text: `第 ${n} 轮要求` }),
    ev(1, "item/completed", { item: { id: `m${n}`, type: "agentMessage", text: `第 ${n} 轮回答。\n\n${"这一段写得比较长，好让过程需要滚动。".repeat(60)}` } }),
    ev(2, "turn.finished", {}),
  ];
}

test("a task's process opens at its latest turns, then reads older ones as the top comes near", async ({ page }) => {
  await mockConsole(page, { conversations: [makeConversation(row.conversationId, row.title)] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v1", tasks: [row], nextBefore: null } }));
  const pages: Array<string | null> = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let since: string | null = null;
  await page.route((url) => url.pathname === "/api/conversations/child-1/events", async (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get("format") !== "json") {
      since = url.searchParams.get("since");
      return r.fulfill({ headers: { "content-type": "text/event-stream" }, body: `retry: 3000\n\nevent: replay.complete\ndata: {"lastEventId":42,"replayed":0}\n\n` });
    }
    const before = url.searchParams.get("before");
    pages.push(before);
    if (!before) {
      await held;
      return r.fulfill({ json: { events: [...turn(3), ...turn(4)], more: true } });
    }
    return r.fulfill({ json: { events: [...turn(1), ...turn(2)], more: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "查看过程", exact: true }).click();
  const detail = page.locator(".task-detail");
  const scroller = detail.locator(".chat-scroll");

  // Until the history is here: loading, never the "start a conversation" empty state.
  await expect(detail.locator(".feed-loading")).toBeVisible();
  await expect(detail.getByText("开始新的对话")).toHaveCount(0);
  release();

  // The latest turn at the bottom; the stream carries on from the last event read.
  await expect(detail.getByText("第 4 轮要求")).toBeAttached();
  expect(await scroller.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight)).toBeLessThan(80);
  expect(await scroller.evaluate((n) => n.scrollHeight > n.clientHeight * 2)).toBe(true);
  await expect(detail.getByText("第 1 轮要求")).toHaveCount(0);
  await expect.poll(() => since).toBe("42");
  expect(pages).toEqual([null]);

  // Up at the top, the turns before load, and what was on screen stays where it was.
  const third = detail.locator(".msg.user", { hasText: "第 3 轮要求" });
  await scroller.evaluate((n) => { n.scrollTop = 0; });
  await expect(detail.getByText("第 1 轮要求")).toBeAttached();
  expect(pages).toEqual([null, "30"]);
  const top = await third.evaluate((el) => el.getBoundingClientRect().top);
  const scrollerTop = await scroller.evaluate((n) => n.getBoundingClientRect().top);
  expect(top).toBeGreaterThan(scrollerTop - 40);
  // Nothing further back: the loader is gone, and no request repeats.
  await expect(detail.locator(".feed-older")).toHaveCount(0);
  await scroller.evaluate((n) => { n.scrollTop = 0; });
  await page.waitForTimeout(300);
  expect(pages).toEqual([null, "30"]);
});
