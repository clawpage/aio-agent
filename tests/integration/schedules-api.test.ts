import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.shutdown(); });

const insert = (id: string, owner: string) => h.ctx.db.prepare("INSERT INTO schedules (id,owner_id,title,instruction,spec_json,timezone,status,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)")
  .run(id, owner, `标题-${id}`, "查天气", JSON.stringify({ kind: "daily", at: "08:00" }), "America/Los_Angeles", Date.now() + 3600_000, Date.now(), Date.now());

describe("schedules API", () => {
  it("lists only the signed-in account's schedules and changes only those", async () => {
    insert("sched-own", "owner_1");
    insert("sched-other", "someone_else");
    expect((await h.request("/api/schedules")).status).toBe(401);
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const list = (await (await h.request("/api/schedules", { headers: { cookie } })).json()) as { schedules: Array<{ id: string; rule: string; nextRunText: string }> };
    expect(list.schedules.map((s) => s.id)).toEqual(["sched-own"]);
    expect(list.schedules[0]).toMatchObject({ rule: "每天 08:00", nextRunText: expect.stringMatching(/^\d+月\d+日 周. \d{2}:\d{2}$/) });
    expect((await h.request("/api/schedules/sched-own/pause", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await h.request("/api/schedules/sched-own/pause", { method: "POST", headers: { cookie }, body: "{}" })).status).toBe(403);
    const paused = await h.request("/api/schedules/sched-own/pause", { method: "POST", headers, body: "{}" });
    expect(await paused.json()).toMatchObject({ schedule: { status: "paused" } });
    expect((await h.request("/api/schedules/sched-other/pause", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await h.request("/api/schedules/sched-own/explode", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await h.request("/api/schedules/sched-own/cancel", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(h.ctx.db.prepare("SELECT id FROM schedules ORDER BY id").all()).toEqual([{ id: "sched-other" }]);
  });
});
