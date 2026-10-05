import fs from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";

let h: TestHarness;
let planned = 0;
const TOKEN = "gadget-test-token-0123456789";
const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const send = (text: string, id: string, token?: string) =>
    h.request("/api/gadget/messages", { method: "POST", headers: auth(token), body: JSON.stringify({ text, clientMessageId: id }) });
const poll = async (id: string) => (await (await h.request(`/api/gadget/messages/${id}`, { headers: auth() })).json()) as { done: boolean; reply: string | null; status: string };

beforeAll(async () => {
    h = await startHarness();
    Object.assign(h.codex, { planTask: async () => { planned++; return JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }); } });
});
afterAll(async () => { await h?.shutdown(); });

it("refuses the gadget without the owner's token file, a token or the right token", async () => {
    expect((await send("你好", "no-file")).status).toBe(401);
    fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\n`, { mode: 0o600 });
    expect((await send("你好", "wrong", "not-the-token")).status).toBe(401);
    expect((await h.request("/api/gadget/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    // A browser login is not a gadget token.
    const { cookie, csrf } = await login(h);
    expect((await h.request("/api/gadget/messages", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "x", clientMessageId: "cookie" }) })).status).toBe(401);
});

it("runs gadget messages in one executor session at medium effort, briefly, with the other tasks as background", async () => {
    const { cookie, csrf } = await login(h);
    const other = await h.request("/api/tasks", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "比较三款婴儿推车", clientMessageId: "other-task" }) });
    expect(other.status).toBe(202);
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(1));
    await h.codex.runTurn(h.codex.startedTurns[0]!.turnId, { text: "推荐 A 款" });
    const before = planned;

    const first = await send("推车比较的结果是什么", "g1");
    expect(first.status).toBe(202);
    const task = (await first.json()) as { id: string; done: boolean };
    expect(task.done).toBe(false);
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(2));
    const turn = h.codex.startedTurns[1]!;
    expect(turn.effort).toBe("medium");
    expect(turn.text).toContain("语音配件");
    expect(turn.text).toContain("纯文本口语");
    expect(turn.text).toContain("比较三款婴儿推车");
    expect(turn.text).not.toContain("```products");
    expect(planned).toBe(before);   // no dispatcher

    await h.codex.runTurn(turn.turnId, { text: "推荐 A 款推车。" });
    await vi.waitFor(async () => expect(await poll(task.id)).toMatchObject({ done: true, status: "completed", reply: "推荐 A 款推车。" }));
    // A retry of the same message is the same task.
    expect(((await (await send("推车比较的结果是什么", "g1")).json()) as { id: string }).id).toBe(task.id);

    expect((await send("那第二款呢", "g2")).status).toBe(202);
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(3));
    expect(h.codex.startedTurns[2]!.threadId).toBe(turn.threadId);

    const main = (await (await h.request("/api/main", { headers: { cookie } })).json()) as { tasks: Array<{ id: string; text: string }> };
    expect(main.tasks.some(t => t.id === task.id && t.text === "推车比较的结果是什么")).toBe(true);
    // The gadget reads only its own messages.
    const otherId = ((await other.json()) as { task: { id: string } }).task.id;
    expect((await h.request(`/api/gadget/messages/${otherId}`, { headers: auth() })).status).toBe(404);
});
