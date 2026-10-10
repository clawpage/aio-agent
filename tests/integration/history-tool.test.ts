import { it, expect, vi } from "vitest";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { HISTORY_POLICY, HistoryGateway, historyMcpServers, historyThreadServers } from "../../src/control/historyTool.js";
import { memberConfig } from "../../src/control/tenants.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";

type Result = { content: Array<{ text: string }>; isError?: boolean };

async function setup() {
  const h = await startHarness();
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }) });
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const history = new HistoryGateway({ port: 0, log: h.ctx.log, runtimeFor: async () => h.ctx });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, history);
  await gateway.start();
  const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
  history.provision(owner);
  // The owner's runtime config is the one the executor prompt and thread wiring read.
  Object.assign(h.ctx.cfg, { history: owner.history });
  const local = (u: string) => u.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
  const rpc = (u: string, body: unknown) => fetch(local(u), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const call = async (u: string, name: string, args: unknown) => (await (await rpc(u, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()).result as Result;
  const json = <T,>(r: Result) => JSON.parse(r.content[0]!.text) as T;
  return { h, gateway, history, owner, cfg, rpc, call, json };
}

it("gives every account its own history tool, wired into the executor like the other gateway tools", async () => {
  const { h, gateway, owner, rpc } = await setup();
  try {
    const member = memberConfig(owner, "user_m", 18092);
    expect(member.history).toBeUndefined();
    gateway.provision(member);
    expect(member.history!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/history\/[a-f0-9]{64}\/mcp$/);
    expect(member.history!.url).not.toBe(owner.history!.url);
    expect(historyThreadServers(member)).toEqual({ aio_history: { url: member.history!.url, tool_timeout_sec: 30 } });
    expect(historyMcpServers(member)).toEqual({ aio_history: { type: "http", url: member.history!.url } });
    expect(codexRequirementsToml(member)).toContain(`[mcp_servers.aio_history.identity]\nurl = "${member.history!.url}"\n`);
    expect((await rpc(member.history!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(member.history!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_history" }, instructions: HISTORY_POLICY });
    const tools = (await (await rpc(member.history!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["history_search", "history_get", "memory_search", "memory_save", "memory_forget"]);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("finds past tasks by any of several words, best match first, with their session and what they did", async () => {
  const { h, gateway, owner, call, json } = await setup();
  try {
    const long = "推荐 A 款推车。" + "理由很长。".repeat(100) + "最后提醒：Roy 的疫苗在 11 月 3 日。";
    h.ctx.tasks.submit({ userId: "owner_1", text: "比较三款婴儿推车", clientMessageId: "hs-1" });
    h.ctx.tasks.submit({ userId: "owner_1", text: "帮 Roy 预约下一针疫苗", clientMessageId: "hs-2" });
    h.ctx.tasks.submit({ userId: "owner_1", text: "查明天天气", clientMessageId: "hs-3" });
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(3));
    const turnOf = (text: string) => h.codex.startedTurns.find((t) => t.text.includes(text))!;
    // What the vaccine task did: a tool call that failed, then a message.
    const vax = turnOf("帮 Roy 预约下一针疫苗");
    h.codex.emitNotification("item/completed", { threadId: vax.threadId, turnId: vax.turnId, item: { id: "c1", type: "mcpToolCall", server: "aio_tabs", tool: "browser_open", arguments: { url: "https://clinic.example/book" }, error: { message: "页面要求登录" } } });
    await h.codex.runTurn(vax.turnId, { text: "诊所网站要登录，请你先登录。" });
    await h.codex.runTurn(turnOf("比较三款婴儿推车").turnId, { text: long });
    await h.codex.runTurn(turnOf("查明天天气").turnId, { text: "明天晴" });

    // "Roy 疫苗" is not a substring of anything: words are matched separately, and the
    // task about the vaccine itself ranks above the one that only mentions it.
    const found = json<Array<{ id: string; title: string; request: string; result: string }>>(await call(owner.history!.url, "history_search", { query: "Roy 疫苗" }));
    expect(found.map((f) => f.request)).toEqual(["帮 Roy 预约下一针疫苗", "比较三款婴儿推车"]);
    // A hit deep in a long result shows that part, not the opening lines.
    expect(found[1]!.result).toContain("Roy 的疫苗在 11 月 3 日");
    expect([...found[1]!.result].length).toBeLessThanOrEqual(201);

    const detail = json<{ request: string; result: string; process?: string[] }>(await call(owner.history!.url, "history_get", { id: found[1]!.id }));
    expect(detail).toMatchObject({ request: "比较三款婴儿推车", result: long });
    expect(detail.process).toBeUndefined();
    const withProcess = json<{ process: string[] }>(await call(owner.history!.url, "history_get", { id: found[0]!.id, process: true }));
    expect(withProcess.process).toEqual([
      '工具 aio_tabs.browser_open({"url":"https://clinic.example/book"}) → 出错：页面要求登录',
      "说 诊所网站要登录，请你先登录。",
    ]);

    // No query: newest first. A filter by status. A lone symbol is matched literally.
    expect(json<unknown[]>(await call(owner.history!.url, "history_search", {}))).toHaveLength(3);
    expect(json<unknown[]>(await call(owner.history!.url, "history_search", { status: "completed" }))).toHaveLength(3);
    expect((await call(owner.history!.url, "history_search", { status: "open" })).content[0]!.text).toContain("没有找到相关任务");
    expect((await call(owner.history!.url, "history_search", { query: "%" })).content[0]!.text).toContain("没有找到相关任务");

    // A follow-up runs in the same execution session: both show where they stand in it.
    h.ctx.tasks.submit({ userId: "owner_1", text: "那第二款推车有现货吗", clientMessageId: "hs-4", relatedTaskId: found[1]!.id });
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(4));
    await h.codex.runTurn(h.codex.startedTurns[3]!.turnId, { text: "第二款有现货" });
    const chain = json<Array<{ request: string; session?: string }>>(await call(owner.history!.url, "history_search", { query: "推车" }));
    expect(chain.map((c) => c.session)).toEqual(expect.arrayContaining(["同一执行会话的第 1/2 个任务", "同一执行会话的第 2/2 个任务"]));
    const first = json<{ session: Array<{ title: string; current?: boolean }> }>(await call(owner.history!.url, "history_get", { id: found[1]!.id }));
    expect(first.session).toHaveLength(2);
    expect(first.session[0]!.current).toBe(true);

    // Another account sees none of it.
    const member = memberConfig(owner, "user_m", 18092);
    gateway.provision(member);
    expect((await call(member.history!.url, "history_search", {})).content[0]!.text).toContain("没有找到相关任务");
    expect((await call(member.history!.url, "history_get", { id: found[0]!.id })).isError).toBe(true);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("keeps the person's standing agreements, gives each execution thread them once, and keeps related tasks to a gist", async () => {
  const { h, gateway, owner, call, json } = await setup();
  try {
    const saved = await call(owner.history!.url, "memory_save", { kind: "rule", text: "推荐商品时只看 Amazon 和 Costco" });
    expect(saved.content[0]!.text).toMatch(/^已记下约定（mem_/);
    await call(owner.history!.url, "memory_save", { kind: "fact", text: "Roy 对鸡蛋过敏" });
    expect((await call(owner.history!.url, "memory_save", { kind: "wish", text: "x" })).isError).toBe(true);
    expect((await call(owner.history!.url, "memory_save", { kind: "rule", text: "长".repeat(301) })).isError).toBe(true);
    const egg = json<Array<{ id: string; text: string }>>(await call(owner.history!.url, "memory_search", { query: "鸡蛋" }));
    expect(egg.map((m) => m.text)).toEqual(["Roy 对鸡蛋过敏"]);
    // A changed mind rewrites the entry instead of adding a contradicting one.
    expect((await call(owner.history!.url, "memory_save", { kind: "fact", text: "Roy 对鸡蛋已不过敏", replaces: egg[0]!.id })).content[0]!.text).toContain("已改写");
    expect(json<unknown[]>(await call(owner.history!.url, "memory_search", {}))).toHaveLength(2);

    // A new execution thread starts with them...
    h.ctx.tasks.submit({ userId: "owner_1", text: "推荐一款空气净化器", clientMessageId: "ag-1" });
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(1));
    const firstTurn = h.codex.startedTurns[0]!;
    expect(firstTurn.text).toContain("用户的长期约定");
    expect(firstTurn.text).toContain("[规则] 推荐商品时只看 Amazon 和 Costco");
    expect(firstTurn.text).toContain("[事实] Roy 对鸡蛋已不过敏");
    expect(firstTurn.text).not.toContain("Roy 对鸡蛋过敏（");
    const result = "推荐 X 型号。" + "详细比较。".repeat(800);
    await h.codex.runTurn(firstTurn.turnId, { text: result });
    const taskId = (h.ctx.db.prepare("SELECT id FROM tasks WHERE client_message_id='ag-1'").get() as { id: string }).id;

    // ...a follow-up in the same thread only names the unchanged version...
    h.ctx.tasks.submit({ userId: "owner_1", text: "那款的滤芯多少钱", clientMessageId: "ag-2", relatedTaskId: taskId });
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(2));
    expect(h.codex.startedTurns[1]!.text).toMatch(/用户的长期约定（版本 [0-9a-f]{8}）已在本会话前文给出且没有变化/);
    expect(h.codex.startedTurns[1]!.text).not.toContain("[规则] 推荐商品时只看 Amazon 和 Costco");
    await h.codex.runTurn(h.codex.startedTurns[1]!.turnId, { text: "滤芯 $40" });

    // ...and once one is forgotten, the next thread no longer carries it.
    const rule = json<Array<{ id: string }>>(await call(owner.history!.url, "memory_search", { query: "Costco" }))[0]!;
    expect((await call(owner.history!.url, "memory_forget", { id: rule.id })).content[0]!.text).toBe("已删除这条约定");
    expect((await call(owner.history!.url, "memory_forget", { id: rule.id })).isError).toBe(true);

    // A related task is given as a gist with a pointer, not its whole result.
    Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [taskId], dependencies: [], resources: [] }) });
    h.ctx.tasks.submit({ userId: "owner_1", text: "给卧室也挑一台", clientMessageId: "ag-3" });
    await vi.waitFor(() => expect(h.codex.startedTurns.length).toBe(3));
    const third = h.codex.startedTurns[2]!.text;
    expect(third).not.toContain("推荐商品时只看 Amazon 和 Costco");
    expect(third).toContain(`已截断，完整内容用 aio_history 的 history_get 读取 ${taskId}`);
    expect(third).not.toContain(result);

    // Agreements belong to their account.
    const member = memberConfig(owner, "user_m", 18092);
    gateway.provision(member);
    expect((await call(member.history!.url, "memory_search", {})).content[0]!.text).toBe("没有相关的约定。");
  } finally {
    gateway.close();
    await h.shutdown();
  }
});
