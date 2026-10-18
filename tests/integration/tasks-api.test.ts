import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
let h: TestHarness;
beforeAll(async () => { h = await startHarness(); Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }) }); });
afterAll(async () => { await h?.shutdown(); });
it("protects the main inbox and task writes with authentication and CSRF", async () => {
    expect((await h.request("/api/main")).status).toBe(401);
    const { cookie } = await login(h);
    expect((await h.request("/api/tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "hello", clientMessageId: "security" }) })).status).toBe(403);
    const main = await h.request("/api/main", { headers: { cookie } });
    expect(main.status).toBe(200);
    expect(((await main.json()) as {
        mode: string;
    }).mode).toBe("tasks");
});
it("answers a poll for the feed version it already holds in a few bytes", async () => {
    const { cookie, csrf } = await login(h);
    const first = (await (await h.request("/api/main", { headers: { cookie } })).json()) as { version: string; tasks: unknown[] };
    expect(first.version).toMatch(/^[\w-]{22}$/);
    const same = await h.request(`/api/main?v=${first.version}`, { headers: { cookie } });
    expect(same.headers.get("cache-control")).toBe("no-store");
    const text = await same.text();
    expect(JSON.parse(text)).toEqual({ mode: "tasks", unchanged: true, version: first.version });
    expect(text.length).toBeLessThan(100);
    // Any change is a new version, and the whole page again.
    await h.request("/api/tasks", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "版本变了", clientMessageId: "feed-version" }) });
    const changed = (await (await h.request(`/api/main?v=${first.version}`, { headers: { cookie } })).json()) as { version: string; unchanged?: boolean; tasks: Array<{ text: string }> };
    expect(changed.unchanged).toBeUndefined();
    expect(changed.version).not.toBe(first.version);
    expect(changed.tasks.some((t) => t.text === "版本变了")).toBe(true);
});
it("accepts parallel tasks, deduplicates message retries and keeps child threads out of history", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const body = JSON.stringify({ text: "first", clientMessageId: "api-first" });
    const first = await h.request("/api/tasks", { method: "POST", headers, body });
    expect(first.status).toBe(202);
    const task = ((await first.json()) as {
        task: {
            id: string;
            conversationId: string;
        };
    }).task;
    expect((await h.request(`/api/conversations/${task.conversationId}/turns`, { method: "POST", headers, body: JSON.stringify({ text: "bypass", clientMessageId: "bypass" }) })).status).toBe(409);
    expect((await h.request(`/api/conversations/${task.conversationId}`, { method: "PATCH", headers, body: JSON.stringify({ archived: true }) })).status).toBe(409);
    expect((await h.request("/api/tasks", { method: "POST", headers, body })).status).toBe(200);
    const conflicting = await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "other", clientMessageId: "api-first" }) });
    expect(conflicting.status).toBe(409);
    expect((await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "second", clientMessageId: "api-second" }) })).status).toBe(202);
    const history = await h.request("/api/conversations?archived=1", { headers: { cookie } });
    expect(((await history.json()) as {
        conversations: {
            id: string;
        }[];
    }).conversations.some((c: {
        id: string;
    }) => c.id === task.conversationId)).toBe(false);
    expect((await h.request(`/api/tasks/${task.id}/stop`, { method: "POST", headers, body: "{}" })).status).toBe(200);
});
it("rejects invalid references and out-of-workspace attachments before creating work", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    for (const extra of [{ relatedTaskId: "missing" }, { attachments: [{ path: "/etc/passwd", kind: "file" }] }]) {
        const res = await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "a", clientMessageId: JSON.stringify(extra), ...extra }) });
        expect(res.status).toBe(400);
    }
});
it("keeps the console language per account: messages and one opening follow the console until a choice in settings", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const put = (body: object) => h.request("/api/account/locale", { method: "PUT", headers, body: JSON.stringify(body) });
    expect(h.ctx.tasks.locale()).toBe("en");
    await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "你好", clientMessageId: "locale-zh", locale: "zh-CN" }) });
    expect(h.ctx.tasks.locale()).toBe("zh-CN");
    // A console opening in its system language is taken once per account.
    expect(await (await put({ locale: "es", sync: true })).json()).toEqual({ ok: true, applied: true });
    expect(h.ctx.tasks.locale()).toBe("es");
    expect(await (await put({ locale: "zh-TW", sync: true })).json()).toEqual({ ok: true, applied: false });
    expect(h.ctx.tasks.locale()).toBe("es");
    expect((await put({ locale: "fr" })).status).toBe(400);
    expect((await put({ locale: "fr", sync: true })).status).toBe(400);
    // A choice in settings always applies, and nothing automatic overrides it afterwards.
    expect((await put({ locale: "zh-TW" })).status).toBe(200);
    expect(h.ctx.tasks.locale()).toBe("zh-TW");
    await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "hello again", clientMessageId: "locale-en-2", locale: "en" }) });
    expect(h.ctx.tasks.locale()).toBe("zh-TW");
    expect((await put({ locale: "en" })).status).toBe(200);
    expect(h.ctx.tasks.locale()).toBe("en");
});
it("lists the main session's replies that name workspace files for the files page, newest first, the account's own only", async () => {
    expect((await h.request("/api/main/files")).status).toBe(401);
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const ws = h.ctx.cfg.sandbox.containerWorkspaceDir;
    const post = async (text: string, extra: object = {}) => ((await (await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text, clientMessageId: `files-${text}`, ...extra }) })).json()) as { task: { id: string } }).task.id;
    const sent = await post("看看这张图", { attachments: [{ path: `${ws}/uploads/photo.png`, kind: "image", name: "photo.png" }] });
    const report = await post("写个报告");
    const chart = await post("画个图");
    const web = await post("找个网页");
    const running = await post("还在做");
    const finish = (id: string, status: string, result: string, at: number) => h.ctx.db.prepare("UPDATE tasks SET status=?, result=?, created_at=?, completed_at=? WHERE id=?").run(status, result, at, at + 1, id);
    finish(sent, "completed", "图里是一只猫。", 1_000);
    finish(report, "completed", `做好了：[报告](${ws}/tasks/r/report.docx)`, 2_000);
    finish(chart, "completed", `![趋势](${ws}/tasks/c/chart.png)`, 2_500);
    finish(web, "completed", "看这里 https://example.com/page", 3_000);
    finish(running, "running", `草稿 ${ws}/tasks/x/draft.md`, 4_000);
    const res = await h.request("/api/main/files", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { messages: Array<{ taskId: string; title: string; result: string; createdAt: number }>; nextBefore: number | null };
    const mine = body.messages.filter((m) => [sent, report, chart, web, running].includes(m.taskId));
    // Only replies count: not what was attached, not web links, and not a reply still being written.
    expect(mine.map((m) => m.taskId)).toEqual([chart, report]);
    expect(mine[1]!.result).toContain("report.docx");
    expect(Object.keys(mine[0]!).sort()).toEqual(["completedAt", "createdAt", "result", "taskId", "title"]);
    expect(body.nextBefore).toBeNull();
    const older = (await (await h.request("/api/main/files?before=2500", { headers: { cookie } })).json()) as { messages: Array<{ taskId: string }> };
    expect(older.messages.map((m) => m.taskId)).toContain(report);
    expect(older.messages.map((m) => m.taskId)).not.toContain(chart);
});
