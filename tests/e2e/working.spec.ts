import { expect, test, type Page } from "@playwright/test";
import { makeConversation, mockConsole, MOCK_STATUS } from "./mock-api";

/**
 * The collapsed "Working…" group: one per turn, holding that turn's tools and
 * reasoning summaries. These specs drive the real web bundle with every API
 * mocked. Incremental delivery is exercised through a controllable EventSource
 * shim, so a mid-stream update can be asserted to keep the user's expand state —
 * something a single fully-buffered SSE body cannot reproduce.
 */

const CONV_ID = "conv_e2e_working";
const evidence = "/Users/mengxiao/workspace/.scratch/artifacts/personal-agent-working-ui";

let nextId = 1;
function event(type: string, payload: Record<string, unknown>, turnId: string | null = null) {
  return { id: nextId++, type, turnId, createdAt: Date.now(), payload };
}

/** Replace EventSource with a test-controlled one and expose `__paEmit`. */
async function installEventSourceShim(page: Page) {
  await page.addInitScript(() => {
    type Listener = (ev: { data: string }) => void;
    const listeners = new Map<string, Set<Listener>>();
    const sources: Array<{ onmessage: Listener | null }> = [];
    class FakeEventSource {
      onmessage: Listener | null = null;
      onerror: Listener | null = null;
      constructor(public url: string) {
        sources.push(this as unknown as { onmessage: Listener | null });
      }
      addEventListener(type: string, fn: Listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      }
      removeEventListener(type: string, fn: Listener) {
        listeners.get(type)?.delete(fn);
      }
      close() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    (window as unknown as { __paEmit: (e: unknown) => void }).__paEmit = (e: unknown) => {
      const typed = e as { type: string };
      const raw = { data: JSON.stringify(e) };
      const named = listeners.get(typed.type);
      if (named && named.size) {
        for (const fn of named) fn(raw);
        return;
      }
      for (const s of sources) s.onmessage?.(raw);
    };
  });
}

async function openChat(page: Page, running = false) {
  const conversation = makeConversation(CONV_ID, "折叠分组会话");
  if (running) conversation.status = "running";
  await mockConsole(page, {
    conversations: [conversation],
    status: running
      ? { ...MOCK_STATUS, agent: { ...MOCK_STATUS.agent, activeConversationId: CONV_ID, activeTurnId: "t1" } }
      : MOCK_STATUS,
  });
  await installEventSourceShim(page);
  await page.goto("/");
  await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => (window as unknown as { __paEmit: (e: unknown) => void }).__paEmit({ id: 0, type: "replay.complete", turnId: null, createdAt: Date.now(), payload: { lastEventId: 0, replayed: 0 } }));
}

const head = (page: Page, n = 0) => page.locator(".working-head").nth(n);
const group = (page: Page, n = 0) => page.locator(".working").nth(n);

