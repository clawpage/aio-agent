import { expect, test, type Page } from "@playwright/test";
import { makeConversation, mockConsole, MOCK_STATUS } from "./mock-api";

/**
 * The collapsed activity row. A turn is split into *segments*: visible prose (or
 * an approval card) closes the current run of tools/summaries and opens a fresh
 * one after it, so the stream reads `文本1 — 执行N项 — 文本2 — 执行M项 — 进行中`
 * and the still-running row is always the last thing on screen. These specs drive
 * the real web bundle with every API mocked. Incremental delivery is exercised
 * through a controllable EventSource shim, so a mid-stream update can be asserted
 * to keep the user's expand state — something a single fully-buffered SSE body
 * cannot reproduce.
 */

const CONV_ID = "conv_e2e_working";
const evidence = "var/.playwright-artifacts/working-ui";

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

const emit = (page: Page, e: unknown) =>
  page.evaluate((x) => (window as unknown as { __paEmit: (y: unknown) => void }).__paEmit(x), e);

/**
 * A history long enough to overflow any viewport, ending with a multi-tool turn
 * that is expanded. Used to prove the card renders its natural height instead of
 * being squeezed by the scrolling flex container.
 */
async function longHistory(page: Page, turns = 8, toolsPerTurn = 3, longFinalOutput = false) {
  for (let turn = 1; turn <= turns; turn += 1) {
    const tid = `t${turn}`;
    await emit(page, event("turn.queued", { turnId: tid, text: `第 ${turn} 轮`, clientMessageId: `c${turn}` }, tid));
    await emit(page, event("turn.started", { turnId: tid }, tid));
    for (let i = 0; i < toolsPerTurn; i += 1) {
      await emit(page, event("item/started", { item: { id: `cmd${turn}_${i}`, type: "commandExecution", command: `echo step-${turn}-${i}` } }, tid));
      // The final tool of the final turn can carry a log long enough to exceed
      // the tool card's own 260px cap, so the nested-log case proves the cap.
      const isFinal = longFinalOutput && turn === turns && i === toolsPerTurn - 1;
      const output = isFinal ? Array.from({ length: 60 }, (_, n) => `log line ${n}`).join("\n") : `line ${i}\n`.repeat(4);
      await emit(page, event("item/completed", { item: { id: `cmd${turn}_${i}`, type: "commandExecution", status: "completed", aggregatedOutput: output } }, tid));
    }
    await emit(page, event("item/completed", { item: { id: `sum${turn}`, type: "reasoning", summary: [`第 ${turn} 轮摘要`, "第二段摘要"] } }, tid));
    await emit(page, event("item/completed", { item: { id: `msg${turn}`, type: "agentMessage", text: `第 ${turn} 轮的回答正文。` } }, tid));
    await emit(page, event("turn.finished", { turnId: tid, status: "completed" }, tid));
  }
}

/**
 * Bulk-expand every group by dispatching clicks in the DOM. Only for geometry
 * measurements that need all groups open at once; a spec that exercises the real
 * user interaction must use a real `locator.click()` on the group it is testing.
 */
async function expandAll(page: Page) {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll<HTMLButtonElement>(".working-head")) b.click();
  });
}

