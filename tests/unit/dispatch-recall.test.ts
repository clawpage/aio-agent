import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { TaskService } from "../../src/control/tasks/service.js";
import { recallStats } from "../../src/control/tasks/recall.js";
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

type Entry = { id: string; title: string; source?: string; date?: string; input_text: string; group:string; result?:string; latestMessage?:string };
type Data = { message: string; previous: Entry[]; mainSessionTimeline?: string; jevJudgment?: { scores?: Record<string,number> } };
/** The Luna view is the last JSON line; document recall is already complete. */
const view = (p: string) => ({ data: JSON.parse(p.split("\n").at(-1)!) as Data });
const jevAnswers = (questions: Record<string,{criteria:Record<string,string>}>, preferred="NEW") => {
  const ids=Object.keys(questions.route!.criteria);
  const pick=preferred==="NEW"?"NEW":ids.find(id=>id.endsWith(`:${preferred}`))!;
  return Object.fromEntries(Object.keys(questions).map(name=>{
    if(name==="route") return [name,{choice:pick,confidence:0.9,probabilities:Object.fromEntries(ids.map(id=>[id,id===pick?0.8:0.2/(ids.length-1)]))}];
    const related=name.endsWith(`:${preferred}`)?0.8:0.1;
    return [name,{choice:related>=0.5?"related":"unrelated",confidence:0.9,probabilities:{related,unrelated:1-related}}];
  }));
};
class DispatchCodex extends FakeCodex {
  prompts: string[] = [];
  decide: (p: string, round: number) => unknown = (p) => ({ title: view(p).data.message.slice(0, 20), related: [], dependencies: [], resources: [] });
  async planTask(p: string) {
    this.prompts.push(p);
    return JSON.stringify(this.decide(p, this.prompts.length));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 40));
let db: Db, agent: AgentManager, codex: DispatchCodex, tasks: TaskService;
const DAY = 86_400_000;
const TOPICS = ["周报整理", "发票报销", "租房合同", "健身计划", "学英语", "宝宝辅食", "家庭预算", "装修报价", "体检预约", "车险续保", "读书笔记", "照片整理"];

/** A long history of finished tasks, oldest first; returns the ids by index. */
function history(n: number, special: Record<number, { title: string; input: string; result: string }> = {}, start = Date.now() - 60 * DAY, prefix = "h"): string[] {
  const ids: string[] = [];
  const insert = db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,status,result,created_at,completed_at) VALUES (?,?,?,?,?,'completed',?,?,?)");
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length]!;
    const t = special[i] ?? { title: `${topic} 第${i}次`, input: `帮我处理一下${topic}，按上次的格式整理`, result: `已完成${topic}` };
    const conv = agent.createConversation({ ownerId: "owner_1", title: t.title });
    const id = `task_${prefix}${i}`;
    const at = start + i * 60_000;
    insert.run(id, `${prefix}${i}`, conv.id, t.title, t.input, t.result, at, at + 1000);
    ids.push(id);
  }
  return ids;
}
const submit = (text: string, relatedTaskId?: string) => tasks.submit({ text, clientMessageId: text, relatedTaskId }).task;
const events = () => db.prepare("SELECT * FROM recall_events ORDER BY id").all() as Array<Record<string, unknown>>;

beforeEach(async () => {
  db = openDb(":memory:");
  codex = new DispatchCodex();
  const cfg = testConfig("/tmp/aio-dispatch-recall", 1);
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource });
  await agent.init();
  tasks = new TaskService(db, cfg, agent, codex);
  tasks.init();
});
afterEach(async () => {
  tasks.close();
  for (const t of codex.startedTurns) codex.completeTurn(t.turnId);
  await tick();
  agent.shutdown();
  db.close();
});

it("asks Jev about the tasks recall found for the message, not only the latest ones", async () => {
  const ids = history(300, { 20: { title: "杭州西湖亲子三日游行程", input: "带两岁宝宝去杭州西湖玩三天，住湖滨", result: "第一天西湖游船" } });
  // A busy day: more of today's tasks than Jev's recent window holds.
  history(20, {}, Date.now() - 30 * 60_000, "today");
  const asked: Array<Record<string, {criteria:Record<string,string>}>> = [];
  const jev = { enabled: true, decide: async (_s: unknown, questions: Record<string, { criteria: Record<string, string> }>) => {
    asked.push(questions);
    return { answers: jevAnswers(questions), usage: null, latencyMs: 1 };
  } };
  tasks.close();
  tasks = new TaskService(db, testConfig("/tmp/aio-dispatch-recall", 1), agent, codex, undefined, jev as never);
  tasks.init();
  submit("把之前杭州西湖那个行程改成四天");
  await tick();
  expect(asked).toHaveLength(1);
  const criteria = asked[0]!.route!.criteria;
  expect(criteria[`resume:${ids[20]}`]).toMatch(/^按内容召回的较早任务（.*）「杭州西湖亲子三日游行程」/);
  expect(asked[0]![`relevance:${ids[20]}`]).toBeDefined();
  // Recency and inverted-index matches both survive the bounded Jev call.
  const latest = Object.entries(criteria).filter(([, text]) => /^第\d+近/.test(text));
  expect(latest).toHaveLength(5);
  expect(latest[0]![1]).toMatch(/^第1近/);
  expect(latest.every(([id]) => id.startsWith("resume:task_today"))).toBe(true);
});

