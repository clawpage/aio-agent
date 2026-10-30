import { it, expect, vi } from "vitest";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { memberConfig } from "../../src/control/tenants.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { TASK_KB_POLICY, TaskKbGateway, taskKbMcpServers, taskKbThreadServers } from "../../src/control/taskKb/gateway.js";
import { applyKbAnswer, deleteKbNode, sensitiveReason, sha256, wikiIneligible } from "../../src/control/taskKb/kernel.js";
import { getKbNode, kbBrief, listKb, searchKb } from "../../src/control/taskKb/read.js";
import { TaskKbMaintainer, parseAnswer } from "../../src/control/taskKb/maintainer.js";
import { renderKbIndex } from "../../src/control/taskKb/projection.js";

type Result = { content: Array<{ text: string }>; isError?: boolean };

/** A sandbox that holds some files and records what is written into it. */
function fakeContainer(files: Record<string, string> = {}) {
  const written = new Map<string, string>();
  const commands: string[][] = [];
  return {
    files, written, commands,
    async execInSandbox(argv: string[]) {
      commands.push(argv);
      const name = argv[3];
      if (name === "kb-read") { const f = files[argv[4]!]; return f === undefined ? { code: 3, stdout: "", stderr: "" } : { code: 0, stdout: f, stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    },
    async writeFileInSandbox(file: string, content: string) { written.set(file, content); },
  };
}

async function setup() {
  const h = await startHarness();
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }) });
  const container = fakeContainer();
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
  const runtime = { db: h.ctx.db, cfg: owner, container, taskKb: { nudge: vi.fn() } };
  const taskKb = new TaskKbGateway({ port: 0, log: h.ctx.log, runtimeFor: async () => runtime });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taskKb);
  await gateway.start();
  taskKb.provision(owner);
  Object.assign(h.ctx.cfg, { taskKb: owner.taskKb });
  const local = (u: string) => u.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
  const rpc = (u: string, body: unknown) => fetch(local(u), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const call = async (name: string, args: unknown) => (await (await rpc(owner.taskKb!.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()).result as Result;
  const json = <T,>(r: Result) => JSON.parse(r.content[0]!.text) as T;
  const ws = owner.sandbox.containerWorkspaceDir;
  /** A finished task that opened a page and answered; returns its id. */
  const task = async (text: string, answer: string, page?: { url: string; content: string }) => {
    h.ctx.tasks.submit({ userId: "owner_1", text, clientMessageId: `kb-${text}` });
    await vi.waitFor(() => expect(h.codex.startedTurns.some((t) => t.text.includes(text))).toBe(true));
    const turn = h.codex.startedTurns.find((t) => t.text.includes(text))!;
    if (page) h.codex.emitNotification("item/completed", { threadId: turn.threadId, turnId: turn.turnId, item: { id: `c-${text}`, type: "mcpToolCall", server: "aio_tabs", tool: "browser_open", arguments: { url: page.url }, result: { content: [{ type: "text", text: page.content }] } } });
    await h.codex.runTurn(turn.turnId, { text: answer });
    const id = (h.ctx.db.prepare("SELECT id FROM tasks WHERE input_text=?").get(text) as { id: string }).id;
    await vi.waitFor(() => expect(h.ctx.tasks.get(id)!.status).toBe("completed"));
    return id;
  };
  const kernel = (packets: string[] = []) => ({ db: h.ctx.db, ownerId: "owner_1", workspaceDir: ws, packets, readFile: async (f: string) => (container.files[f] === undefined ? null : { text: container.files[f]!, sha256: sha256(container.files[f]!) }) });
  return { h, gateway, owner, container, runtime, call, json, rpc, task, kernel, ws };
}

it("gives every account its own read-and-propose knowledge tool with no way to write", async () => {
  const { h, gateway, owner, rpc } = await setup();
  try {
    const member = memberConfig(owner, "user_m", 18092);
    expect(member.taskKb).toBeUndefined();
    gateway.provision(member);
    expect(member.taskKb!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/task-kb\/[a-f0-9]{64}\/mcp$/);
    expect(member.taskKb!.url).not.toBe(owner.taskKb!.url);
    expect(taskKbThreadServers(member)).toEqual({ aio_task_kb: { url: member.taskKb!.url, tool_timeout_sec: 30 } });
    expect(taskKbMcpServers(member)).toEqual({ aio_task_kb: { type: "http", url: member.taskKb!.url } });
    expect(codexRequirementsToml(member)).toContain(`[mcp_servers.aio_task_kb.identity]\nurl = "${member.taskKb!.url}"\n`);
    expect((await rpc(member.taskKb!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(owner.taskKb!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_task_kb" }, instructions: TASK_KB_POLICY });
    const tools = (await (await rpc(owner.taskKb!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["kb_search", "kb_get", "kb_neighbors", "kb_source", "kb_propose", "kb_propose_status"]);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("writes only what is sourced by words that really are in the task or its files", async () => {
  const { h, gateway, container, task, kernel, ws } = await setup();
  try {
    const id = await task("查 Costco 退货政策", "Costco 大部分商品 90 天内可退，电子产品需要原包装。", { url: "https://www.costco.com/returns", content: "Most items can be returned within 90 days. Electronics must include original packaging." });
    container.files[`${ws}/tasks/${id}/notes.md`] = "# 退货笔记\n会员卡必须带上，否则柜台不受理。\n";
    const good = {
      decisions: [],
      ops: [
        { op: "node", ref: "costco", kind: "entity", domain: "shopping", title: "Costco", summary: "常去的会员制仓储店" },
        { op: "claim", node: "costco", text: "大部分商品 90 天内可退", certainty: "observed", volatility: "changes", sources: [{ task: id, url: "https://www.costco.com/returns", quote: "Most items can be returned within 90 days." }] },
        { op: "claim", node: "costco", text: "退货要带会员卡", certainty: "observed", sources: [{ task: id, path: `tasks/${id}/notes.md`, quote: "会员卡必须带上" }] },
      ],
    };
    const applied = await applyKbAnswer(kernel(), good);
    expect(applied).toMatchObject({ ok: true, changed: 3 });
    const [hit] = searchKb(h.ctx.db, "owner_1", { query: "Costco 退货" });
    expect(hit).toMatchObject({ title: "Costco", domain: "shopping", kind: "entity" });
    const node = getKbNode(h.ctx.db, "owner_1", hit!.id)!;
    expect(node.claims.map((c) => [c.text, c.recheck])).toEqual(expect.arrayContaining([["大部分商品 90 天内可退", true], ["退货要带会员卡", false]]));
    expect(node.claims.find((c) => c.text === "退货要带会员卡")!.sources[0]).toMatchObject({ task: id, path: `tasks/${id}/notes.md`, excerpt: "会员卡必须带上" });

    // Each of these is refused, and nothing of a refused answer lands.
    const before = listKb(h.ctx.db, "owner_1").nodes.length;
    const refuse = async (op: Record<string, unknown>, reason: RegExp) => {
      const r = await applyKbAnswer(kernel(), { decisions: [], ops: [{ op: "node", ref: "x", kind: "fact", domain: "shopping", title: "Test" }, { op: "claim", node: "x", text: "something", certainty: "observed", sources: [{ task: id, quote: "Electronics must include original packaging." }] }, op] });
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(reason);
    };
    await refuse({ op: "claim", node: "x", text: "made up", certainty: "observed", sources: [{ task: id, quote: "Returns are accepted for a full year" }] }, /does not appear in task/);
    await refuse({ op: "claim", node: "x", text: "t", certainty: "observed", sources: [{ task: id, path: "tasks/other/notes.md", quote: "会员卡必须带上" }] }, /must be a file in tasks\//);
    await refuse({ op: "claim", node: "x", text: "t", certainty: "observed", sources: [{ task: "task_nope", quote: "会员卡必须带上" }] }, /does not exist in this account/);
    await refuse({ op: "claim", node: "x", text: "t", certainty: "observed", sources: [{ task: id, url: "https://evil.example/", quote: "Electronics must include original packaging." }] }, /was not visited/);
    await refuse({ op: "claim", node: "x", text: "Costco 网站密码是 hunter2abc", certainty: "user_said", sources: [{ task: id, quote: "Electronics must include original packaging." }] }, /password/);
    await refuse({ op: "node", ref: "y", kind: "fact", domain: "nowhere", title: "T" }, /domain nowhere does not exist/);
    await refuse({ op: "node", ref: "z", kind: "fact", domain: "shopping", title: "Lonely" }, /node z has no claim/);
    expect(listKb(h.ctx.db, "owner_1").nodes.length).toBe(before);

    expect(sensitiveReason("卡号 4111 1111 1111 1111")).toMatch(/card/);
    expect(sensitiveReason("身份证 11010519491231002X")).toMatch(/identity/);
    expect(sensitiveReason("订单号 112-3456789-0123456")).toBeNull();

    // The person deletes it: the node, its claims and the sources only it cited are gone.
    expect(deleteKbNode(h.ctx.db, "owner_1", hit!.id, "person")).toBe(true);
    expect(getKbNode(h.ctx.db, "owner_1", hit!.id)).toBeNull();
    expect((h.ctx.db.prepare("SELECT count(*) AS n FROM kb_sources").get() as { n: number }).n).toBe(0);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("lets an agent at work flag a claim for the maintainer, with evidence from its own task", async () => {
  const { h, gateway, task, kernel, call, json, runtime } = await setup();
  try {
    const first = await task("查超市营业时间", "Safeway 每天 6:00-24:00 营业。");
    await applyKbAnswer(kernel(), { decisions: [], ops: [
      { op: "node", ref: "s", kind: "entity", domain: "shopping", title: "Safeway", summary: "附近的超市" },
      { op: "claim", node: "s", text: "每天 6:00-24:00 营业", certainty: "observed", volatility: "changes", sources: [{ task: first, quote: "Safeway 每天 6:00-24:00 营业" }] },
    ] });
    const nodeId = searchKb(h.ctx.db, "owner_1", { query: "Safeway" })[0]!.id;
    const now = await task("去 Safeway 买菜", "到了才发现 Safeway 现在改成 7:00-22:00 营业了。", { url: "https://www.safeway.com/store", content: "Store hours: 7:00 AM - 10:00 PM" });

    const missing = await call("kb_propose", { type: "correct", task: now, target: nodeId, text: "营业时间改为 7:00-22:00", evidence: [{ quote: "Open 24 hours every day" }] });
    expect(missing.isError).toBe(true);
    const sent = await call("kb_propose", { type: "correct", task: now, target: nodeId, text: "营业时间改为 7:00-22:00", evidence: [{ quote: "Store hours: 7:00 AM - 10:00 PM", url: "https://www.safeway.com/store" }] });
    expect(sent.isError).toBeUndefined();
    expect(runtime.taskKb.nudge).toHaveBeenCalledWith(true);
    // Flagged at once, for everyone, before the maintainer has looked.
    const node = json<{ pendingCorrections: Array<{ type: string; text: string; task: string }> }>(await call("kb_get", { id: nodeId }));
    expect(node.pendingCorrections).toEqual([expect.objectContaining({ type: "correct", task: now })]);
    expect(searchKb(h.ctx.db, "owner_1", { query: "Safeway" })[0]!.flagged).toBe(1);
    expect(kbBrief(h.ctx.db, "owner_1", "Safeway 几点关门")!.text).toMatch(/correction\(s\) pending/);
    // The same thing again is the same proposal.
    const again = await call("kb_propose", { type: "correct", task: now, target: nodeId, text: "营业时间改为 7:00-22:00", evidence: [{ quote: "Store hours: 7:00 AM - 10:00 PM", url: "https://www.safeway.com/store" }] });
    expect(again.content[0]!.text.match(/kbp_[a-f0-9]+/)![0]).toBe(sent.content[0]!.text.match(/kbp_[a-f0-9]+/)![0]);
    expect((await call("kb_propose", { type: "outdated", task: now, text: "x", evidence: [{ quote: "Store hours" }] })).isError).toBe(true);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("reads finished tasks in batches when the sandbox is awake and nothing else runs, and retries a refused answer once", async () => {
  const { h, gateway, owner, container, task, ws } = await setup();
  try {
    const chat = await task("你好", "你好！");
    const work = await task("帮我查 Roy 的儿科诊所电话", "Bay Pediatrics 的电话是 650-555-0100。", { url: "https://baypeds.example/contact", content: "Call us: 650-555-0100. Open Mon-Fri." });
    const answers: string[] = [];
    let busy = false;
    let state: "running" | "dozing" | "parked" = "running";
    const codex = {
      maintainKb: vi.fn(async (prompt: string, _instructions: string, opts: { member: boolean; servers: Record<string, unknown> }) => {
        expect(opts.member).toBe(false);
        // No tools: a read-only thread with approval `never` has its tool calls refused.
        expect(opts.servers).toEqual({});
        return { text: answers.shift() ?? null, error: null, prompt };
      }),
    };
    const m = new TaskKbMaintainer({ db: h.ctx.db, cfg: owner, log: h.ctx.log, codex, container, busy: async () => busy, idleState: () => state });
    m.taskCompleted(chat);
    m.taskCompleted(work);
    const pending = h.ctx.db.prepare("SELECT id, task_id FROM kb_packets WHERE status='pending'").all() as Array<{ id: string; task_id: string }>;
    // A chat that used no tools is not worth reading.
    expect(pending.map((p) => p.task_id)).toEqual([work]);

    state = "parked";
    expect(await m.run()).toBe(0);
    state = "dozing"; busy = true;
    expect(await m.run()).toBe(0);
    busy = false;
    const packet = pending[0]!.id;
    answers.push(
      "not json",
      JSON.stringify({ decisions: [{ packet, status: "accepted", note: "clinic contact" }], ops: [
        { op: "node", ref: "c", kind: "entity", domain: "health", title: "Bay Pediatrics", summary: "Roy 的儿科诊所" },
        { op: "claim", node: "c", text: "电话 650-555-0100，周一到周五开门", certainty: "observed", sources: [{ task: work, url: "https://baypeds.example/contact", quote: "Call us: 650-555-0100. Open Mon-Fri." }] },
      ] }),
    );
    expect(await m.run()).toBe(1);
    expect(codex.maintainKb).toHaveBeenCalledTimes(2);
    // The material carried what the task saw, and the retry carried why the first answer was refused.
    expect(codex.maintainKb.mock.calls[0]![0]).toContain("Call us: 650-555-0100");
    expect(codex.maintainKb.mock.calls[0]![0]).toContain("Existing nodes related to this batch: none yet.");
    expect(codex.maintainKb.mock.calls[1]![0]).toContain("It was not accepted");
    expect(h.ctx.db.prepare("SELECT status, note FROM kb_packets WHERE id=?").get(packet)).toMatchObject({ status: "accepted", note: "clinic contact" });
    expect(searchKb(h.ctx.db, "owner_1", { query: "儿科诊所" })[0]!.title).toBe("Bay Pediatrics");
    // The files in the sandbox were rewritten from the database.
    expect(container.written.get(`${ws}/kb/INDEX.md`)).toContain("Bay Pediatrics");
    expect(renderKbIndex(h.ctx.db, "owner_1")).toMatch(/## health[\s\S]*Bay Pediatrics/);
    expect(parseAnswer("Here:\n```json\n{\"ops\":[]}\n```")).toEqual({ ops: [] });
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("looks back fourteen days for the owner only, and gives a node a wiki page only after it is used and checked", async () => {
  const { h, gateway, owner, container, task, kernel } = await setup();
  try {
    const a = await task("订 SFO 到 PVG 的机票", "United UA857 每天 11:00 从 SFO 起飞。", { url: "https://united.example/ua857", content: "UA857 departs SFO daily at 11:00." });
    const b = await task("再查一次 UA857", "UA857 仍是每天 11:00 起飞，经济舱 $1,200。", { url: "https://united.example/ua857", content: "UA857 departs SFO daily at 11:00. Economy from $1,200." });
    h.ctx.db.prepare("UPDATE tasks SET completed_at=? WHERE id=?").run(Date.now() - 20 * 86_400_000, a);
    // The runtime's own maintainer queued them as they finished; the look back is what is tested here.
    expect((h.ctx.db.prepare("SELECT task_id FROM kb_packets ORDER BY created_at").all() as Array<{ task_id: string }>).map((p) => p.task_id)).toEqual([a, b]);
    h.ctx.db.prepare("DELETE FROM kb_packets").run();
    h.ctx.db.prepare("DELETE FROM meta WHERE key='task_kb.backfill_v1'").run();
    const codex = { maintainKb: vi.fn(async () => ({ text: null, error: null })) };
    const member = { ...owner, memberRuntime: true, runtimeUserId: "owner_1" };
    new TaskKbMaintainer({ db: h.ctx.db, cfg: member, log: h.ctx.log, codex, container, busy: async () => false, idleState: () => "running" }).start();
    expect((h.ctx.db.prepare("SELECT count(*) AS n FROM kb_packets").get() as { n: number }).n).toBe(0);
    const m = new TaskKbMaintainer({ db: h.ctx.db, cfg: owner, log: h.ctx.log, codex, container, busy: async () => false, idleState: () => "running" });
    m.start();
    m.stop();
    expect((h.ctx.db.prepare("SELECT task_id FROM kb_packets").all() as Array<{ task_id: string }>).map((p) => p.task_id)).toEqual([b]);
    // A task that finishes now is read before what the look back queued.
    const c = await task("查 UA858 回程", "UA858 每天 13:00 从 PVG 起飞。", { url: "https://united.example/ua858", content: "UA858 departs PVG daily at 13:00." });
    m.taskCompleted(c);
    const read = vi.fn(async (_prompt: string) => ({ text: null, error: "stop" }));
    await new TaskKbMaintainer({ db: h.ctx.db, cfg: owner, log: h.ctx.log, codex: { maintainKb: read }, container, busy: async () => false, idleState: () => "dozing" }).run();
    const prompt = read.mock.calls[0]![0];
    expect(prompt.indexOf(`finished task ${c}`)).toBeGreaterThan(-1);
    expect(prompt.indexOf(`finished task ${c}`)).toBeLessThan(prompt.indexOf(`finished task ${b}`));
    h.ctx.db.prepare("DELETE FROM kb_packets WHERE task_id=?").run(c);

    await applyKbAnswer(kernel(), { decisions: [], ops: [
      { op: "node", ref: "f", kind: "fact", domain: "travel", title: "UA857", summary: "SFO 到上海的直飞" },
      { op: "claim", node: "f", text: "每天 11:00 从 SFO 起飞", certainty: "observed", sources: [{ task: a, quote: "UA857 departs SFO daily at 11:00." }, { task: b, quote: "UA857 departs SFO daily at 11:00." }] },
    ] });
    const id = searchKb(h.ctx.db, "owner_1", { query: "UA857" })[0]!.id;
    expect(wikiIneligible(h.ctx.db, "owner_1", id)).toMatch(/read by tasks 0 times/);
    for (let i = 0; i < 3; i++) getKbNode(h.ctx.db, "owner_1", id, { read: true });
    expect(wikiIneligible(h.ctx.db, "owner_1", id)).toBeNull();
    expect((await applyKbAnswer(kernel(), { decisions: [], ops: [{ op: "wiki", node: id, markdown: "UA857：每天 11:00 从 SFO 起飞（task " + a + "）。" }] })).ok).toBe(true);

    // The draft is published only when another session passes it.
    const reviewer = { maintainKb: vi.fn(async () => ({ text: JSON.stringify({ pass: true, problems: [] }), error: null })) };
    const r = new TaskKbMaintainer({ db: h.ctx.db, cfg: owner, log: h.ctx.log, codex: reviewer, container, busy: async () => false, idleState: () => "running" });
    h.ctx.db.prepare("UPDATE kb_packets SET status='merged'").run();
    h.ctx.db.prepare("INSERT INTO kb_packets (id, owner_id, kind, task_id, payload_json, created_at) VALUES ('kbp_x','owner_1','extract',?, '{}', 1)").run(b);
    await r.run();
    expect(getKbNode(h.ctx.db, "owner_1", id)!.wiki).toContain("UA857");
    expect([...container.written.keys()].some((k) => k.endsWith(`/kb/wiki.next/travel/${id}.md`))).toBe(true);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});

it("hands a new task the knowledge that matches it, once per session", async () => {
  const { h, gateway, task, kernel } = await setup();
  try {
    const a = await task("Roy 的过敏情况", "Roy 对鸡蛋过敏，医生建议 1 岁后再测。");
    await applyKbAnswer(kernel(), { decisions: [], ops: [
      { op: "node", ref: "r", kind: "topic", domain: "health", title: "Roy 的过敏", summary: "Roy 对鸡蛋过敏" },
      { op: "claim", node: "r", text: "Roy 对鸡蛋过敏", certainty: "user_said", sources: [{ task: a, quote: "Roy 对鸡蛋过敏" }] },
    ] });
    h.ctx.tasks.submit({ userId: "owner_1", text: "给 Roy 挑一款辅食，注意过敏", clientMessageId: "kb-brief" });
    await vi.waitFor(() => expect(h.codex.startedTurns.some((t) => t.text.includes("给 Roy 挑一款辅食"))).toBe(true));
    const prompt = h.codex.startedTurns.find((t) => t.text.includes("给 Roy 挑一款辅食"))!.text;
    expect(prompt).toContain("Notes from the user's personal knowledge base");
    expect(prompt).toContain("Roy 的过敏");
  } finally {
    gateway.close();
    await h.shutdown();
  }
});
