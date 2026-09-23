import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole, type MockConversation } from "./mock-api";

/**
 * The agent driving the sandbox browser must reveal the workspace browser on the
 * foreground chat page, but only for a *live* event: initial history replay and
 * reconnect replay must never move the workspace, and a command that merely
 * mentions navigation must not be mistaken for one.
 *
 * The SSE stream is fully mocked by `mockConsole`, so ordering between the
 * replayed history and `replay.complete` is deterministic.
 */

const CONV_ID = "conv_e2e_auto_browser";
const conversations: MockConversation[] = [makeConversation(CONV_ID, "自动浏览器")];

function itemStarted(id: number, item: Record<string, unknown>): string {
  const event = { id, type: "item/started", turnId: "t1", createdAt: Date.now(), payload: { item } };
  return `id: ${id}\nevent: item/started\ndata: ${JSON.stringify(event)}\n\n`;
}

function replayComplete(lastEventId: number): string {
  return `event: replay.complete\ndata: ${JSON.stringify({ lastEventId, replayed: lastEventId })}\n\n`;
}

function sse(...frames: string[]): string {
  return ["retry: 3000\n\n", ...frames].join("");
}

test.describe("agent browser navigation", () => {
  test("a live aio browser navigate command opens the workspace browser", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "commandExecution", command: "aio browser navigate https://example.com" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".workspace")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
  });

  test("a replayed navigation command (before replay.complete) does not open the workspace", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          itemStarted(1, { id: "i1", type: "commandExecution", command: "aio browser navigate https://example.com" }),
          replayComplete(1),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await expect(page.locator(".workspace")).toHaveCount(0);
  });

  test("a command that only mentions navigation, or another browser action, does not open the workspace", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "commandExecution", command: "echo 'aio browser navigate https://example.com'" }),
          itemStarted(2, { id: "i2", type: "commandExecution", command: "aio browser screenshot -o shot.png" }),
          itemStarted(3, { id: "i3", type: "mcpToolCall", server: "aio_browser", tool: "browser_screenshot" }),
          itemStarted(4, { id: "i4", type: "mcpToolCall", server: "other_server", tool: "browser_navigate" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await expect(page.locator(".workspace")).toHaveCount(0);
  });

  test("the aio_browser MCP navigate tool also opens the workspace browser", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "mcpToolCall", server: "aio_browser", tool: "browser_navigate" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".workspace")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
  });

  test("a background/unfocused page does not steal focus", async ({ page }) => {
    // Simulate the tab being in the background: a live navigation must not yank
    // the workspace open while the user is looking at something else.
    await page.addInitScript(() => {
      Document.prototype.hasFocus = () => false;
    });
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "commandExecution", command: "aio browser navigate https://example.com" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await expect(page.locator(".workspace")).toHaveCount(0);
  });
});
