import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

const KEY = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz";

function task(result: string) {
  return { id: "task-1", revision: 1, title: "创建 API 密钥", text: "send me the key", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

test("a code block in a reply has a copy button that copies all of it, even the part scrolled out of view", async ({ page }, info) => {
  // What the page writes to the clipboard (WebKit cannot grant reading it back).
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  });
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(`Your key:\n\n\`\`\`\n${KEY}\n\`\`\`\n\nInline \`code\` has no button.`)], nextBefore: null } }));
  await page.goto("/");
  await page.locator(".bubble").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });

  const block = page.locator(".markdown .code-block");
  await expect(block).toHaveCount(1);
  const button = block.getByRole("button", { name: "复制" });
  await expect(button).toBeVisible();
  // The button stays in the corner when the code scrolls sideways.
  await block.locator("pre").evaluate((pre) => { pre.scrollLeft = pre.scrollWidth; });
  await expect(button).toBeInViewport();
  await page.screenshot({ path: `/Users/mengxiao/workspace/.scratch/artifacts/code-copy/${info.project.name}.png` });
  await button.click();
  await expect(block.locator(".code-copy")).toHaveText("已复制");
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(KEY);
  await expect(block.locator(".code-copy svg")).toHaveCount(1, { timeout: 3_000 });
});
