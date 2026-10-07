import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

const table = [
  "| 杯子 | 当前价 / 折扣 | 容量 | 整杯机洗 | 杯盖与使用特点 |",
  "|---|---|---|---|---|",
  "| [Stanley Quick Flip GO 黑色](https://www.amazon.com/dp/B0) | $19 / 减 24% | 710 ml | 可以，所有部件可机洗 | 按钮弹开翻盖，喝完手动合上；偏户外水瓶风格 |",
  "| [Thermos Stainless King 军绿](https://www.amazon.com/dp/B1) | $22.49 / 减 25% | 473 ml | 可以，建议上层 | 关闭后防漏；有茶包挂钩，复古金属风格 |",
  "| [Contigo West Loop 哑光](https://www.amazon.com/dp/B2) | $24.49 / 减 18% | 710 ml | 不可以：杯身手洗、杯盖可机洗 | 按住喝、松手自动密封；单手操作 |",
].join("\n");

test("a wide table keeps readable columns and scrolls sideways, in the feed and in the full message", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  const result = `按你目前的偏好，我会优先选 Stanley 黑色。\n\n${table}\n\n${"补充说明。".repeat(600)}`;
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v1", tasks: [{ id: "cups", revision: 1, title: "对比杯款", text: "对比一下", conversationId: "c", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: 2000 }], nextBefore: null } }));
  await page.goto("/");
  const check = async (scope: import("@playwright/test").Locator, shot: string) => {
    const t = scope.locator(".markdown table").first();
    await expect(t).toBeVisible({ timeout: 60_000 });
    // "710 ml" stays on one line: the cell is not squeezed to a character per line.
    const cell = t.locator("td", { hasText: "710 ml" }).first();
    const line = await cell.evaluate((n) => parseFloat(getComputedStyle(n).lineHeight) || 24);
    expect((await cell.evaluate((n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().height; }))).toBeLessThan(line * 1.6);
    const { scroll, client } = await t.evaluate((n) => ({ scroll: n.scrollWidth, client: n.clientWidth }));
    if (info.project.name !== "desktop") expect(scroll).toBeGreaterThan(client);
    await t.evaluate((n) => { n.scrollLeft = n.scrollWidth; });
    expect(await t.evaluate((n) => n.scrollLeft)).toBeGreaterThanOrEqual(info.project.name === "desktop" ? 0 : 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(shot) });
    await t.evaluate((n) => { n.scrollLeft = 0; });
  };
  await check(page.locator(".task-report"), "table-feed.png");
  await page.getByRole("button", { name: "点击看更多：对比杯款" }).click();
  await check(page.getByRole("dialog", { name: "完整消息：对比杯款" }), "table-full.png");
});