test.describe("working group", () => {
  test("is collapsed by default, expands and collapses on click, and reports aria-expanded", async ({ page }) => {
    await openChat(page, true);
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.started", { turnId: "t1" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/started", { item: { id: "c1", type: "commandExecution", command: "uname -a" } }, "t1"));

    const button = head(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".working-body")).toHaveCount(0);
    // Tools and summaries are not shown while collapsed.
    await expect(page.locator(".tool-title")).toHaveCount(0);

    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".working-body .tool-title")).toHaveText("执行命令");

    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".working-body")).toHaveCount(0);
  });

  test("is keyboard operable and toggles with Enter and Space", async ({ page }) => {
    await openChat(page, true);
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.started", { turnId: "t1" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }, "t1"));

    const button = head(page);
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("keeps the user's expand state across an incremental SSE update", async ({ page }) => {
    await openChat(page, true);
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.started", { turnId: "t1" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));
    await head(page).click();
    await expect(head(page)).toHaveAttribute("aria-expanded", "true");

    // A live delta, then a second tool: both arrive after the user expanded.
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("stream.delta", { itemId: "c1", kind: "item/commandExecution/outputDelta", delta: "probe-output" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/completed", { item: { id: "c2", type: "fileChange", changes: [{ path: "/home/gem/a.py" }], status: "completed" } }, "t1"));

    // Still expanded, and the update landed in the tool rather than the prose.
    await expect(head(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".working-body .tool")).toHaveCount(2);
    await expect(page.locator(".working-body .tool").first()).toContainText("probe-output");
    await expect(page.locator(".msg.assistant")).toHaveCount(0);
  });

  test("animates only a genuinely running turn and stops on every terminal state", async ({ page }) => {
    await openChat(page, true);
    const emit = (e: unknown) => page.evaluate((x) => (window as unknown as { __paEmit: (y: unknown) => void }).__paEmit(x), e);

    await emit(event("turn.started", { turnId: "t1" }, "t1"));
    await emit(event("item/started", { item: { id: "c1", type: "commandExecution", command: "sleep 1" } }, "t1"));
    await expect(group(page)).toHaveClass(/\bactive\b/);
    await expect(page.locator(".working-label")).toHaveText("Working…");
    expect(await page.locator(".working-label").evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");

    await emit(event("turn.finished", { turnId: "t1", status: "completed" }, "t1"));
    await expect(group(page)).not.toHaveClass(/\bactive\b/);
    await expect(page.locator(".working-label")).toHaveText("已完成");
    expect(await page.locator(".working-label").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    // The tool never got its item/completed: it must stop claiming to be running.
    await expect(page.locator(".working-head .dot.warn")).toHaveCount(0);
  });

  test("labels a failed turn as an execution error and flags the failed tool", async ({ page }) => {
    await openChat(page, true);
    const emit = (e: unknown) => page.evaluate((x) => (window as unknown as { __paEmit: (y: unknown) => void }).__paEmit(x), e);
    await emit(event("turn.started", { turnId: "t1" }, "t1"));
    await emit(event("item/started", { item: { id: "f1", type: "commandExecution", command: "boom" } }, "t1"));
    await emit(event("item/completed", { item: { id: "f1", type: "commandExecution", status: "failed" } }, "t1"));
    await emit(event("turn.failed", { turnId: "t1", message: "沙箱崩了" }, "t1"));

    await expect(page.locator(".working-label")).toHaveText("执行出错");
    await expect(group(page)).not.toHaveClass(/\bactive\b/);
    // A failed tool must be visible from the collapsed header, not hidden.
    await expect(page.locator(".working-flag")).toHaveText("工具出错");
  });

  test("does not animate a queued turn and never claims it is working", async ({ page }) => {
    await openChat(page, true);
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.queued", { turnId: "t1", text: "排队中" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));

    await expect(page.locator(".working-label")).toHaveText("已排队等待");
    await expect(group(page)).not.toHaveClass(/\bactive\b/);
    expect(await page.locator(".working-label").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("isolates turns and keeps approvals visible outside the group", async ({ page }) => {
    await openChat(page, true);
    const emit = (e: unknown) => page.evaluate((x) => (window as unknown as { __paEmit: (y: unknown) => void }).__paEmit(x), e);

    await emit(event("turn.started", { turnId: "t1" }, "t1"));
    await emit(event("item/completed", { item: { id: "a1", type: "commandExecution", status: "completed" } }, "t1"));
    await emit(event("turn.finished", { turnId: "t1", status: "completed" }, "t1"));
    await emit(event("turn.started", { turnId: "t2" }, "t2"));
    await emit(event("item/completed", { item: { id: "b1", type: "commandExecution", status: "completed" } }, "t2"));

    // Two isolated groups: the finished first turn stays static while the second runs.
    await expect(page.locator(".working")).toHaveCount(2);
    await expect(page.locator(".working-label").nth(0)).toHaveText("已完成");
    await expect(page.locator(".working-label").nth(1)).toHaveText("Working…");
    await expect(group(page, 0)).not.toHaveClass(/\bactive\b/);
    await expect(group(page, 1)).toHaveClass(/\bactive\b/);

    // An approval stays a top-level card: never hidden inside a collapsed group.
    await emit(event("approval.requested", { requestId: "r1", method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } }, "t2"));
    await expect(page.locator(".approval")).toBeVisible();
    await expect(page.locator(".working-body .approval")).toHaveCount(0);
    // The user's own message and assistant prose are never inside a group either.
    await expect(page.locator(".working-body .msg")).toHaveCount(0);
  });

  test("stops the sweep animation under prefers-reduced-motion while keeping the label", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openChat(page, true);
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.started", { turnId: "t1" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));

    await expect(page.locator(".working-label")).toHaveText("Working…");
    expect(await page.locator(".working-label").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    const sweep = page.locator(".working-sweep");
    expect(await sweep.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    expect(await sweep.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  });

  test("fits 1440/390/360 in dark and light without horizontal overflow", async ({ page }) => {
    await openChat(page, true);
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.started", { turnId: "t1" }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("item/completed", { item: { id: "c1", type: "commandExecution", command: "/bin/bash -lc \"aio shell exec 'inspect /home/gem/workspace/a-very-long-directory-name'\"", status: "completed", aggregatedOutput: "ok" } }, "t1"));
    await page.evaluate((e) => (window as unknown as { __paEmit: (x: unknown) => void }).__paEmit(e), event("turn.finished", { turnId: "t1", status: "completed" }, "t1"));

    const sizes = page.viewportSize()?.width === 1440 ? [[1440, 900]] : [[390, 844], [360, 844]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await expect(group(page)).toBeVisible();
        await head(page).click();
        await expect(page.locator(".working-body")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await head(page).click();
      }
    }
  });
});