/** Geometry of the last (expanded) card: is it squeezed or clipped? */
async function cardGeometry(page: Page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll(".working");
    const el = cards[cards.length - 1] as HTMLElement;
    const body = el.querySelector(".working-body") as HTMLElement;
    const rows = [...el.querySelectorAll(".working-body > *")] as HTMLElement[];
    const scroll = document.querySelector(".chat-scroll") as HTMLElement;
    const composer = document.querySelector(".composer") as HTMLElement;
    return {
      cardHeight: Math.round(el.getBoundingClientRect().height),
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      // Natural height means the body never scrolls itself: its own content must
      // fit exactly, with the chat scroller owning all scrolling.
      bodyScrollOverflow: body.scrollHeight - body.clientHeight,
      cardScrollOverflow: el.scrollHeight - el.clientHeight,
      bodyBottomVsCardBottom: Math.round(body.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom),
      rowCount: rows.length,
      rowsWithHeight: rows.filter((r) => r.getBoundingClientRect().height > 0).length,
      scrollOverflow: scroll.scrollHeight - scroll.clientHeight,
      composerBottom: Math.round(composer.getBoundingClientRect().bottom),
      viewportHeight: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

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
    // A settled row states what it did, and never claims to be working.
    await expect(page.locator(".working-label")).toHaveText("执行了 1 项操作");
    expect(await page.locator(".working-label").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    // History carries a neutral mark, not the amber in-progress dot.
    await expect(page.locator(".working-head .dot.warn")).toHaveCount(0);
    await expect(page.locator(".working-head .dot.idle")).toHaveCount(1);
  });

  test("labels a failed turn as an execution error and flags the failed tool", async ({ page }) => {
    await openChat(page, true);
    const emit = (e: unknown) => page.evaluate((x) => (window as unknown as { __paEmit: (y: unknown) => void }).__paEmit(x), e);
    await emit(event("turn.started", { turnId: "t1" }, "t1"));
    await emit(event("item/started", { item: { id: "f1", type: "commandExecution", command: "boom" } }, "t1"));
    await emit(event("item/completed", { item: { id: "f1", type: "commandExecution", status: "failed" } }, "t1"));
    await emit(event("turn.failed", { turnId: "t1", message: "沙箱崩了" }, "t1"));

    await expect(page.locator(".working-label")).toHaveText("执行了 1 项操作 · 出错");
    await expect(group(page)).not.toHaveClass(/\bactive\b/);
    // A failed tool must be visible from the collapsed header, not hidden.
    await expect(page.locator(".working-flag")).toHaveText("工具出错");
    await expect(page.locator(".working-head .dot.error")).toHaveCount(1);
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

    // Two isolated rows: the finished first turn stays static while the second runs.
    await expect(page.locator(".working")).toHaveCount(2);
    await expect(page.locator(".working-label").nth(0)).toHaveText("执行了 1 项操作");
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

test.describe("interleaved activity segments", () => {
  test("orders text/activity/text/activity with the running row last", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("item/completed", { item: { id: "m1", type: "agentMessage", text: "第一段正文。" } }, "t1"));
    await emit(page, event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls -la" } }, "t1"));
    await emit(page, event("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "a" } }, "t1"));
    await emit(page, event("item/completed", { item: { id: "m2", type: "agentMessage", text: "第二段正文。" } }, "t1"));
    await emit(page, event("item/started", { item: { id: "c2", type: "commandExecution", command: "pwd" } }, "t1"));

    // Rendered order: 文本1 — 执行1 — 文本2 — 进行中.
    const order = await page.evaluate(() =>
      [...document.querySelectorAll(".chat-scroll > *")]
        .filter((el) => el.matches(".msg.assistant") || el.matches(".working"))
        .map((el) => (el.matches(".working") ? "working" : "assistant")),
    );
    expect(order).toEqual(["assistant", "working", "assistant", "working"]);

    // Exactly one row is current, and it is the bottom-most timeline element.
    await expect(page.locator(".working.active")).toHaveCount(1);
    await expect(group(page, 1)).toHaveClass(/\bactive\b/);
    await expect(group(page, 0)).not.toHaveClass(/\bactive\b/);
    // The completed run reports what it did, without repeating the count.
    await expect(page.locator(".working-label").nth(0)).toHaveText("执行了 1 项操作");
    await expect(group(page, 0).locator(".working-meta")).toHaveCount(0);
    await expect(group(page, 0).locator(".working-head .dot.warn")).toHaveCount(0);
    await expect(group(page, 0).locator(".working-head .dot.idle")).toHaveCount(1);
  });

  test("keeps each segment's expand state independent across a live delta", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));
    await emit(page, event("item/completed", { item: { id: "m1", type: "agentMessage", text: "中间说明。" } }, "t1"));
    await emit(page, event("item/started", { item: { id: "c2", type: "commandExecution", command: "pwd" } }, "t1"));

    // Open the first (historical) segment...
    await head(page, 0).click();
    await expect(head(page, 0)).toHaveAttribute("aria-expanded", "true");
    await expect(head(page, 1)).toHaveAttribute("aria-expanded", "false");

    // ...then a delta for the second segment must not reset it, and the open
    // state must not leak between segments.
    await emit(page, event("stream.delta", { itemId: "c2", kind: "item/commandExecution/outputDelta", delta: "still-running" }, "t1"));
    await expect(head(page, 0)).toHaveAttribute("aria-expanded", "true");
    await expect(head(page, 1)).toHaveAttribute("aria-expanded", "false");
    await expect(group(page, 0).locator(".working-body .tool")).toHaveCount(1);
    await expect(group(page, 1).locator(".working-body")).toHaveCount(0);
  });

  test("routes a late tool completion and log back into its original segment", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("item/started", { item: { id: "c1", type: "commandExecution", command: "slow-build" } }, "t1"));
    await emit(page, event("item/completed", { item: { id: "m1", type: "agentMessage", text: "等待编译。" } }, "t1"));

    // The completion + a late log arrive while the second segment is the live one.
    await emit(page, event("stream.delta", { itemId: "c1", kind: "item/commandExecution/outputDelta", delta: "late-log-line" }, "t1"));
    await emit(page, event("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "late-log-line" } }, "t1"));

    // No duplicate row was created, and the log landed in the *first* segment.
    await expect(page.locator(".working")).toHaveCount(2);
    await head(page, 0).click();
    const tool = group(page, 0).locator(".working-body .tool");
    await expect(tool).toHaveCount(1);
    await expect(tool).toContainText("late-log-line");
    // The tool is its own collapsed <details> (unlike the group header), and the
    // late completion settled it: open it and prove the log is really visible and
    // the card reads as finished, not still in progress.
    await expect(tool).not.toHaveAttribute("open", "");
    await tool.locator("summary").click();
    await expect(tool).toHaveAttribute("open", "");
    await expect(tool.locator("pre")).toBeVisible();
    await expect(tool.locator("pre")).toContainText("late-log-line");
    await expect(tool).toHaveClass(/\bdone\b/);
    // The live segment stayed empty and current.
    await expect(group(page, 1)).toHaveClass(/\bactive\b/);
    await expect(page.locator(".msg.assistant")).toHaveCount(1);
  });

  test("labels a closed summary-only history segment without in-progress wording", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("stream.delta", { itemId: "r1", kind: "item/reasoning/summaryTextDelta", delta: "先想一想" }, "t1"));
    await emit(page, event("item/completed", { item: { id: "m1", type: "agentMessage", text: "说一下结论。" } }, "t1"));

    // The closed summary run is a finished historical record, not a current one.
    await expect(page.locator(".working-label").nth(0)).toHaveText("思考摘要");
    await expect(page.locator(".working-label").nth(0)).not.toContainText("Working");
    await expect(group(page, 0)).not.toHaveClass(/\bactive\b/);
    // Only the trailing row is current.
    await expect(page.locator(".working.active")).toHaveCount(1);
    await expect(page.locator(".working-label").last()).toHaveText("Working…");
  });

  test("keeps the live row last when a blank agentMessage start precedes the tool", async ({ page }) => {
    await openChat(page, true);
    // The real bridge order that regressed: turn starts, blank `agentMessage`
    // item opens, then a thread notice, then the tool.
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("item/started", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"));
    await emit(page, event("thread.started", { threadId: "th1", model: "gpt-x" }, "t1"));
    await emit(page, event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));

    // The blank start painted nothing: no assistant bubble, and the live activity
    // row is still the last element in the scroll container.
    await expect(page.locator(".msg.assistant")).toHaveCount(0);
    const lastIsWorking = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll(".chat-scroll > *")].filter(
        (el) => el.matches(".working") || el.matches(".status-line") || el.matches(".msg.assistant"),
      );
      return nodes[nodes.length - 1]!.matches(".working");
    });
    expect(lastIsWorking).toBe(true);
    await expect(page.locator(".working.active")).toHaveCount(1);
  });

  test("lets real prose after a blank start form the block in stream order", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("item/started", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"));
    await emit(page, event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));

    // A blank completion with no prose must not split the tool segment either.
    await emit(page, event("item/completed", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"));
    await expect(page.locator(".working")).toHaveCount(1);
    await expect(page.locator(".msg.assistant")).toHaveCount(0);

    // The first real prose lands after the tool: it becomes a visible block, and
    // a fresh live row follows it — the structure is text/activity/text/activity,
    // never an empty bubble ahead of the tool.
    await emit(page, event("item/completed", { item: { id: "m2", type: "agentMessage", text: "结论如下。" } }, "t1"));
    await expect(page.locator(".working")).toHaveCount(2);
    await expect(page.locator(".msg.assistant")).toHaveCount(1);
    await expect(page.locator(".msg.assistant")).toContainText("结论如下。");
    await expect(page.locator(".working.active")).toHaveCount(1);
    await expect(page.locator(".working-label").last()).toHaveText("Working…");
  });

  test("keeps a visible status line above the live row and never below it", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("thread.started", { threadId: "th1", model: "gpt-x" }, "t1"));
    await emit(page, event("warning", { message: "注意配额" }, "t1"));
    await emit(page, event("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));

    // The running row stays the bottom-most element even after visible status
    // events arrive; the notices sit above it.
    const lastIsWorking = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll(".chat-scroll > *")].filter(
        (el) => el.matches(".working") || el.matches(".status-line"),
      );
      return nodes[nodes.length - 1]!.matches(".working");
    });
    expect(lastIsWorking).toBe(true);
    await expect(page.locator(".working.active")).toHaveCount(1);
  });

  test("never leaves a stale working row behind a stopped or failed turn", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("turn.interrupt_requested", { turnId: "t1" }, "t1"));
    // While stopping the row is still the live one, at the bottom.
    await expect(page.locator(".working-label")).toHaveText("正在停止…");
    await emit(page, event("turn.finished", { turnId: "t1", status: "interrupted" }, "t1"));
    // Nothing was recorded, so no empty row survives — the stop is still reported.
    await expect(group(page)).toHaveCount(0);
    await expect(page.locator(".status-line").last()).toContainText("已停止");
    await expect(page.locator(".working.active")).toHaveCount(0);
  });
});

