import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import type { Task } from "../../src/ui/src/types";

const OPTIONS = ["Similac（雅培）", "Enfamil（美赞臣）", "两个牌子都比一下"];

function base(id: string, extra: Partial<Task>): Task {
  return { id, revision: 1, title: "水奶比价", text: "比价amazon和target水奶价格", conversationId: `child-${id}`, status: "running", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: null, ...extra };
}

async function setup(page: Page, rows: Task[]) {
  await mockConsole(page, { conversations: [] });
  const bodies: Array<Record<string, any>> = [];
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: rows, nextBefore: null } }));
  await page.route("**/api/tasks", async (r) => {
    const body = r.request().postDataJSON();
    bodies.push(body);
    const reply = base(`reply-${bodies.length}`, { title: body.text, text: body.text, relatedTaskId: body.relatedTaskId, status: "planning", createdAt: Date.now() });
    rows.push(reply);
    await r.fulfill({ status: 202, json: { task: reply, duplicate: false } });
  });
  await page.goto("/");
  return { bodies };
}

test("a question with answers: tap one and it goes back to that task, the draft untouched", async ({ page }, info) => {
  const { bodies } = await setup(page, [base("ask", { status: "needs_input", clarification: "你平时给宝宝喝哪个牌子的水奶？", options: OPTIONS })]);
  const question = page.locator(".task-question");
  await expect(question).toContainText("你平时给宝宝喝哪个牌子的水奶？", { timeout: 60_000 });
  const choices = question.getByRole("group", { name: "可选回答" }).getByRole("button");
  await expect(choices).toHaveText(OPTIONS);
  await expect(question).toContainText("点选一个，或直接在下方输入");
  await page.screenshot({ path: info.outputPath("choices-question.png") });

  await page.getByRole("textbox", { name: "消息" }).fill("还没写完的另一件事");
  await choices.nth(1).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ text: "Enfamil（美赞臣）", relatedTaskId: "ask", attachments: [] });
  expect(bodies[0]!.clientMessageId).toBe("choice:ask:1:Enfamil（美赞臣）");
  // The tap shows as chosen at once and the others close; the draft stays.
  await expect(choices.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(choices.nth(0)).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("还没写完的另一件事");
  await expect(page.locator(".msg.user").filter({ hasText: "Enfamil（美赞臣）" })).toBeVisible();
});

test("a finished reply that ends with answers: tap one, and once answered they close with the pick checked", async ({ page }) => {
  const result = "两家都有 Enfamil 水奶。你要哪种规格？\n\n```choices\n[\"32 盎司 6 瓶装\", \"2 盎司 48 瓶装\", \"两种都算一下单价\"]\n```";
  const rows = [base("done", { status: "completed", result, completedAt: 2000 })];
  const { bodies } = await setup(page, rows);
  const report = page.locator(".task-report").filter({ hasText: "你要哪种规格？" });
  const choices = report.getByRole("group", { name: "可选回答" }).getByRole("button");
  await expect(choices).toHaveCount(3, { timeout: 60_000 });
  await expect(report).not.toContainText("```");
  await choices.nth(2).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ text: "两种都算一下单价", relatedTaskId: "done" });
  await expect(choices.nth(2)).toHaveAttribute("aria-pressed", "true");
  // After a reload the reply is what closes them.
  await page.reload();
  const again = page.locator(".task-report").filter({ hasText: "你要哪种规格？" }).getByRole("group", { name: "可选回答" }).getByRole("button");
  await expect(again.nth(2)).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await expect(again.nth(0)).toBeDisabled();
});

