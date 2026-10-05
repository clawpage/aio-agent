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
    const all = (await (await h.request("/api/schedules", { headers: { cookie } })).json()) as { schedules: Array<{ id: string; rule: string; nextRunText: string; builtin: string | null }> };
    // Every account also has the built-in daily feed.
    expect(all.schedules.filter((s) => s.builtin)).toMatchObject([{ builtin: "daily_feed", rule: "每天 08:00" }]);
    const list = { schedules: all.schedules.filter((s) => !s.builtin) };
    expect(list.schedules.map((s) => s.id)).toEqual(["sched-own"]);
    expect(list.schedules[0]).toMatchObject({ rule: "每天 08:00", nextRunText: expect.stringMatching(/^\d+月\d+日 周. \d{2}:\d{2}$/) });
    expect((await h.request("/api/schedules/sched-own/pause", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await h.request("/api/schedules/sched-own/pause", { method: "POST", headers: { cookie }, body: "{}" })).status).toBe(403);
    const paused = await h.request("/api/schedules/sched-own/pause", { method: "POST", headers, body: "{}" });
    expect(await paused.json()).toMatchObject({ schedule: { status: "paused" } });
    expect((await h.request("/api/schedules/sched-other/pause", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await h.request("/api/schedules/sched-own/explode", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await h.request("/api/schedules/sched-own/cancel", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(h.ctx.db.prepare("SELECT id FROM schedules WHERE builtin IS NULL ORDER BY id").all()).toEqual([{ id: "sched-other" }]);
  });

  it("edits one of the account's schedules: name, what it does, its rule; never another's or the built-in feed", async () => {
    insert("sched-edit", "owner_1");
    const { cookie, csrf } = await login(h);
    const patch = (id: string, body: unknown, headers: Record<string, string> = { "x-csrf-token": csrf }) => h.request(`/api/schedules/${id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await h.request("/api/schedules/sched-edit", { method: "PATCH", body: "{}" })).status).toBe(401);
    expect((await patch("sched-edit", { title: "x" }, {})).status).toBe(403);
    const dates = [5, 12].map((n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10));
    const edited = await patch("sched-edit", { title: "交材料", instruction: "提醒交材料", schedule: { kind: "dates", dates: [`${dates[0]} 09:00`, `${dates[1]} 14:30`] }, needsBrowser: false });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ message: expect.stringContaining("已更新定时任务「交材料」"), schedule: { id: "sched-edit", title: "交材料", instruction: "提醒交材料", needsBrowser: false, spec: { kind: "dates" }, rule: expect.stringContaining("（共 2 次）") } });
    const bad = await patch("sched-edit", { schedule: { kind: "daily", times: ["8点"] } });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ error: "schedule_refused", message: expect.stringContaining("times") });
    expect((await patch("sched-other", { title: "x" })).status).toBe(404);
    const feed = (h.ctx.db.prepare("SELECT id FROM schedules WHERE owner_id='owner_1' AND builtin='daily_feed'").get() as { id: string }).id;
    expect((await patch(feed, { title: "改名" })).status).toBe(409);
  });
});
