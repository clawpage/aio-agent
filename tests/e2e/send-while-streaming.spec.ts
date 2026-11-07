import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

// While a reply is being written out (its stream re-renders the feed many times a second), the
// composer still sends: the send button takes a tap or a click like any other time.
const streamingSource = () => {
  class FakeSource {
    listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    timer = 0;
    constructor(public url: string) {
      let id = 1;
      const emit = (type: string, payload: unknown) => { for (const fn of this.listeners[type] ?? []) fn(new MessageEvent(type, { data: JSON.stringify({ id: id++, conversationId: "exec", turnId: "t1", type, payload, createdAt: Date.now() }) })); };
      setTimeout(() => {
        emit("item/started", { item: { type: "agentMessage", id: "f1", text: "", phase: "final_answer" } });
        this.timer = window.setInterval(() => emit("stream.delta", { itemId: "f1", kind: "item/agentMessage/delta", delta: "今天多云，" }), 30);
      }, 200);
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void) { (this.listeners[type] ??= []).push(fn); }
    close() { clearInterval(this.timer); }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
};

test("the send button works while a reply streams in", async ({ page }, info) => {
  await page.addInitScript(streamingSource);
  await mockConsole(page, { conversations: [] });
  const task = { id: "live", revision: 1, title: "今天天气", text: "今天天气怎么样", conversationId: "exec", status: "running", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 60_000, startedAt: Date.now() - 50_000, completedAt: null, messages: [] };
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  const sent: unknown[] = [];
  await page.route("**/api/tasks", (r) => {
    sent.push(r.request().postDataJSON());
    return r.fulfill({ status: 202, json: { task: { ...task, id: "new", conversationId: "c-new", status: "planning", title: "明天呢" }, duplicate: false } });
  });
  await page.goto("/");
  await expect(page.locator('.task-report.drafting[data-task-id="live"]')).toContainText("今天多云");
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("明天呢");
  const send = page.getByRole("button", { name: "发送", exact: true });
  if (info.project.name.startsWith("mobile")) await send.tap(); else await send.click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(box).toHaveValue("");

  // iOS WebKit may drop the click of a tap while the page changes: the finger lifting on the button is enough.
  await box.fill("后天呢");
  await send.evaluate((button: HTMLElement) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    const at = { clientX: x + width / 2, clientY: y + height / 2, bubbles: true, pointerType: "touch", isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerdown", at));
    button.dispatchEvent(new PointerEvent("pointerup", at));
  });
  await expect.poll(() => sent.length).toBe(2);
  await expect(box).toHaveValue("");
  // And when the click does follow the touch, the message still goes once.
  await box.fill("大后天呢");
  await send.evaluate((button: HTMLElement) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    button.dispatchEvent(new PointerEvent("pointerup", { clientX: x + width / 2, clientY: y + height / 2, bubbles: true, pointerType: "touch" }));
    button.click();
  });
  await expect.poll(() => sent.length).toBe(3);
  await page.waitForTimeout(300);
  expect(sent.length).toBe(3);
});
