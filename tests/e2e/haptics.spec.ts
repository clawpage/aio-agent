import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

// The iOS app plays a touch for the main buttons and for what changes on screen (src/ui/src/haptics.ts):
// here a stand-in for its `aioHaptic` handler records what the console asks for.
test("sending, and a reply that finishes or goes wrong, are felt in the iOS app", async ({ page }) => {
  await page.addInitScript(() => {
    const felt: string[] = [];
    (window as unknown as { felt: string[] }).felt = felt;
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioHaptic: { postMessage: (kind: string) => felt.push(kind) } } };
  });
  await mockConsole(page, { conversations: [] });
  const base = { revision: 1, text: "", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 60_000, completedAt: null, messages: [] };
  const tasks: Record<string, unknown>[] = [
    { ...base, id: "a", title: "查天气", conversationId: "ca", status: "running" },
    { ...base, id: "b", title: "订餐厅", conversationId: "cb", status: "running" },
    { ...base, id: "old", title: "早就好了", conversationId: "co", status: "completed", result: "好了", completedAt: Date.now() - 30_000 },
  ];
  let version = 1;
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks, nextBefore: null, version: `v${version}` } }));
  await page.route("**/api/tasks", (r) => r.fulfill({ status: 202, json: { task: { ...base, id: "new", title: "明天呢", conversationId: "cn", status: "planning" }, duplicate: false } }));
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  const felt = () => page.evaluate(() => (window as unknown as { felt: string[] }).felt);
  // What was already there when the console opened is not felt.
  expect(await felt()).toEqual([]);

  await page.getByRole("textbox", { name: "消息", exact: true }).fill("明天呢");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(felt).toEqual(["tap"]);

  Object.assign(tasks[0]!, { status: "completed", result: "晴", completedAt: Date.now() });
  version += 1;
  await expect.poll(felt, { timeout: 10_000 }).toEqual(["tap", "success"]);
  Object.assign(tasks[1]!, { status: "failed", error: "没订上", completedAt: Date.now() });
  version += 1;
  await expect.poll(felt, { timeout: 10_000 }).toEqual(["tap", "success", "error"]);
});
