import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63f8cfc0c0b0200000079101f0e7755c1d0000000049454e44ae426082", "hex");
type Row = Record<string, unknown>;

/** A console whose task submissions and uploads answer only when the test lets them. */
async function setup(page: Page, opts: { pollFirst?: boolean } = {}) {
  await mockConsole(page, { conversations: [] });
  const rows: Row[] = [];
  const bodies: Row[] = [];
  const gates: Array<() => void> = [];
  const uploadGates: Array<() => void> = [];
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: `v${rows.length}`, tasks: rows, nextBefore: null } }));
  await page.route("**/api/documents/image*", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("**/api/sandbox/upload*", async (r) => {
    const name = JSON.parse(r.request().postData() ?? "{}").name as string;
    await new Promise<void>((go) => uploadGates.push(go));
    await r.fulfill({ json: { path: `/home/gem/workspace/uploads/${name}`, name, kind: "image", size: 1000 } });
  });
  await page.route("**/api/tasks", async (r) => {
    const body = r.request().postDataJSON() as Row;
    bodies.push(body);
    const task = { id: `task-${bodies.length}`, revision: 1, title: String(body.text) || "附件", text: body.text, conversationId: `c-${bodies.length}`, status: "planning", result: null, error: null, attachments: body.attachments, relatedTaskId: body.relatedTaskId, dependencies: [], approvals: 0, createdAt: Date.now(), completedAt: null, clientMessageId: body.clientMessageId };
    // The poll may know the task before the answer arrives.
    if (opts.pollFirst) rows.push(task);
    await new Promise<void>((go) => gates.push(go));
    if (!opts.pollFirst) rows.push(task);
    await r.fulfill({ status: 202, json: { task, duplicate: false } });
  });
  await page.goto("/");
  await expect(page.locator(".feed-skeleton")).toHaveCount(0, { timeout: 60_000 });
  const release = async (list: Array<() => void>) => { await expect.poll(() => list.length).toBeGreaterThan(0); list.shift()!(); };
  return { rows, bodies, answer: () => release(gates), finishUpload: () => release(uploadGates) };
}

const box = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });

test("a sent message is on screen at once, the composer free, and its task takes its place without a second copy", async ({ page }, info) => {
  const { bodies, answer } = await setup(page);
  await box(page).fill("帮我查明天的天气");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // Before the server has answered: the message, the dispatch card, an empty composer.
  const outgoing = page.locator(".task-entry.outgoing");
  await expect(outgoing).toContainText("帮我查明天的天气", { timeout: 500 });
  await expect(outgoing.locator(".task-progress")).toContainText("正在分配");
  await expect(box(page)).toHaveValue("");
  await expect(box(page)).toBeEditable();
  await page.screenshot({ path: info.outputPath("sending.png") });
  await answer();
  await expect(outgoing).toHaveCount(0);
  await expect(page.locator(".task-entry")).toHaveCount(1);
  await expect(page.locator(".task-entry.adopted .msg.user")).toContainText("帮我查明天的天气");
  expect(bodies).toHaveLength(1);
});

test("a picture still uploading goes with the message, and messages reach the server in the order they were sent", async ({ page }, info) => {
  const { bodies, answer, finishUpload } = await setup(page);
  await page.getByTestId("attachment-input").setInputFiles({ name: "截图.png", mimeType: "image/png", buffer: PNG });
  await box(page).fill("看看这张");
  // Send while it uploads: the picture shows from the device, with a spinner.
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const first = page.locator(".task-entry.outgoing").first();
  await expect(first.locator(".outgoing-upload.image img")).toBeVisible();
  await expect(first.locator(".tray-spinner")).toBeVisible();
  await box(page).fill("顺便提醒我下午开会");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".task-entry.outgoing")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("uploading.png") });
  // Nothing goes to the server before the first message's upload is done; then in order.
  await page.waitForTimeout(300);
  expect(bodies).toEqual([]);
  await finishUpload();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ text: "看看这张", attachments: [{ path: "/home/gem/workspace/uploads/截图.png", kind: "image" }] });
  await answer();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ text: "顺便提醒我下午开会" });
  await answer();
  await expect(page.locator(".task-entry.outgoing")).toHaveCount(0);
  await expect(page.locator(".task-entry")).toHaveCount(2);
  // The sent picture shows from the device, not fetched back.
  await expect(page.locator(".task-entry").first().locator('[data-testid="file-card-thumb"]')).toBeVisible();
});

test("the poll bringing the task before the answer does not show the message twice", async ({ page }) => {
  const { answer } = await setup(page, { pollFirst: true });
  await box(page).fill("轮询先到");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".task-entry")).toHaveCount(1);
  await page.waitForTimeout(3000);
  await expect(page.locator(".msg.user", { hasText: "轮询先到" })).toHaveCount(1);
  await answer();
  await expect(page.locator(".msg.user", { hasText: "轮询先到" })).toHaveCount(1);
  await expect(page.locator(".task-entry.outgoing")).toHaveCount(0);
});