it("omits Jev 0%-related task details from Luna, while keeping explicit references", async () => {
  const ids = history(2, {
    0: { title: "无关的旧花园计划", input: "花园专属输入标记", result: "花园专属结果标记" },
    1: { title: "相关的行程计划", input: "安排火车行程", result: "行程已整理" },
  });
  const jev = { enabled: true, decide: async (_state: unknown, questions: Record<string, { criteria: Record<string, string> }>) => {
    const routeIds = Object.keys(questions.route!.criteria);
    return { answers: Object.fromEntries(Object.keys(questions).map(name => name === "route"
      ? [name, { choice: "NEW", confidence: 0.9, probabilities: Object.fromEntries(routeIds.map(id => [id, id === "NEW" ? 1 : 0])) }]
      : [name, { choice: name === `relevance:${ids[0]}` ? "unrelated" : "related", confidence: 0.9,
        probabilities: name === `relevance:${ids[0]}` ? { related: 0, unrelated: 1 } : { related: 0.8, unrelated: 0.2 } }])), usage: null, latencyMs: 1 };
  } };
  tasks.close();
  tasks = new TaskService(db, testConfig("/tmp/aio-dispatch-recall", 1), agent, codex, undefined, jev as never);
  tasks.init();
  submit("帮我看看行程");
  await tick();
  const prompt = codex.prompts.at(-1)!;
  const data = view(prompt).data;
  expect(data.previous.map(t => t.id)).toEqual([ids[1]]);
  expect(data.jevJudgment?.scores?.[ids[0]!]).toBe(0);
  expect(prompt).not.toContain("花园专属输入标记");
  expect(prompt).not.toContain("花园专属结果标记");
  expect(data.mainSessionTimeline).not.toContain("无关的旧花园计划");
  expect(JSON.parse(events().at(-1)!.candidates_json as string)).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids[0] })]));

  submit("继续花园计划", ids[0]);
  await tick();
  expect(view(codex.prompts.at(-1)!).data.previous.map(t => t.id)).toEqual([ids[0]]);
  expect(codex.prompts.at(-1)).toContain("花园专属结果标记");
});

