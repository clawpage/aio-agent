import { it, expect, vi } from "vitest";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { SCHEDULE_POLICY, ScheduleGateway, scheduleMcpServers, scheduleThreadServers } from "../../src/control/scheduleTool.js";
import { memberConfig } from "../../src/control/tenants.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";

it("gives every account a schedule tool that creates and manages its own schedules, outside any conversation", async () => {
  const h = await startHarness();
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const asked: string[] = [];
  const schedule = new ScheduleGateway({ port: 0, log: h.ctx.log, tasksFor: async (id) => (asked.push(id), h.ctx.tasks) });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, schedule);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    schedule.provision(owner);
    // A member never inherits the owner's tool: the gateway gives it one of its own.
    expect(memberConfig(owner, "user_m", 18092).schedule).toBeUndefined();
    const member = memberConfig(owner, "user_m", 18092);
    gateway.provision(member);
    expect(member.schedule!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/schedule\/[a-f0-9]{64}\/mcp$/);
    expect(member.schedule!.url).not.toBe(owner.schedule!.url);
    expect(scheduleThreadServers(member)).toEqual({ aio_schedule: { url: member.schedule!.url, tool_timeout_sec: 30 } });
    expect(scheduleMcpServers(member)).toEqual({ aio_schedule: { type: "http", url: member.schedule!.url } });
    // Codex runs a thread's MCP server only when its exact URL is in the managed policy.
    expect(codexRequirementsToml(member)).toContain(`[mcp_servers.aio_schedule.identity]\nurl = "${member.schedule!.url}"\n`);

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await rpc(member.schedule!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(member.schedule!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_schedule" }, instructions: SCHEDULE_POLICY });
    expect((await rpc(member.schedule!.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = (await (await rpc(member.schedule!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string; description: string }>;
    expect(tools.map((t) => t.name)).toEqual(["schedule_create", "schedule_list", "schedule_change", "task_list", "task_get", "feed_get", "feed_update"]);
    // The description says what the session-bound timers never could.
    expect(tools[0]!.description).toContain("不属于当前对话或会话");

    const call = async (url: string, name: string, args: unknown) => (await (await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })).json()).result as { content: Array<{ text: string }>; isError?: boolean };
    const until = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10);
    const created = await call(member.schedule!.url, "schedule_create", {
      title: "盯 Prime Day 扫地机价格",
      instruction: "查 Amazon 上 Ecovacs T90 Pro Omni 的价格，低于 $449 时给出价格和链接，否则一句话说明没变化",
      schedule: { kind: "daily", at: "09:00", until },
    });
    expect(created.isError).toBeUndefined();
    expect(created.content[0]!.text).toContain("已创建定时任务「盯 Prime Day 扫地机价格」：每天 09:00");
    const row = h.ctx.db.prepare("SELECT id,owner_id,status,resources_json,source_task_id,spec_json FROM schedules WHERE title=?").get("盯 Prime Day 扫地机价格") as Record<string, string>;
    expect(row).toMatchObject({ owner_id: "user_m", status: "active", resources_json: '["browser"]', source_task_id: null });
    expect(JSON.parse(row.spec_json)).toMatchObject({ kind: "daily", at: "09:00", until });
    expect(created.content[0]!.text).toContain(`id: ${row.id}`);

    // Bad rules are explained, never stored.
    expect((await call(member.schedule!.url, "schedule_create", { title: "x", instruction: "y", schedule: { kind: "daily" } })).content[0]!.text).toContain("schedule.at");
    expect((await call(member.schedule!.url, "schedule_create", { title: "x", instruction: "y", schedule: { kind: "interval", everyMinutes: 5 } })).isError).toBe(true);
    expect((await call(member.schedule!.url, "schedule_create", { title: "x", schedule: { kind: "daily", at: "09:00" } })).content[0]!.text).toContain("instruction");
    const offline = await call(member.schedule!.url, "schedule_create", { title: "每周一提醒交房租", instruction: "提醒用户交房租", schedule: { kind: "weekly", at: "08:00", weekdays: [1] }, needsBrowser: false });
    expect(offline.isError).toBeUndefined();
    expect(h.ctx.db.prepare("SELECT resources_json FROM schedules WHERE title=?").get("每周一提醒交房租")).toEqual({ resources_json: "[]" });

    // Each account sees and changes only its own.
    const mine = JSON.parse((await call(member.schedule!.url, "schedule_list", {})).content[0]!.text) as Array<{ id: string; title: string }>;
    expect(mine.map((s) => s.title)).toEqual(expect.arrayContaining(["盯 Prime Day 扫地机价格", "每周一提醒交房租"]));
    const ownerList = (await call(owner.schedule!.url, "schedule_list", {})).content[0]!.text;
    expect(ownerList).not.toContain("扫地机");
    expect((await call(owner.schedule!.url, "schedule_change", { id: row.id, action: "pause" })).isError).toBe(true);
    expect((await call(member.schedule!.url, "schedule_change", { id: row.id, action: "pause" })).content[0]!.text).toContain("已暂停");
    expect((await call(member.schedule!.url, "schedule_change", { id: row.id, action: "explode" })).isError).toBe(true);
    expect((await call(member.schedule!.url, "schedule_change", { id: row.id, action: "cancel" })).content[0]!.text).toContain("已取消");
    expect(h.ctx.db.prepare("SELECT 1 FROM schedules WHERE id=?").get(row.id)).toBeUndefined();
    expect((await (await rpc(member.schedule!.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "schedule_explode", arguments: {} } })).json()).error).toBeTruthy();
    // The built-in daily feed: a task reads and changes it through the same tool, for its own account only.
    const ownerFeed = JSON.parse((await call(owner.schedule!.url, "feed_get", {})).content[0]!.text) as { customized: boolean; memory: unknown[] };
    expect(ownerFeed).toMatchObject({ title: "每日推送", customized: false, memory: [] });
    expect((await call(owner.schedule!.url, "schedule_list", {})).content[0]!.text).toContain("feed_get");
    const updated = await call(owner.schedule!.url, "feed_update", { instruction: "推送时看看 Gmail 有没有账单", add: [{ kind: "avoid", text: "加密货币行情" }] });
    expect(updated.isError).toBeUndefined();
    expect(updated.content[0]!.text).toContain("已更新每日推送的要求");
    expect(JSON.parse((await call(owner.schedule!.url, "feed_get", {})).content[0]!.text)).toMatchObject({ customized: true, instruction: "推送时看看 Gmail 有没有账单", memory: [{ kind: "avoid", text: "加密货币行情", source: "user" }] });
    expect((await call(owner.schedule!.url, "feed_update", { add: [{ kind: "avoid" }] })).isError).toBe(true);
    // The member's tool never reaches the owner's feed.
    const memberFeed = await call(member.schedule!.url, "feed_update", { instruction: "改别人的推送" });
    expect(memberFeed.isError).toBe(true);
    expect(h.ctx.db.prepare("SELECT instruction FROM schedules WHERE owner_id='owner_1' AND builtin='daily_feed'").get()).toEqual({ instruction: "推送时看看 Gmail 有没有账单" });
    expect(new Set(asked)).toEqual(new Set(["user_m", "owner_1"]));
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("lets an executor look up its own account's tasks on demand, and only those", async () => {
  const h = await startHarness();
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }) });
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const schedule = new ScheduleGateway({ port: 0, log: h.ctx.log, tasksFor: async () => h.ctx.tasks });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, schedule);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    schedule.provision(owner);
    const member = memberConfig(owner, "user_m", 18092);
    gateway.provision(member);
    const url = (u: string) => u.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const call = async (u: string, name: string, args: unknown) => (await (await fetch(url(u), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result as { content: Array<{ text: string }>; isError?: boolean };

    const long = "推荐 A 款推车。" + "理由很长。".repeat(100);
    h.ctx.tasks.submit({ userId: "owner_1", text: "比较三款婴儿推车", clientMessageId: "tl-1" });
    h.ctx.tasks.submit({ userId: "owner_1", text: "查明天天气", clientMessageId: "tl-2" });
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(2));
    await h.codex.runTurn(h.codex.startedTurns.find((t) => t.text.includes("比较三款婴儿推车"))!.turnId, { text: long });

    const found = JSON.parse((await call(owner.schedule!.url, "task_list", { query: "推车" })).content[0]!.text) as Array<{ id: string; request: string; status: string; result: string }>;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ request: "比较三款婴儿推车", status: "completed" });
    expect([...found[0]!.result].length).toBeLessThanOrEqual(160);   // a summary in the list...
    const detail = JSON.parse((await call(owner.schedule!.url, "task_get", { id: found[0]!.id })).content[0]!.text) as { request: string; result: string };
    expect(detail).toMatchObject({ request: "比较三款婴儿推车", result: long });   // ...the whole result on request
    expect(JSON.parse((await call(owner.schedule!.url, "task_list", {})).content[0]!.text)).toHaveLength(2);
    // A "%" in the query is a character, not a wildcard.
    expect((await call(owner.schedule!.url, "task_list", { query: "%" })).content[0]!.text).toBe("没有找到相关任务。");

    // Another account sees none of it.
    expect((await call(member.schedule!.url, "task_list", {})).content[0]!.text).toBe("没有找到相关任务。");
    expect((await call(member.schedule!.url, "task_get", { id: found[0]!.id })).isError).toBe(true);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});