test("an answer picked in the full message closes it and is sent", async ({ page }) => {
  const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段比价说明。`).join("\n\n");
  const result = `${long}\n\n你要哪种规格？\n\n\`\`\`choices\n["32 盎司 6 瓶装", "2 盎司 48 瓶装"]\n\`\`\``;
  const { bodies } = await setup(page, [base("long", { status: "completed", result, completedAt: 2000 })]);
  const report = page.locator(".task-report").filter({ hasText: "第 1 段比价说明" });
  await report.getByRole("button", { name: /^点击看更多/ }).click();
  const dialog = page.getByRole("dialog", { name: /^完整消息/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("group", { name: "可选回答" }).getByRole("button", { name: "2 盎司 48 瓶装" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ text: "2 盎司 48 瓶装", relatedTaskId: "long" });
  await expect(report.getByRole("group", { name: "可选回答" }).getByRole("button", { name: "2 盎司 48 瓶装" })).toHaveAttribute("aria-pressed", "true");
});

test("an executor's ask_user block reads as its question, not as raw JSON", async ({ page }) => {
  const result = '先别急着责怪自己。今天先做三件小事。\n\n```ask_user\n{"question":"这份低落持续多久了？","options":["一两天","两周以上"]}\n```';
  await setup(page, [base("asked", { status: "completed", result, completedAt: 2000 })]);
  const report = page.locator(".task-report").filter({ hasText: "先别急着责怪自己" });
  const ask = report.getByRole("note", { name: "向你提问" });
  await expect(ask).toContainText("这份低落持续多久了？", { timeout: 60_000 });
  await expect(ask.getByRole("button", { name: "两周以上" })).toBeDisabled();
  await expect(report).not.toContainText('"question"');
  await expect(report).not.toContainText("ask_user");
});

const FORM = { title: "订位信息", fields: [
  { name: "date", label: "日期", type: "date", required: true },
  { name: "people", label: "人数", type: "number", min: 1, default: 2 },
  { name: "area", label: "区域", type: "select", options: ["圣何塞", "旧金山"] },
  { name: "taste", label: "口味", type: "checkbox", options: ["川菜", "粤菜", "湘菜"] },
  { name: "note", label: "备注", type: "textarea", placeholder: "忌口等" },
], submit: "去订" };

test("a form in a reply: fill it in, required fields first, and it goes back to that task as one reply", async ({ page }, info) => {
  const result = `找到三家可订的餐厅。\n\n\`\`\`form\n${JSON.stringify(FORM)}\n\`\`\``;
  const { bodies } = await setup(page, [base("found", { status: "completed", result, completedAt: 2000 })]);
  const form = page.locator(".task-report").getByRole("form", { name: "订位信息" });
  await expect(form).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".task-report")).not.toContainText("```");
  // Nothing is sent while a required field is empty.
  await form.getByRole("button", { name: "去订" }).click();
  await expect(form.getByRole("alert")).toContainText("还需要填写：日期");
  expect(bodies).toEqual([]);
  await form.getByLabel("日期").fill("2026-10-11");
  await form.getByLabel("人数").fill("4");
  await form.getByLabel("区域").selectOption("旧金山");
  await form.getByRole("checkbox", { name: "川菜" }).click();
  await form.getByRole("checkbox", { name: "湘菜" }).click();
  await form.getByLabel("备注").fill("不吃香菜");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("form-filled.png") });
  await form.getByRole("button", { name: "去订" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ relatedTaskId: "found", text: "日期：2026-10-11\n人数：4\n区域：旧金山\n口味：川菜、湘菜\n备注：不吃香菜" });
  // Sent: the form closes and shows what went.
  const sent = page.locator(".task-report").getByRole("group", { name: "订位信息（已提交）" });
  await expect(sent).toContainText("旧金山");
  await expect(sent).toContainText("已提交");
});

test("a waiting task that asks with fields shows a form on its card", async ({ page }, info) => {
  const { bodies } = await setup(page, [base("waits", { status: "needs_input", result: "找到三家。", clarification: "请补充订位信息", form: { title: null, fields: [{ name: "date", label: "日期", type: "date", required: true }, { name: "people", label: "人数", type: "number", required: false }], submit: "提交" } })]);
  const question = page.locator(".task-question");
  await expect(question).toContainText("请补充订位信息", { timeout: 60_000 });
  await expect(question).toContainText("填好后提交");
  await question.getByLabel("日期").fill("2026-10-11");
  await page.screenshot({ path: info.outputPath("form-waiting.png") });
  await question.getByRole("button", { name: "提交" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ relatedTaskId: "waits", text: "日期：2026-10-11" });
  await expect(question.getByRole("group", { name: /已提交/ })).toContainText("2026-10-11");
});
