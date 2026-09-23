import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * Visual polish is functional enough to test: while the agent is working the
 * chat carries a `running` state and calm activity animations, message blocks
 * animate in, and `prefers-reduced-motion: reduce` switches all of it off. All
 * API calls are mocked locally, so this never touches a deployment.
 */

const CONV_ID = "conv_e2e_motion";

function sseWithAgentMessage(): string {
  const event = {
    id: 1,
    type: "item/completed",
    turnId: "t1",
    createdAt: Date.now(),
    payload: { item: { id: "i1", type: "agentMessage", text: "正在处理，请稍候。" } },
  };
  return [
    "retry: 3000",
    "",
    `id: 1\nevent: item/completed\ndata: ${JSON.stringify(event)}\n\n`,
    `event: replay.complete\ndata: ${JSON.stringify({ lastEventId: 1, replayed: 1 })}\n\n`,
  ].join("\n");
}

function runningConversation() {
  const conversation = makeConversation(CONV_ID, "运行态会话");
  conversation.status = "running";
  return conversation;
}

async function animationName(page: import("@playwright/test").Page, selector: string, pseudo?: string): Promise<string> {
  return page.locator(selector).first().evaluate(
    (el, p) => getComputedStyle(el, p ?? undefined).animationName,
    pseudo,
  );
}

test.describe("chat activity motion", () => {
  test("a running conversation shows the activity state and animations", async ({ page }) => {
    await mockConsole(page, {
      conversations: [runningConversation()],
      sse: { [CONV_ID]: sseWithAgentMessage() },
    });
    await page.goto("/");

    const chat = page.locator(".chat");
    await expect(chat).toBeVisible({ timeout: 20_000 });
    await expect(chat).toHaveClass(/\brunning\b/);
    await expect(page.locator(".chat-sub")).toHaveText("智能体工作中…");

    await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
    expect(await animationName(page, ".msg")).toContain("msg-in");
    expect(await animationName(page, ".chat.running .chat-title .dot")).toContain("breathe");
    expect(await animationName(page, ".chat.running .composer", "::before")).toContain("flow");
  });

  test("prefers-reduced-motion: reduce turns decorative motion off", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockConsole(page, {
      conversations: [runningConversation()],
      sse: { [CONV_ID]: sseWithAgentMessage() },
    });
    await page.goto("/");

    await expect(page.locator(".chat")).toHaveClass(/\brunning\b/, { timeout: 20_000 });
    await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });

    expect(await animationName(page, ".msg")).toBe("none");
    expect(await animationName(page, ".chat.running .chat-title .dot")).toBe("none");
    expect(await animationName(page, ".chat.running .composer", "::before")).toBe("none");

    // The status text is still conveyed without relying on animation.
    await expect(page.locator(".chat-sub")).toHaveText("智能体工作中…");
  });
});