it("recalls a task hundreds back into the dispatcher's view before it has to ask, with a short excerpt and its date", async () => {
  const ids = history(300, { 20: { title: "杭州西湖亲子三日游行程", input: "带两岁宝宝去杭州西湖玩三天，住湖滨", result: "第一天西湖游船……".repeat(200) } });
  codex.decide = (p) => {
    const trip = view(p).data.previous.find((t) => t.title.includes("杭州西湖"));
    return { title: "改成四天", related: trip ? [trip.id] : [], dependencies: [], resources: [] };
  };
  const job = submit("把之前杭州西湖那个行程改成四天");
  await tick();
  expect(codex.prompts).toHaveLength(1);
  const { data } = view(codex.prompts[0]!);
  const trip = data.previous.find((t) => t.id === ids[20]);
  expect(trip).toMatchObject({ source: "recall", date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  // The recent window is still there, and recall adds only a handful, not hundreds.
  expect(data.previous.filter((t) => t.source === "recent")).toHaveLength(5);
  expect(data.previous.length).toBeLessThanOrEqual(14);
  expect(JSON.parse(tasks.get(job.id)!.plan_json!).related).toEqual([ids[20]]);

  const [event] = events();
  expect(event).toMatchObject({ task_id: job.id, rounds: 1, failed: 0, gold_task_id: null });
  expect(recallStats(db, "owner_1", 7, tasks.recall.cap())).toMatchObject({ dispatches: 1, withRecall: 1, chosen: 1, chosenFromRecall: 1, searchRate: 1 });
});

it("finishes inverted-index recall before Luna and only retries malformed output", async () => {
  const ids = history(200, { 5: { title: "Zephyr 路由器固件升级", input: "Zephyr 路由器升级到新固件，保留端口转发", result: "已升级" } });
  codex.decide = (p) => {
    const found = view(p).data.previous.find((t) => t.id === ids[5]);
    return { title: "升级 Zephyr 固件", description:"继续升级并核对端口转发",decision:{kind:"resume",taskId:found?.id}, related: found ? [found.id] : [], dependencies: [], resources: [] };
  };
  let job = submit("Zephyr 固件升级再弄一次");
  await tick();
  expect(codex.prompts).toHaveLength(1);
  expect(view(codex.prompts[0]!).data.previous.find((t) => t.id === ids[5])?.source).toBe("recall");
  expect(JSON.parse(tasks.get(job.id)!.plan_json!).related).toEqual([ids[5]]);
  expect(events().at(-1)).toMatchObject({ rounds: 1 });
  expect(JSON.parse(events().at(-1)!.searches_json as string) as string[]).toContain("Zephyr 固件升级再弄一次");
  expect(recallStats(db, "owner_1", 7, 10)).toMatchObject({ chosenFromRecall: 1, searchRate: 1, avgRounds: 1 });

  // A malformed answer gets one format repair; it cannot start a search loop.
  codex.prompts = [];
  codex.decide = () => ({ search: ["还要找"] });
  job = submit("随便找找");
  await tick();
  expect(codex.prompts).toHaveLength(2);
  expect(codex.prompts[1]).toContain("你上一次的回答无法使用：缺少 title");
  expect(tasks.get(job.id)!.status).toBe("planning_failed");
  expect(events().at(-1)).toMatchObject({ rounds: 2, failed: 1, fail_reason: "缺少 title" });
});

it("measures where search ranks a task picked by hand, beyond the recent window", async () => {
  const ids = history(100, { 3: { title: "奶奶签证材料清单", input: "整理奶奶 B2 签证面签材料", result: "材料清单……" } });
  submit("奶奶签证材料再补一份在职证明", ids[3]);
  await tick();
  // A hand-picked reference goes straight to that task; the dispatcher sees only it.
  expect(view(codex.prompts[0]!).data.previous.map((t) => t.id)).toEqual([ids[3]]);
  expect(events()[0]).toMatchObject({ gold_task_id: ids[3], gold_rank: 1, gold_in_window: 0 });
  expect(recallStats(db, "owner_1", 7, 10)).toMatchObject({ labelled: 1, recallAtCap: 1, mrr: 1 });
});

it("keeps active and finished task documents separate, including latest result text", async () => {
  const ids=history(30,{7:{title:"宝宝疫苗接种时间表",input:"整理宝宝一岁前的疫苗接种时间表",result:"下一针在十月"}});
  const active=submit("规划宝宝十一月行程");await tick();
  const job=submit("疫苗时间和行程协调一下");await tick();
  const previous=view(codex.prompts.at(-1)!).data.previous;
  expect(previous.find(t=>t.id===active.id)).toMatchObject({group:"active",source:"active"});
  expect(previous.find(t=>t.id===ids[7])).toMatchObject({group:"finished",source:"recall",result:"下一针在十月",latestMessage:"下一针在十月"});
  expect(tasks.get(job.id)?.status).toBe("running");
});

it("indexes old result messages and passes an active executor's latest message to Jev and Luna", async () => {
  const ids=history(60,{3:{title:"资料整理",input:"整理旧材料",result:"昴星团蓝色星云清单已经完成"}});
  const running=submit("读取今天的资料");await tick();
  const turn=tasks.get(running.id)!;
  db.prepare("INSERT INTO events (conversation_id,turn_id,type,payload,created_at) VALUES (?,?,?,?,?)")
    .run(turn.conversation_id,turn.turn_id,"item/completed",JSON.stringify({item:{type:"agentMessage",text:"已找到蓝色行星的最新资料"}}),Date.now());
  submit("昴星团蓝色星云和蓝色行星的资料合在一起");await tick();
  const previous=view(codex.prompts.at(-1)!).data.previous;
  expect(previous.find(t=>t.id===ids[3])).toMatchObject({source:"recall",group:"finished",result:"昴星团蓝色星云清单已经完成"});
  expect(previous.find(t=>t.id===running.id)).toMatchObject({group:"active",latestMessage:"已找到蓝色行星的最新资料"});
});

it("bounds document recall and gives Luna one decision even for broad terms", async () => {
  // Every past task mentions reimbursement: any search on it matches all of them.
  history(120, Object.fromEntries(Array.from({ length: 120 }, (_, i) => [i, { title: `发票报销 ${i}`, input: `发票报销 第${i}张 餐饮 交通 酒店`, result: "已报销" }])));
  codex.decide = () => ({ title: "报销",description:"核对这次报销",decision:{kind:"new",taskId:null}, related: [], dependencies: [], resources: [] });
  submit("发票报销 餐饮 交通 酒店 再来一次");
  await tick();
  const previous = view(codex.prompts.at(-1)!).data.previous;
  expect(previous.filter((t) => t.source === "recall").length).toBeLessThanOrEqual(4);
  expect(previous.length).toBeLessThanOrEqual(14);
  expect(codex.prompts).toHaveLength(1);
});
