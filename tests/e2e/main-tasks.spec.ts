import { test, expect, type Page } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";
import type { Task } from "../../src/web/src/types";
function task(n: number, status = "running"): Task {
    return { id: `task-${n}`, revision: 1, title: `任务 ${n}`, text: `请求 ${n}`, conversationId: `child-${n}`, status, result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + n, completedAt: null };
}
async function setup(page: Page, rows: Task[] = []) {
    const conversations = [makeConversation("old", "保留的旧会话"), ...rows.map(t => makeConversation(t.conversationId, t.title))];
    await mockConsole(page, { conversations });
    const bodies: Array<Record<string, any>> = [];
    const stops: string[] = [];
    await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: rows, nextBefore: null } }));
    await page.route("**/api/tasks", async (r) => {
        const body = r.request().postDataJSON();
        bodies.push(body);
        const t = { ...task(rows.length + 1), text: body.text, attachments: body.attachments, relatedTaskId: body.relatedTaskId };
        rows.push(t);
        conversations.push(makeConversation(t.conversationId, t.title));
        await r.fulfill({ status: 202, json: { task: t, duplicate: false } });
    });
    await page.route("**/api/tasks/*/stop", async (r) => {
        const id = new URL(r.request().url()).pathname.split("/")[3]!;
        stops.push(id);
        const t = rows.find(t => t.id === id)!;
        Object.assign(t, { status: "interrupted", completedAt: Date.now(), revision: t.revision + 1 });
        await r.fulfill({ json: { ok: true } });
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
    return { rows, bodies, stops };
}
const send = async (page: Page, text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送", exact: true }).click(); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(""); };
test("one inbox accepts parallel messages, folds progress, reports completion order and survives reload", async ({ page }, info) => {
    const { rows, bodies } = await setup(page);
    await expect(page.getByRole("button", { name: /新建会话/ })).toHaveCount(0);
    await send(page, "写报告");
    await send(page, "另外计算数字");
    await send(page, "再做图片");
    expect(bodies).toHaveLength(3);
    await expect(page.locator(".task-progress")).toHaveCount(3);
    await expect(page.locator(".task-report")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeEnabled();
    Object.assign(rows[1]!, { status: "completed", result: "数字结果 B", completedAt: 2000, revision: 2 });
    Object.assign(rows[0]!, { status: "completed", result: "报告结果 A", completedAt: 3000, revision: 2 });
    await expect(page.locator(".task-report .bubble")).toHaveText(["数字结果 B", "报告结果 A"]);
    await page.reload();
    await expect(page.locator(".task-report")).toHaveCount(2);
    await expect(page.locator(".task-progress")).toHaveCount(1);
    const heading = await page.locator(".task-report-heading").first().boundingBox();
    const bubble = await page.locator(".task-report .bubble").first().boundingBox();
    expect(bubble!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
    const short = await page.locator(".task-entry .msg.user p").first().boundingBox();
    expect(short!.height).toBeLessThan(40);
    await page.screenshot({ path: `/Users/mengxiao/workspace/.scratch/artifacts/aio-main-tasks/${info.project.name}-main.png`, animations: "disabled" });
});
test("per-task stop and explicit related followup never stop other tasks", async ({ page }) => {
    const { rows, bodies, stops } = await setup(page, [task(1), task(2)]);
    await page.locator('.task-entry[data-task-id="task-1"]').getByRole("button", { name: "停止该任务" }).click();
    await expect(page.locator(".task-progress")).toHaveCount(1);
    expect(stops).toEqual(["task-1"]);
    expect(rows[1]!.status).toBe("running");
    await page.locator('.task-entry[data-task-id="task-2"]').getByRole("button", { name: "关联新任务" }).click();
    await expect(page.locator(".composer .chip")).toContainText("任务 2");
    await send(page, "接着做第二部分");
    expect(bodies[0]?.relatedTaskId).toBe("task-2");
});
test("attachments use native picker, config retains drafts, old history is read-only", async ({ page }, info) => {
    await setup(page);
    await page.route("**/api/sandbox/upload", r => r.fulfill({ json: { path: "/home/gem/workspace/uploads/a.txt", name: "a.txt", kind: "file" } }));
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".file-button").click();
    await (await chooser).setFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.locator(".composer .chips")).toContainText("a.txt");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留草稿");
    const nav = page.locator(info.project.name.startsWith("mobile") ? ".bottom-nav" : ".sidebar");
    await nav.getByRole("button", { name: "配置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "配置", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "← 返回会话" }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留草稿");
    await expect(page.locator(".composer .chips")).toContainText("a.txt");
    await nav.getByRole("button", { name: info.project.name.startsWith("mobile") ? "历史" : "历史记录", exact: true }).click();
    await page.getByRole("button", { name: /保留的旧会话/ }).click();
    await expect(page.locator(".task-detail")).toBeVisible();
    await expect(page.locator(".task-detail .composer")).toHaveCount(0);
    await page.getByRole("button", { name: "← 返回主会话" }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留草稿");
});
test("failed submit preserves payload and idempotency key, details stay folded and fit mobile", async ({ page }, info) => {
    const pending = task(1);
    pending.approvals = 1;
    await setup(page, [pending]);
    await expect(page.locator(".task-summary")).toContainText("需要你确认");
    const keys: string[] = [];
    let fail = true;
    await page.route("**/api/tasks", async (r) => { keys.push(r.request().postDataJSON().clientMessageId); if (fail) {
        fail = false;
        await r.fulfill({ status: 503, json: { message: "暂时失败" } });
    }
    else
        await r.fallback(); });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("重试消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("内容已保留");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("重试消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".task-entry")).toHaveCount(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    for (const width of info.project.name.startsWith("mobile") ? [390, 360] : [1440]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
        const box = await page.locator(".composer").boundingBox();
        expect(box!.height).toBeLessThan(220);
        expect(box!.y + box!.height).toBeLessThanOrEqual(844);
        expect(await page.locator(".task-progress.active .task-progress-label").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    }
    await page.getByRole("button", { name: "展开任务：任务 1" }).click();
    await expect(page.locator(".task-detail")).toBeVisible();
    const box = await page.locator(".task-detail .chat-scroll").boundingBox();
    expect(box!.height).toBeGreaterThan(400);
});
