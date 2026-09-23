import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { makeConversation, mockConsole, MOCK_STATUS } from "./mock-api";

const id = "mobile-layout";
const evidence = "/Users/mengxiao/workspace/.scratch/artifacts/personal-agent-mobile-ui";
function stream() {
  const items = [
    { type: "commandExecution", id: "command", command: "/bin/bash -lc \"aio shell exec 'free -h; df -h; inspect /home/gem/workspace/a-very-long-directory'\"", status: "completed", aggregatedOutput: "Mem: 5.8Gi 2.6Gi available" },
    { type: "agentMessage", id: "answer", text: "已检查当前环境。系统内存总量 **5.8 GiB**，当前可用约 **2.6 GiB**。\n\n可以继续上传图片，或打开工作区查看文件。" },
  ];
  return items.map((item, i) => `id: ${i + 1}\nevent: item/completed\ndata: ${JSON.stringify({ id: i + 1, type: "item/completed", turnId: "t1", createdAt: Date.now(), payload: { item } })}\n\n`).join("") + 'event: replay.complete\ndata: {"lastEventId":2,"replayed":2}\n\n';
}
async function setup(page: Page, running = false) {
  const conversation = makeConversation(id, "询问磁盘容量上限与当前环境运行情况");
  if (running) conversation.status = "running";
  await mockConsole(page, {
    conversations: [conversation], sse: { [id]: stream() },
    status: running ? { ...MOCK_STATUS, agent: { ...MOCK_STATUS.agent, activeConversationId: id, activeTurnId: "t1" } } : MOCK_STATUS,
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  // Tools live inside the collapsed per-turn Working group; expand it to assert
  // the compact tool summary and measure it.
  await expect(page.locator(".working-head")).toBeVisible();
  await page.locator(".working-head").click();
  await expect(page.locator(".tool-title")).toHaveText("执行命令");
  await expect(page.locator(".msg.assistant")).toBeVisible();
}
async function assertLayout(page: Page) {
  const metrics = await page.evaluate(() => {
    const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON();
    return { composer: rect(".composer"), nav: rect(".bottom-nav"), attachment: rect(".file-button"), send: rect(".composer-row > button:last-child"), title: rect(".tool-title"), width: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.composer.height).toBeLessThan(170);
  expect(Math.abs(metrics.composer.bottom - metrics.nav.top)).toBeLessThan(2);
  expect(Math.abs(metrics.attachment.top - metrics.send.top)).toBeLessThan(2);
  expect(metrics.title.height).toBeLessThan(28);
  expect(metrics.title.width).toBeGreaterThan(45);
  expect(metrics.send.height).toBeGreaterThanOrEqual(44);
  // The attachment control sits at the composer's left edge and the send/stop
  // button at its right edge, with the free space between them — no dead gap
  // left of the button after the model control was removed.
  expect(metrics.attachment.left - metrics.composer.left).toBeLessThanOrEqual(13);
  expect(metrics.composer.right - metrics.send.right).toBeLessThanOrEqual(13);
  expect(metrics.send.left).toBeGreaterThan(metrics.attachment.right);
  expect(metrics.send.right).toBeLessThanOrEqual(metrics.viewport);
}

test("compact mobile composer and horizontal tool title at 390 and 360, including short viewport", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "mobile layout");
  await setup(page);
  await mkdir(evidence, { recursive: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await assertLayout(page);
    // The composer no longer carries any model control, on any width.
    await expect(page.locator(".composer select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "模型与思考设置" })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", scale: "css", path: `${evidence}/mobile-${width}-dark.png` });
  }
  await page.setViewportSize({ width: 390, height: 430 });
  await page.getByRole("textbox", { name: "消息" }).focus();
  await assertLayout(page);
  expect(await page.locator(".composer").evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(430);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await page.screenshot({ animations: "disabled", scale: "css", path: `${evidence}/mobile-390-light.png` });
});

test("native attachment chooser and send retain their payload without model fields", async ({ page }, info) => {
  await setup(page);
  await page.route("**/api/sandbox/upload", route => route.fulfill({ json: { path: "/home/gem/workspace/uploads/probe.txt", name: "移动端附件测试.txt", kind: "file" } }));
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".file-button").click();
  await (await chooser).setFiles({ name: "移动端附件测试.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
  await expect(page.locator(".composer .chip")).toContainText("移动端附件测试.txt");
  let payload: any;
  await page.route(`**/api/conversations/${id}/turns`, async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({ json: { turn: { id: "t2" }, duplicate: false } });
  });
  await page.getByRole("textbox", { name: "消息" }).fill("请阅读附件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("");
  // The client sends no model/effort: the server reads the saved unified config.
  expect(payload).toMatchObject({ text: "请阅读附件", attachments: [{ path: "/home/gem/workspace/uploads/probe.txt" }] });
  expect(payload).not.toHaveProperty("model");
  expect(payload).not.toHaveProperty("effort");
  if (info.project.name === "desktop") {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ animations: "disabled", scale: "css", path: `${evidence}/desktop-1440.png` });
  }
});

test("stop is reachable in the mobile toolbar while a turn runs", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "mobile layout");
  await setup(page, true);
  let stopped = false;
  await page.route(`**/api/conversations/${id}/interrupt`, async route => {
    stopped = true;
    await route.fulfill({ json: { ok: true, status: "interrupt_requested", message: "已请求停止" } });
  });
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => stopped).toBe(true);
});
