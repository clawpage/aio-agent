import { test, expect } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

const at = Date.now() - 60_000;
const row = { id: "task-1", revision: 1, title: "合成照片", text: "把四个人合成到第二张", conversationId: "child-1", status: "completed", result: "已合成。", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: at, completedAt: at + 50_000 };
const draft = "/home/gem/workspace/tasks/task-1/.tmp/整图预览.jpg";
const crop = "/home/gem/workspace/tasks/task-1/.tmp/发梢局部.png";
// A 2×2 PNG stands in for the pictures the agent looked at.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8DwnwEJMDKgAQBHmQH/tb6S5wAAAABJRU5ErkJggg==", "base64");

test("the pictures the agent looks at while working show in its process as a draft, not as the result", async ({ page }, info) => {
  await mockConsole(page, { conversations: [makeConversation(row.conversationId, row.title)] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v1", tasks: [row], nextBefore: null } }));
  await page.route((url) => url.pathname === "/api/documents/image", (r) => r.fulfill({ status: 200, headers: { "content-type": "image/png" }, body: PNG }));
  const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, turnId: "t1", createdAt: at + id, payload });
  const view = (id: number, path: string) => [ev(id, "item/started", { item: { type: "imageView", id: `v${id}`, path } }), ev(id + 1, "item/completed", { item: { type: "imageView", id: `v${id}`, path } })];
  const events = [
    ev(1, "turn.queued", { turnId: "t1", text: row.text }),
    ev(2, "turn.started", { turnId: "t1" }),
    ev(3, "item/completed", { item: { id: "m1", type: "agentMessage", text: "我先把原来的人去掉，再把四个人贴上去。" } }),
    ...view(10, draft),
    ...view(12, crop),
    ...view(14, draft),
    ev(20, "item/completed", { item: { id: "m2", type: "agentMessage", text: "已合成。" } }),
    ev(21, "turn.finished", {}),
  ];
  await page.route((url) => url.pathname === "/api/conversations/child-1/events", (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get("format") !== "json") return r.fulfill({ headers: { "content-type": "text/event-stream" }, body: `retry: 3000\n\nevent: replay.complete\ndata: {"lastEventId":21,"replayed":0}\n\n` });
    return r.fulfill({ json: { events, more: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "查看过程", exact: true }).click();
  const detail = page.locator(".task-detail");
  const strip = detail.locator(".draft-strip");
  await expect(strip).toHaveCount(1);
  await expect(strip.locator(".draft-badge")).toHaveText("中间稿");
  await expect(strip).toContainText("不是最终结果");
  // Each picture once, drawn from the workspace.
  const thumbs = strip.locator(".draft-thumb");
  await expect(thumbs).toHaveCount(2);
  await expect(thumbs.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await page.screenshot({ path: info.outputPath("draft-strip.png") });
  // A tap opens the picture.
  await thumbs.nth(1).click();
  await expect(page.getByRole("dialog")).toContainText("发梢局部.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
