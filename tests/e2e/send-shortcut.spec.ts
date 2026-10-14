import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

type Row = Record<string, unknown>;

async function setup(page: Page) {
  await mockConsole(page, { conversations: [] });
  const bodies: Row[] = [];
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v0", tasks: [], nextBefore: null } }));
  await page.route("**/api/tasks", async (r) => {
    const body = r.request().postDataJSON() as Row;
    bodies.push(body);
    const task = { id: "task-1", revision: 1, title: String(body.text), text: body.text, conversationId: "c-1", status: "planning", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now(), completedAt: null, clientMessageId: body.clientMessageId };
    await r.fulfill({ status: 202, json: { task, duplicate: false } });
  });
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  return bodies;
}

const box = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });

test("Enter adds a line; only the platform's send chord sends", async ({ page }) => {
  const bodies = await setup(page);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
  await box(page).click();
  await page.keyboard.type("第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二行");
  await expect(box(page)).toHaveValue("第一行\n第二行");
  // The other platform's chord is just a line break.
  await page.keyboard.press(mac ? "Control+Enter" : "Meta+Enter");
  await page.waitForTimeout(300);
  expect(bodies).toHaveLength(0);
  await box(page).fill("第一行\n第二行");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveAttribute("title", mac ? "发送 (⌘↵)" : "发送 (Ctrl+Enter)");
  await page.keyboard.press(mac ? "Meta+Enter" : "Control+Enter");
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].text).toBe("第一行\n第二行");
  await expect(box(page)).toHaveValue("");
});
