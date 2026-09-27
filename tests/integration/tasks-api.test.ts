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