test.describe("working group height and presence", () => {
  test("shows one Working row from turn.started, before any tool or summary", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));

    // The row exists immediately, collapsed, and says it is working.
    await expect(group(page)).toBeVisible();
    await expect(page.locator(".working-label")).toHaveText("Working…");
    await expect(head(page)).toHaveAttribute("aria-expanded", "false");

    // Expanding an activity-free turn gives an honest line, not a fake summary.
    await head(page).click();
    await expect(page.locator(".working-body .working-empty")).toHaveText("正在处理…");
    await expect(page.locator(".working-body .tool")).toHaveCount(0);
    await expect(page.locator(".working-body .reasoning")).toHaveCount(0);
  });

  test("shows the current-activity row for a prose-only turn, then leaves nothing stale", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("item/completed", { item: { id: "m1", type: "agentMessage", text: "只有正文的回答。" } }, "t1"));

    // While the turn runs, the prose is followed by the live activity row.
    await expect(page.locator(".msg.assistant")).toContainText("只有正文的回答。");
    await expect(group(page)).toBeVisible();
    await expect(page.locator(".working-label")).toHaveText("Working…");
    await head(page).click();
    await expect(page.locator(".working-body .working-empty")).toHaveText("正在处理…");

    // Once it settles nothing empty ("执行 0 项操作") is left behind...
    await emit(page, event("turn.finished", { turnId: "t1", status: "completed" }, "t1"));
    await expect(group(page)).toHaveCount(0);
    // ...but the turn's outcome is still reported truthfully.
    await expect(page.locator(".status-line").last()).toContainText("本轮完成");
  });

  test("keeps a blank-summary turn's row while it runs and never shows raw reasoning", async ({ page }) => {
    await openChat(page, true);
    await emit(page, event("turn.started", { turnId: "t1" }, "t1"));
    await emit(page, event("stream.delta", { itemId: "raw", kind: "item/reasoning/textDelta", delta: "RAW COT" }, "t1"));
    await emit(page, event("stream.delta", { itemId: "r", kind: "item/reasoning/summaryTextDelta", delta: "   " }, "t1"));
    await emit(page, event("item/completed", { item: { id: "r", type: "reasoning", summary: [] } }, "t1"));

    // The row survives the blank summary, still animating, with no empty box.
    await expect(group(page)).toBeVisible();
    await expect(page.locator(".working-label")).toHaveText("Working…");
    await head(page).click();
    await expect(page.locator(".working-body .reasoning")).toHaveCount(0);
    await expect(page.locator(".working-body .working-empty")).toHaveText("正在处理…");
    // Raw chain-of-thought is never surfaced anywhere.
    await expect(page.locator(".chat-scroll")).not.toContainText("RAW COT");
  });

  test("expands to its natural height in a long history at each viewport", async ({ page }) => {
    await openChat(page, false);
    await longHistory(page);
    await expect(group(page, 7)).toBeVisible();

    const sizes = page.viewportSize()?.width === 1440 ? [[1440, 900]] : [[390, 844], [360, 844]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await expandAll(page);
      await expect(page.locator(".working-body")).toHaveCount(8);
      const geo = await cardGeometry(page);
      // The card renders its whole content: nothing is clipped by the card itself.
      expect(geo.cardScrollOverflow, `card clipped at ${width}`).toBeLessThanOrEqual(1);
      expect(geo.bodyBottomVsCardBottom, `body bottom vs card bottom at ${width}`).toBeLessThanOrEqual(1);
      expect(geo.rowsWithHeight).toBe(geo.rowCount);
      // The expanded body is a real area, not a squeezed sliver.
      expect(geo.bodyHeight, `body height at ${width}`).toBeGreaterThan(120);
      // Natural height: the body renders all of its content and never scrolls
      // itself — the outer chat scroller is the only scroll container.
      expect(geo.bodyScrollOverflow, `body must not scroll itself at ${width}`).toBeLessThanOrEqual(1);
      expect(geo.cardHeight).toBeGreaterThan(geo.bodyHeight);
      // The history overflows the scroller instead, and the composer stays put.
      expect(geo.scrollOverflow).toBeGreaterThan(0);
      expect(geo.composerBottom).toBeLessThanOrEqual(geo.viewportHeight + 1);
      expect(geo.horizontalOverflow).toBeLessThanOrEqual(1);
      // Collapse again before the next size, so the next measurement is fresh.
      await expandAll(page);
    }
  });

  test("keeps every row reachable and really clickable in a long history", async ({ page }) => {
    await openChat(page, false);
    await longHistory(page, 8, 2);
    await expect(page.locator(".working")).toHaveCount(8);
    await expect(page.locator(".working-head")).toHaveCount(8);

    // Walk every group: scroll it into view, then use a real pointer click (no
    // force, no DOM dispatch) and check the real expand/collapse result. An
    // off-screen history row is scrolled to first, which is exactly the
    // reachability a user relies on.
    for (let i = 0; i < 8; i += 1) {
      const button = head(page, i);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.height, `row ${i} height`).toBeGreaterThanOrEqual(30);

      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(group(page, i).locator(".working-body")).toBeVisible();
      await expect(group(page, i).locator(".working-body > *").first()).toBeVisible();

      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(group(page, i).locator(".working-body")).toHaveCount(0);
    }
  });

  test("expands a nested tool log inside a long history without clipping", async ({ page }) => {
    await openChat(page, false);
    await longHistory(page, 8, 3, true);
    const last = 7;

    // Expand the final turn's group with a real click, then its last tool summary.
    const button = head(page, last);
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");

    const tool = group(page, last).locator(".tool").last();
    await tool.locator("summary").click();
    await expect(tool).toHaveAttribute("open", "");

    const geo = await page.evaluate(() => {
      const card = document.querySelectorAll(".working")[document.querySelectorAll(".working").length - 1] as HTMLElement;
      const body = card.querySelector(".working-body") as HTMLElement;
      const openTool = card.querySelector(".tool[open]") as HTMLElement;
      const pre = openTool.querySelector("pre") as HTMLElement;
      const scroll = document.querySelector(".chat-scroll") as HTMLElement;
      const r = (el: Element) => el.getBoundingClientRect();
      return {
        cardContainsBody: r(card).bottom >= r(body).bottom - 1,
        cardContainsTool: r(card).bottom >= r(openTool).bottom - 1,
        cardScrollOverflow: card.scrollHeight - card.clientHeight,
        // The tool's own log keeps its internal 260px cap and scrolls itself.
        preHeight: Math.round(r(pre).height),
        preScrollable: pre.scrollHeight - pre.clientHeight,
        outerScrollable: scroll.scrollHeight - scroll.clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });

    expect(geo.cardScrollOverflow).toBeLessThanOrEqual(1);
    expect(geo.cardContainsBody).toBe(true);
    expect(geo.cardContainsTool).toBe(true);
    // The log is longer than the cap, so the card clamps it to 260px and the log
    // scrolls inside itself — readable, not clipped away.
    expect(geo.preHeight).toBeLessThanOrEqual(261);
    expect(geo.preHeight).toBeGreaterThan(200);
    expect(geo.preScrollable).toBeGreaterThan(0);
    // The outer chat scrolls the history.
    expect(geo.outerScrollable).toBeGreaterThan(0);
    expect(geo.horizontalOverflow).toBeLessThanOrEqual(1);
  });

  test("keeps the expanded body usable at a short viewport", async ({ page }) => {
    await openChat(page, false);
    await longHistory(page, 6, 3);
    await page.setViewportSize({ width: 390, height: 430 });
    await expandAll(page);
    await expect(page.locator(".working-body").last()).toBeVisible();

    const geo = await cardGeometry(page);
    expect(geo.cardScrollOverflow).toBeLessThanOrEqual(1);
    expect(geo.bodyBottomVsCardBottom).toBeLessThanOrEqual(1);
    expect(geo.bodyHeight).toBeGreaterThan(120);
    expect(geo.composerBottom).toBeLessThanOrEqual(431);
    expect(geo.horizontalOverflow).toBeLessThanOrEqual(1);
  });
});
