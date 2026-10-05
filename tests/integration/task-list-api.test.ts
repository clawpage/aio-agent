import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";

type Page = { counts: Record<string, number>; tasks: Array<{ id: string; status: string; browser?: { request: string | null } }>; nextCursor: string | null };
let h: TestHarness;
let cookie: string;
let owner: string;

/** Rows written straight to the table: the list only reads them, nothing schedules them. */
function insert(id: string, status: string, createdAt: number, extra: { completedAt?: number; ownerId?: string; title?: string; text?: string; result?: string; plan?: object; mergedInto?: string; scheduleId?: string } = {}) {
  const db = h.ctx.db;
  db.prepare("INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run(`conv-${id}`, extra.ownerId ?? owner, id, createdAt, createdAt);
  db.prepare("INSERT INTO tasks (id, client_message_id, conversation_id, title, input_text, status, result, plan_json, merged_into, schedule_id, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `msg-${id}`, `conv-${id}`, extra.title ?? id, extra.text ?? "", status, extra.result ?? null, extra.plan ? JSON.stringify(extra.plan) : null, extra.mergedInto ?? null, extra.scheduleId ?? null, createdAt, extra.completedAt ?? null);
}
const get = async (query: string) => {
  const res = await h.request(`/api/tasks?${query}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Page };
};
const ids = (p: Page) => p.tasks.map((t) => t.id);

beforeAll(async () => {
  h = await startHarness();
  const session = await login(h);
  cookie = session.cookie;
  const csrf = session.csrf;
  const made = await h.request("/api/tasks", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "probe", clientMessageId: "probe-owner" }) });
  const conv = ((await made.json()) as { task: { conversationId: string } }).task.conversationId;
  owner = (h.ctx.db.prepare("SELECT owner_id FROM conversations WHERE id=?").get(conv) as { owner_id: string }).owner_id;
  h.ctx.db.prepare("DELETE FROM tasks").run();
  // Paused, so the scheduler never starts it; only its name is searched.
  h.ctx.db.prepare("INSERT INTO schedules (id, owner_id, title, instruction, spec_json, timezone, status, created_at, updated_at) VALUES ('sched-1', ?, '每日账单检查', 'x', '{}', 'UTC', 'paused', 1, 1)").run(owner);
  insert("done-old", "completed", 100, { completedAt: 200, title: "订东京机票", result: "已订好 ANA 航班" });
  insert("done-new", "completed", 300, { completedAt: 900, text: "帮我看 Reddit 上的推荐" });
  insert("failed", "failed", 400, { completedAt: 800, plan: { description: "整理相册里的照片" } });
  insert("stopped", "interrupted", 500, { completedAt: 700, scheduleId: "sched-1" });
  insert("asking", "needs_input", 50, { plan: { clarification: "几号出发？" } });
  insert("running-old", "running", 20);
  insert("running-new", "running", 600);
  insert("supplement", "merged", 650, { completedAt: 660, mergedInto: "running-new" });
  insert("someone-else", "completed", 950, { completedAt: 960, ownerId: "user_other" });
});
afterAll(async () => { await h?.shutdown(); });

it("counts every task of the account by status on the first page, apart from folded supplements and other accounts", async () => {
  const { status, body } = await get("filter=all&limit=3");
  expect(status).toBe(200);
  expect(body.counts).toEqual({ all: 7, attention: 1, working: 2, done: 2, stopped: 2 });
  // The person's turn, then running work, then newest first by when each finished.
  expect(ids(body)).toEqual(["asking", "running-new", "running-old"]);
  expect(body.nextCursor).toEqual(expect.any(String));
});

it("pages with a cursor through the same order a single page has, without repeats", async () => {
  const whole = ids((await get("filter=all&limit=50")).body);
  expect(whole).toEqual(["asking", "running-new", "running-old", "done-new", "failed", "stopped", "done-old"]);
  const walked: string[] = [];
  let cursor: string | null = null;
  do {
    const { body }: { body: Page } = await get(`filter=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    walked.push(...ids(body));
    cursor = body.nextCursor;
  } while (cursor);
  expect(walked).toEqual(whole);
});

it("filters by status on the server while the counts stay those of every task", async () => {
  const done = (await get("filter=done")).body;
  expect(ids(done)).toEqual(["done-new", "done-old"]);
  expect(done.counts.all).toBe(7);
  expect(ids((await get("filter=stopped")).body)).toEqual(["failed", "stopped"]);
  expect(ids((await get("filter=attention")).body)).toEqual(["asking"]);
});

it("searches title, request, result, description and question, and the counts follow the search", async () => {
  for (const [q, want] of [["东京", ["done-old"]], ["reddit", ["done-new"]], ["ANA", ["done-old"]], ["相册", ["failed"]], ["几号", ["asking"]], ["账单", ["stopped"]], ["100%", []]] as const) {
    const { body } = await get(`filter=all&q=${encodeURIComponent(q)}`);
    expect(ids(body)).toEqual(want);
    expect(body.counts.all).toBe(want.length);
  }
});

it("counts a task whose browser waits on the person as their turn", async () => {
  const tabs = h.ctx.tabs;
  Object.assign(h.ctx, { tabs: { list: async () => [{ key: "conv-running-old", holder: "ai", request: { reason: "请登录 Target" } }] } });
  try {
    const { body } = await get("filter=attention");
    expect(body.counts).toMatchObject({ attention: 2, working: 1 });
    expect(ids(body)).toEqual(["asking", "running-old"]);
    expect(body.tasks[1]!.browser?.request).toBe("请登录 Target");
  } finally {
    Object.assign(h.ctx, { tabs });
  }
});

it("refuses an unknown filter, a forged cursor and a missing login", async () => {
  expect((await get("filter=everything")).status).toBe(400);
  expect((await get(`filter=all&cursor=${Buffer.from("[1,2]").toString("base64url")}`)).status).toBe(400);
  expect((await h.request("/api/tasks")).status).toBe(401);
});
