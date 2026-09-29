import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { AgentManager } from "../../src/server/codex/manager.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { TaskService } from "../../src/server/tasks/service.js";
import { recallStats } from "../../src/server/tasks/recall.js";
import { Logger } from "../../src/server/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

type Entry = { id: string; title: string; source?: string; date?: string; input_text: string };
type Data = { message: string; searched?: string[]; previous: Entry[] };
/** The dispatcher's view: the JSON on the last line of its prompt, plus whether it may search. */
const view = (p: string) => ({ data: JSON.parse(p.split("\n").at(-1)!) as Data, canSearch: p.includes('只返回 {"search"') || p.includes('可以只返回 {"search"') });
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
function history(n: number, special: Record<number, { title: string; input: string; result: string }> = {}, start = Date.now() - 60 * DAY): string[] {
  const ids: string[] = [];
  const insert = db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,status,result,created_at,completed_at) VALUES (?,?,?,?,?,'completed',?,?,?)");
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length]!;
    const t = special[i] ?? { title: `${topic} 第${i}次`, input: `帮我处理一下${topic}，按上次的格式整理`, result: `已完成${topic}` };
    const conv = agent.createConversation({ ownerId: "owner_1", title: t.title });
    const id = `task_h${i}`;
    const at = start + i * 60_000;
    insert.run(id, `h${i}`, conv.id, t.title, t.input, t.result, at, at + 1000);
    ids.push(id);
  }
  return ids;
}
const submit = (text: string, relatedTaskId?: string) => tasks.submit({ text, clientMessageId: text, relatedTaskId }).task;
const events = () => db.prepare("SELECT * FROM recall_events ORDER BY id").all() as Array<Record<string, unknown>>;

beforeEach(async () => {
  db = openDb(":memory:");
  codex = new DispatchCodex();
  const cfg = testConfig("/tmp/aio-dispatch-recall", 1, { PA_AUTO_TITLE: "0" });
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
  expect(data.previous.filter((t) => t.source === "recent")).toHaveLength(12);
  expect(data.previous.length).toBeLessThanOrEqual(12 + 10);
  expect(JSON.parse(tasks.get(job.id)!.plan_json!).related).toEqual([ids[20]]);

  const [event] = events();
  expect(event).toMatchObject({ task_id: job.id, rounds: 1, failed: 0, gold_task_id: null });
  expect(recallStats(db, "owner_1", 7, tasks.recall.cap())).toMatchObject({ dispatches: 1, withRecall: 1, chosen: 1, chosenFromRecall: 1, searchRate: 0 });
});

it("lets the dispatcher search past tasks by keywords, then decide with the hits, at most twice", async () => {
  const ids = history(200, { 5: { title: "Zephyr 路由器固件升级", input: "Zephyr 路由器升级到新固件，保留端口转发", result: "已升级" } });
  codex.decide = (p, round) => {
    const { data, canSearch } = view(p);
    if (round === 1) {
      expect(canSearch).toBe(true);
      expect(data.previous.some((t) => t.id === ids[5])).toBe(false);
      return { search: ["Zephyr", "固件升级"] };
    }
    // A second search is still allowed; it has what it needs, so it answers.
    expect(canSearch).toBe(true);
    expect(data.searched).toEqual(["Zephyr", "固件升级"]);
    const found = data.previous.find((t) => t.id === ids[5]);
    return { title: "再弄一次", related: found ? [found.id] : [], dependencies: [], resources: [] };
  };
  let job = submit("上回那个事情再弄一次");
  await tick();
  expect(codex.prompts).toHaveLength(2);
  expect(view(codex.prompts[1]!).data.previous.find((t) => t.id === ids[5])?.source).toBe("search");
  expect(JSON.parse(tasks.get(job.id)!.plan_json!).related).toEqual([ids[5]]);
  expect(events().at(-1)).toMatchObject({ rounds: 2, searches_json: JSON.stringify(["Zephyr", "固件升级"]) });
  expect(recallStats(db, "owner_1", 7, 10)).toMatchObject({ chosenFromSearch: 1, searchRate: 1, avgRounds: 2 });

  // A dispatcher that never stops searching is cut off: two searches, then it must answer.
  codex.prompts = [];
  codex.decide = () => ({ search: ["还要找"] });
  job = submit("随便找找");
  await tick();
  expect(codex.prompts).toHaveLength(3);
  expect(view(codex.prompts[2]!).canSearch).toBe(false);
  expect(tasks.get(job.id)!.status).toBe("planning_failed");
  expect(events().at(-1)).toMatchObject({ rounds: 3, failed: 1 });
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

it("brings the rest of today's tasks, and recalls by today's topics for a terse follow-up", async () => {
  const today = new Date();
  today.setHours(0, 5, 0, 0);
  const old = history(50, { 7: { title: "宝宝疫苗接种时间表", input: "整理宝宝一岁前的疫苗接种时间表", result: "时间表……" } });
  // Twenty tasks today: the recent window shows twelve, the other eight still count as today's context.
  const todays = Array.from({ length: 20 }, (_, i) => `task_today${i}`);
  const insert = db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,status,result,created_at,completed_at) VALUES (?,?,?,?,?,'completed','好',?,?)");
  todays.forEach((id, i) => {
    const title = i === 19 ? "宝宝疫苗接种预约" : `今天的杂事${i}`;
    insert.run(id, id, agent.createConversation({ ownerId: "owner_1", title }).id, title, title, today.getTime() + i * 60_000, today.getTime() + i * 60_000 + 1);
  });
  submit("改一下");
  await tick();
  const previous = view(codex.prompts[0]!).data.previous;
  expect(previous.filter((t) => t.source === "today").map((t) => t.id)).toEqual(todays.slice(0, 8));
  // "改一下" names nothing; today's latest topic (vaccines) brings the older vaccine schedule.
  expect(previous.find((t) => t.id === old[7])?.source).toBe("context");
});

it("keeps recall and search within their budgets however broad the words are", async () => {
  // Every past task mentions reimbursement: any search on it matches all of them.
  history(120, Object.fromEntries(Array.from({ length: 120 }, (_, i) => [i, { title: `发票报销 ${i}`, input: `发票报销 第${i}张 餐饮 交通 酒店`, result: "已报销" }])));
  codex.decide = (p, round) => (round < 3 ? { search: ["发票", "报销", "餐饮"] } : { title: "报销", related: [], dependencies: [], resources: [] });
  submit("发票报销 餐饮 交通 酒店 再来一次");
  await tick();
  const previous = view(codex.prompts.at(-1)!).data.previous;
  expect(previous.filter((t) => t.source === "recall").length).toBeLessThanOrEqual(10);
  expect(previous.filter((t) => t.source === "search").length).toBeLessThanOrEqual(10);
  expect(previous.length).toBeLessThanOrEqual(12 + 10 + 10);
});
