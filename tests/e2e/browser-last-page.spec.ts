import { test, expect } from "@playwright/test";
import zlib from "node:zlib";
import { makeConversation, mockConsole } from "./mock-api";
import type { Task } from "../../src/ui/src/types";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
/** A real PNG the size of the sandbox browser's window: the card's picture depends on its proportions. */
function page1280(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const [w, h] = [1280, 1000];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, y < 120 ? 0x23 : y > 880 ? 0x9a : 0xf2)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const last = { url: "https://www.amazon.com/checkout/p/p-123/spc", title: "Amazon.com Checkout", at: 1700, shot: true };

test("a finished task whose tab was closed keeps a snapshot of its page, and one tap opens it again to operate", async ({ page }, info) => {
  const row: Task = { id: "task-1", revision: 1, title: "继续在Amazon购买丝塔芙温和洁面乳", text: "继续买", conversationId: "child-1", status: "completed", result: "Amazon 结账页已准备好：请在打开的浏览器里点击 **Place your order**。", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1001, completedAt: 1500, browser: { tabs: 0, request: null, human: false, last } };
  await mockConsole(page, { conversations: [makeConversation(row.conversationId, row.title)] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [row], nextBefore: null } }));
  await page.route("**/api/tasks/task-1/browser/last-shot*", (r) => r.fulfill({ contentType: "image/png", body: page1280() }));
  const tab = { id: "t4", title: "Amazon.com Checkout", url: last.url, lastUsed: 2, finishedAt: 2, holder: "human" as "ai" | "human", request: null };
  const reopened: string[] = [];
  await page.route("**/api/tasks/task-1/browser/reopen", async (r) => {
    reopened.push(r.request().method());
    row.browser = { tabs: 1, request: null, human: true };
    await r.fulfill({ json: { tab } });
  });
  await page.route("**/api/tasks/task-1/browser", (r) => r.fulfill({ json: { tabs: [tab] } }));
  await page.route("**/api/tasks/task-1/browser/screenshot*", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("**/api/tasks/task-1/browser/control", async (r) => {
    tab.holder = r.request().postDataJSON().action === "take" ? "human" : "ai";
    row.browser = { tabs: 1, request: null, human: tab.holder === "human" };
    await r.fulfill({ json: { tab } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");

  const card = page.getByRole("group", { name: "任务浏览器：页面已关闭" });
  await expect(card).toContainText("Amazon.com Checkout");
  await expect(card).toContainText("www.amazon.com");
  await expect(card.getByRole("img", { name: /上次页面快照/ })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const picture = card.getByRole("img", { name: /上次页面快照/ });
  await expect.poll(() => picture.evaluate((n) => (n as HTMLImageElement).naturalWidth)).toBe(1280);
  if (info.project.name === "desktop") {
    // On a wide screen the card stays page-shaped and shows the whole page, not a strip of its top.
    expect((await card.boundingBox())!.width).toBeLessThanOrEqual(521);
    const box = (await picture.boundingBox())!;
    expect(box.height / box.width).toBeCloseTo(1000 / 1280, 1);
  }
  await page.screenshot({ path: info.outputPath("last-page.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await card.getByRole("button", { name: "重新打开页面" }).click();
  await expect.poll(() => reopened).toEqual(["POST"]);
  // The page is the person's at once: the operating panel opens on it.
  await expect(page.getByRole("dialog", { name: "操作任务页面" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("reopened.png") });
  await page.getByRole("dialog", { name: "操作任务页面" }).getByRole("button", { name: "关闭操作面板" }).click();
  await expect(page.getByRole("group", { name: "任务浏览器：你正在操作" })).toBeVisible();
});
