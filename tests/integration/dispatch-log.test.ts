import { expect, it } from "vitest";
import { startHarness, login } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";

it("serves a message's dispatch log to the owner only", async () => {
  const h = await startHarness();
  try {
    Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "查天气", related: [], dependencies: [], resources: [] }) });
    const auth = await login(h);
    const owner = { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" };
    const created = await h.request("/api/tasks", { method: "POST", headers: owner, body: JSON.stringify({ text: "明天天气怎么样", clientMessageId: "debug-1" }) });
    const { task } = (await created.json()) as { task: { id: string } };
    await expect.poll(async () => {
      const r = await h.request(`/api/settings/dispatch-log/${task.id}`, { headers: owner });
      return ((await r.json()) as { entries: unknown[] }).entries.length;
    }).toBe(1);
    const log = (await (await h.request(`/api/settings/dispatch-log/${task.id}`, { headers: owner })).json()) as any;
    expect(log.task).toMatchObject({ id: task.id, text: "明天天气怎么样" });
    expect(log.entries[0].steps.map((s: { kind: string }) => s.kind)).toEqual(["context", "ask", "plan"]);
    expect((await h.request("/api/settings/dispatch-log/task_missing", { headers: owner })).status).toBe(404);

    await createMember(h.ctx.db, "cr", "member-password-123");
    const res = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cr", password: "member-password-123" }) });
    const cookies = res.headers.getSetCookie().map((s) => s.split(";")[0]!);
    const member = { cookie: cookies.join("; "), "x-csrf-token": decodeURIComponent(cookies.find((s) => s.startsWith("pa_csrf="))!.slice(8)) };
    expect((await h.request(`/api/settings/dispatch-log/${task.id}`, { headers: member })).status).toBe(403);
  } finally {
    await h.shutdown();
  }
});
