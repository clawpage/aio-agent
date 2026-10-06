import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MEMBER_MODEL } from "../../src/control/auth/policy.js";

let h: TestHarness, dir: string, userId: string;
const resolved: string[] = [];
const TOKEN = "gadget-member-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const send = (text: string, id: string) => h.request("/api/gadget/messages", { method: "POST", headers: auth, body: JSON.stringify({ text, clientMessageId: id }) });

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-gadget-member-"));
    const secret = path.join(dir, "model.env");
    fs.writeFileSync(secret, "AIO_MEMBER_MODEL_TOKEN=test-member-token\n", { mode: 0o600 });
    // As on the member's runtime: its model through the gateway provider, at the effort the administrator assigned.
    h = await startHarness({}, { configure: cfg => { cfg.bridge = { ...cfg.bridge, enabled: "on", models: [MEMBER_MODEL], baseUrl: "http://host.docker.internal:4902/u/user_m/v1", secretsFile: secret }; cfg.memberEffort = "low"; } });
    userId = (await createMember(h.ctx.db, "betaw", "member-password-123")).id;
    h.ctx.runtimeForUser = async id => { resolved.push(id); return h.ctx; };
});
afterAll(async () => { await h?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

it("speaks for the account the token file names, in that account's runtime, at its model and effort", async () => {
    fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\nAIO_GADGET_USER=betaw\n`, { mode: 0o600 });
    const first = await send("记一下：明天上午十点带 Roy 打疫苗", "b1");
    expect(first.status).toBe(202);
    const task = (await first.json()) as { id: string };
    expect(resolved).toContain(userId);
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(1));
    const turn = h.codex.startedTurns[0]!;
    expect(turn).toMatchObject({ model: MEMBER_MODEL, effort: "low" });
    expect(h.codex.threadProviders.get(turn.threadId)).toBe("aio_gateway");
    expect(h.ctx.tasks.ownerId(h.ctx.tasks.get(task.id)!)).toBe(userId);
    await h.codex.runTurn(turn.turnId, { text: "好的，记下了。" });
    await vi.waitFor(async () => expect(await (await h.request(`/api/gadget/messages/${task.id}`, { headers: auth })).json()).toMatchObject({ done: true, reply: "好的，记下了。" }));

    // Every message continues the same session.
    expect((await send("刚才说的是几点", "b2")).status).toBe(202);
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(2));
    expect(h.codex.startedTurns[1]!.threadId).toBe(turn.threadId);

    // None of it is the owner's.
    const { cookie } = await login(h);
    const main = (await (await h.request("/api/main", { headers: { cookie } })).json()) as { tasks: Array<{ id: string }> };
    expect(main.tasks.some(t => t.id === task.id)).toBe(false);
});

it("refuses a token file that names no account", async () => {
    fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\nAIO_GADGET_USER=nobody\n`, { mode: 0o600 });
    expect((await send("你好", "n1")).status).toBe(401);
});

it("carries an assigned effort into the member's runtime, and only one a member may have", async () => {
    const { memberConfig } = await import("../../src/control/tenants.js");
    expect(memberConfig(h.ctx.cfg, "user_e", 18099, MEMBER_MODEL, "low").memberEffort).toBe("low");
    expect(memberConfig(h.ctx.cfg, "user_e", 18099, MEMBER_MODEL).memberEffort).toBeUndefined();
    expect(() => memberConfig(h.ctx.cfg, "user_e", 18099, MEMBER_MODEL, "xhigh")).toThrow("Unsupported member effort");
});

it("shows the owner, and only the owner, the gadget account's conversation", async () => {
    fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\nAIO_GADGET_USER=betaw\n`, { mode: 0o600 });
    const { cookie } = await login(h);
    type History = { account: string | null; messages: Array<{ id: string; text: string; reply: string | null; done: boolean }>; more: boolean };
    const read = async (query = "") => (await (await h.request(`/api/gadget/history${query}`, { headers: { cookie } })).json()) as History;
    const all = await read();
    expect(all.account).toBe("betaw");
    // Newest first: the follow-up, then the answered first message.
    expect(all.messages.map(m => m.text)).toEqual(["刚才说的是几点", "记一下：明天上午十点带 Roy 打疫苗"]);
    expect(all.messages[1]).toMatchObject({ done: true, reply: "好的，记下了。" });
    expect(all.more).toBe(false);
    const page = await read("?limit=1");
    expect(page).toMatchObject({ more: true, messages: [{ text: "刚才说的是几点" }] });
    const older = await read(`?limit=1&before=${(page.messages[0] as unknown as { createdAt: number }).createdAt}`);
    expect(older.messages.map(m => m.text)).toEqual(["记一下：明天上午十点带 Roy 打疫苗"]);
    expect((await read("?limit=0")).messages).toEqual([]);

    // A member gets nothing; without a session, neither does anyone else.
    const m = h.ctx.sessions.create(userId, "primary");
    expect((await h.request("/api/gadget/history", { headers: { cookie: `pa_session=${m.token}; pa_csrf=${m.csrfToken}` } })).status).toBe(403);
    expect((await h.request("/api/gadget/history")).status).toBe(401);
    // A gadget speaking for the owner has no separate account to show.
    fs.writeFileSync(h.ctx.cfg.gadgetTokenPath, `AIO_GADGET_TOKEN=${TOKEN}\n`, { mode: 0o600 });
    expect(await read()).toEqual({ account: null, messages: [], more: false });
});
