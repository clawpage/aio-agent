import { beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/control/db.js";
import { RECALL_CAP, recallStats, recordRecall, TaskRecall, tokenize, type RecallDoc } from "../../src/control/tasks/recall.js";

let db: Db, recall: TaskRecall;
const TOPICS = ["周报整理", "发票报销", "租房合同", "健身计划", "学英语", "宝宝辅食", "家庭预算", "装修报价", "体检预约", "车险续保", "读书笔记", "照片整理"];
/** Hundreds of past tasks on everyday topics, then the one a later message means. */
function seed(owner = "owner_1", n = 300): RecallDoc[] {
  const docs: RecallDoc[] = Array.from({ length: n }, (_, i) => ({ id: `task_${owner}_${i}`, ownerId: owner, title: `${TOPICS[i % TOPICS.length]} 第${i}次`, body: `帮我处理一下${TOPICS[i % TOPICS.length]}，按上次的格式整理`, result: `已完成${TOPICS[i % TOPICS.length]}` }));
  return docs;
}
beforeEach(() => {
  db = openDb(":memory:");
  recall = new TaskRecall(db);
});

it("splits Chinese into bigrams and keeps latin words and numbers, without filler bigrams", () => {
  expect(tokenize("杭州西湖亲子游 Plan v2")).toEqual(["杭州", "州西", "西湖", "湖亲", "亲子", "子游", "plan", "v2"]);
  expect(tokenize("帮我看一下")).toEqual(["我看", "看一"]);
  expect(tokenize("a 7 猫")).toEqual(["7", "猫"]);
});

it("finds a task hundreds back by what the message says, and only the clear matches", () => {
  const docs = seed();
  docs.splice(40, 0, { id: "task_trip", ownerId: "owner_1", title: "杭州西湖亲子三日游行程", body: "带两岁宝宝去杭州西湖玩三天，住在湖滨附近", result: "三天行程：第一天西湖游船……" });
  recall.sync(docs);
  const hits = recall.search("owner_1", "把之前杭州西湖那个行程改成四天", { cap: 10 });
  expect(hits[0]?.id).toBe("task_trip");
  // One clear match brings one task, not the cap's worth of weak ones.
  expect(hits.length).toBeLessThan(10);
  expect(recall.search("owner_1", "发票报销").length).toBeLessThanOrEqual(RECALL_CAP);
  expect(recall.search("owner_1", "完全无关的量子力学")).toEqual([]);
  // The clear match already in view does not make the weak ones behind it look good.
  expect(recall.search("owner_1", "把之前杭州西湖那个行程改成四天", { exclude: new Set(["task_trip"]) })).toEqual([]);
});

it("keeps each account's tasks to itself and follows edits and merges", () => {
  recall.sync([...seed("owner_1", 20), { id: "task_other", ownerId: "owner_2", title: "杭州西湖行程", body: "别人的行程", result: null }]);
  expect(recall.search("owner_1", "杭州西湖行程")).toEqual([]);
  expect(recall.search("owner_2", "杭州西湖行程").map((h) => h.id)).toEqual(["task_other"]);

  recall.sync([{ id: "task_other", ownerId: "owner_2", title: "杭州西湖行程", body: "补充：改住灵隐寺附近", result: null }]);
  expect(recall.search("owner_2", "灵隐寺").map((h) => h.id)).toEqual(["task_other"]);
  recall.forget(["task_other"]);
  expect(recall.search("owner_2", "灵隐寺")).toEqual([]);
});

it("measures hand-picked tasks against the cap recall actually uses", () => {
  const event = (rank: number | null, inWindow = false) =>
    recordRecall(db, { taskId: "t", ownerId: "owner_1", candidates: [], searches: [], rounds: 1, chosen: { related: [], appendTo: null }, gold: { id: "g", rank, inWindow }, latencyMs: 10, promptChars: 100, failed: false });
  event(1); event(RECALL_CAP); event(RECALL_CAP + 1); event(null);
  // Picks inside the recent window say nothing about recall and do not count.
  event(40, true);
  expect(recallStats(db, "owner_1", 7)).toMatchObject({ dispatches: 5, labelled: 4, recallAtCap: 0.5, cap: RECALL_CAP });
});

it("adds the failure reason and repair columns to a monitoring table from before they existed", () => {
  const file = `${fs.mkdtempSync(path.join(os.tmpdir(), "recall-"))}/db.sqlite`;
  const old = openDb(file);
  old.exec("DROP TABLE recall_events; CREATE TABLE recall_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, candidates_json TEXT NOT NULL, searches_json TEXT NOT NULL, rounds INTEGER NOT NULL, chosen_json TEXT NOT NULL, gold_task_id TEXT, gold_rank INTEGER, gold_in_window INTEGER, latency_ms INTEGER NOT NULL, prompt_chars INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0)");
  old.close();
  const upgraded = openDb(file);
  recordRecall(upgraded, { taskId: "t", ownerId: "owner_1", candidates: [], searches: [], rounds: 2, chosen: { related: [], appendTo: null }, gold: null, latencyMs: 1, promptChars: 1, failed: false, repairs: ["related 共 20 个，只保留 12 个"] });
  expect(recallStats(upgraded, "owner_1", 7, 10)).toMatchObject({ dispatches: 1, failed: 0, repaired: 1 });
  upgraded.close();
});
