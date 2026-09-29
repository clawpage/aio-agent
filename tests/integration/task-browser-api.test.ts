import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import type { TabRecord, TabServerLike } from "../../src/server/browser/tabs.js";

let h: TestHarness;
const calls: string[] = [];
let feedKey = "conv_any";
const record = (key: string, holder: "ai" | "human"): TabRecord => ({
  id: "t1", key, title: "查网页", url: "https://example.com/", createdAt: 1, lastUsed: 1, finishedAt: null, holder, humanSince: null,
  request: holder === "ai" ? { reason: "请登录", at: 1 } : null,
});
const fakeTabs: TabServerLike = {
  ensure: async () => undefined,
  finish: async () => undefined,
  prune: async () => undefined,
  list: async (key) => (calls.push(`list:${key ?? "*"}`), [record(key ?? feedKey, "ai")]),
  control: async (key, tab, action) => (calls.push(`${action}:${key}:${tab}`), tab === "t1" ? record(key, action === "take" ? "human" : "ai") : null),
  input: async (input) => (calls.push(`input:${JSON.stringify(input)}`), { status: 409, body: { error: "task_tab", message: "这个页面正由任务「查网页」操作，请先在任务卡片上点“接管”" } }),
  screenshot: async (key, tab) => (calls.push(`shot:${key}:${tab}`), tab === "t1" ? { mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64"), url: "u", title: "t" } : null),
};

beforeAll(async () => {
  h = await startHarness();
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: ["browser"] }) });
  h.ctx.tabs = fakeTabs;
});
afterAll(async () => {
  await h?.shutdown();
});

it("shows a task's tabs and lets its owner take over and hand back, keyed by the task's execution conversation", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const task = ((await (await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "打开网页", clientMessageId: "tab-api" }) })).json()) as { task: { id: string; conversationId: string } }).task;
  const key = h.ctx.tasks.browserKey(task.id);
  expect(key).toBe(task.conversationId);
  feedKey = key!;
  // The main feed tells every task card whether its agent waits for the person in the browser.
  const feed = (await (await h.request("/api/main", { headers: { cookie } })).json()) as { tasks: Array<{ id: string; browser?: unknown }> };
  expect(feed.tasks.find((t) => t.id === task.id)?.browser).toEqual({ tabs: 1, request: "请登录", human: false });

  expect((await h.request(`/api/tasks/${task.id}/browser`)).status).toBe(401);
  const listed = (await (await h.request(`/api/tasks/${task.id}/browser`, { headers: { cookie } })).json()) as { tabs: TabRecord[] };
  expect(listed.tabs[0]).toMatchObject({ id: "t1", key, request: { reason: "请登录" } });

  const shot = await h.request(`/api/tasks/${task.id}/browser/screenshot?tab=t1`, { headers: { cookie } });
  expect(shot.status).toBe(200);
  expect(shot.headers.get("content-type")).toContain("image/jpeg");
  expect(await shot.text()).toBe("jpeg-bytes");
  expect((await h.request(`/api/tasks/${task.id}/browser/screenshot?tab=t9`, { headers: { cookie } })).status).toBe(404);

  // Taking over is a write: CSRF-protected, and only take/release are accepted.
  expect((await h.request(`/api/tasks/${task.id}/browser/control`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ tab: "t1", action: "take" }) })).status).toBe(403);
  expect((await h.request(`/api/tasks/${task.id}/browser/control`, { method: "POST", headers, body: JSON.stringify({ tab: "t1", action: "close" }) })).status).toBe(400);
  const taken = (await (await h.request(`/api/tasks/${task.id}/browser/control`, { method: "POST", headers, body: JSON.stringify({ tab: "t1", action: "take" }) })).json()) as { tab: TabRecord };
  expect(taken.tab.holder).toBe("human");
  expect((await h.request(`/api/tasks/${task.id}/browser/control`, { method: "POST", headers, body: JSON.stringify({ tab: "t1", action: "release" }) })).status).toBe(200);
  expect(calls).toEqual(expect.arrayContaining([`list:${key}`, `shot:${key}:t1`, `take:${key}:t1`, `release:${key}:t1`]));

  expect((await h.request("/api/tasks/task_unknown/browser", { headers: { cookie } })).status).toBe(404);
});

it("types for the person into the page in front, and passes the tab server's refusal through", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  expect((await h.request("/api/browser/input", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status).toBe(403);
  expect((await h.request("/api/browser/input", { method: "POST", headers, body: JSON.stringify({}) })).status).toBe(400);
  const refused = await h.request("/api/browser/input", { method: "POST", headers, body: JSON.stringify({ text: "你好", key: "Enter" }) });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { message: string }).message).toContain("请先在任务卡片上点“接管”");
  expect(calls).toContain(`input:${JSON.stringify({ text: "你好", key: "Enter" })}`);
});
