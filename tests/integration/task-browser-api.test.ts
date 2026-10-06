import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import type { TabRecord, TabServerLike } from "../../src/control/browser/tabs.js";

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
  pointer: async (input) => (calls.push(`pointer:${JSON.stringify(input)}`), { status: 200, body: { tab: input.tab ?? "t1" } }),
  open: async (url) => (calls.push(`open:${url}`), { status: 200, body: { tab: { ...record("person", "human"), id: "t7", url } } }),
  close: async (tab) => (calls.push(`close:${tab}`), { status: 200, body: { closed: tab } }),
  login: async () => ({ status: 409, body: { error: "no_request" } }),
  screenshot: async (key, tab) => (calls.push(`shot:${key}:${tab}`), tab === "t1" ? { mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64"), url: "u", title: "t" } : null),
  overview: async () => (calls.push("overview"), [{ target: "A1B2C3D4E5F60718", title: "示例", url: "https://example.com/", tab: "t1", owner: "task", task: "查网页", holder: "ai", front: false }]),
  overviewShot: async (target) => (calls.push(`overview-shot:${target}`), target === "A1B2C3D4E5F60718" ? { mimeType: "image/jpeg", data: Buffer.from("thumb").toString("base64") } : null),
  front: async (target) => (calls.push(`front:${target}`), target === "A1B2C3D4E5F60718" ? { status: 200, body: { target } } : { status: 404, body: { error: "no_page", message: "这个标签页已经关闭" } }),
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

it("types for the person into the tab they took over, and passes the tab server's refusal through", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  expect((await h.request("/api/browser/input", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status).toBe(403);
  expect((await h.request("/api/browser/input", { method: "POST", headers, body: JSON.stringify({}) })).status).toBe(400);
  const refused = await h.request("/api/browser/input", { method: "POST", headers, body: JSON.stringify({ text: "你好", key: "Enter" }) });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { message: string }).message).toContain("请先在任务卡片上点“接管”");
  expect(calls).toContain(`input:${JSON.stringify({ text: "你好", key: "Enter" })}`);
});

it("acts in a task's own tab only for its owner, always naming that task to the tab server", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const task = ((await (await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "登录网站", clientMessageId: "tab-console" }) })).json()) as { task: { id: string } }).task;
  const key = h.ctx.tasks.browserKey(task.id)!;

  await h.request(`/api/tasks/${task.id}/browser/input`, { method: "POST", headers, body: JSON.stringify({ tab: "t1", text: "abc" }) });
  expect(calls).toContain(`input:${JSON.stringify({ text: "abc", task: key, tab: "t1" })}`);
  // A body cannot redirect the action to another task's tabs.
  await h.request(`/api/tasks/${task.id}/browser/input`, { method: "POST", headers, body: JSON.stringify({ task: "conv_other", key: "Enter" }) });
  expect(calls).toContain(`input:${JSON.stringify({ key: "Enter", task: key })}`);
  expect((await h.request(`/api/tasks/${task.id}/browser/input`, { method: "POST", headers, body: JSON.stringify({ tab: "t1" }) })).status).toBe(400);

  expect((await h.request(`/api/tasks/${task.id}/browser/pointer`, { method: "POST", headers, body: JSON.stringify({ tab: "t1", action: "drag" }) })).status).toBe(400);
  expect((await h.request(`/api/tasks/${task.id}/browser/pointer`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ tab: "t1", action: "back" }) })).status).toBe(403);
  const tapped = await h.request(`/api/tasks/${task.id}/browser/pointer`, { method: "POST", headers, body: JSON.stringify({ tab: "t1", action: "click", x: 0.5, y: "0.2" }) });
  expect(tapped.status).toBe(200);
  expect(calls).toContain(`pointer:${JSON.stringify({ task: key, tab: "t1", action: "click", x: 0.5 })}`);

  expect((await h.request("/api/tasks/task_unknown/browser/pointer", { method: "POST", headers, body: JSON.stringify({ tab: "t1", action: "back" }) })).status).toBe(404);
  expect((await h.request("/api/tasks/task_unknown/browser/input", { method: "POST", headers, body: JSON.stringify({ text: "x" }) })).status).toBe(404);
});

it("opens a link from a reply in the person's own tab, and operates only that key's tabs", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const opened = await h.request("/api/browser/tabs", { method: "POST", headers, body: JSON.stringify({ url: "https://example.com/a" }) });
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as { tab: TabRecord }).tab).toMatchObject({ id: "t7", key: "person", holder: "human" });
  expect(calls).toContain("open:https://example.com/a");
  expect((await h.request("/api/browser/tabs", { method: "POST", headers, body: JSON.stringify({ url: "javascript:alert(1)" }) })).status).toBe(400);

  // A body cannot point these routes at a task's key.
  await h.request("/api/browser/person/input", { method: "POST", headers, body: JSON.stringify({ tab: "t7", text: "hi", task: "conv_x" }) });
  expect(calls).toContain(`input:${JSON.stringify({ text: "hi", task: "person", tab: "t7" })}`);
  await h.request("/api/browser/person/pointer", { method: "POST", headers, body: JSON.stringify({ tab: "t7", action: "back" }) });
  expect(calls).toContain(`pointer:${JSON.stringify({ task: "person", tab: "t7", action: "back" })}`);
  expect((await h.request("/api/browser/person/pointer", { method: "POST", headers, body: JSON.stringify({ tab: "t7", action: "drag" }) })).status).toBe(400);
  expect((await h.request("/api/browser/person/screenshot?tab=t1", { headers: { cookie } })).status).toBe(200);
  expect(calls).toContain("shot:person:t1");
  expect((await h.request("/api/browser/person/close", { method: "POST", headers, body: JSON.stringify({ tab: "t7" }) })).status).toBe(200);
  expect(calls).toContain("close:t7");
  expect((await h.request("/api/browser/person/close", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ tab: "t7" }) })).status).toBe(403);
  expect((await h.request("/api/browser/person/screenshot?tab=t1")).status).toBe(401);
});

it("answers the feed without waiting on a stuck sandbox", async () => {
  const { cookie } = await login(h);
  const list = fakeTabs.list;
  fakeTabs.list = () => new Promise(() => undefined);
  try {
    const started = Date.now();
    const res = await h.request("/api/main", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(((await res.json()) as { tasks: Array<{ browser?: unknown }> }).tasks.every((t) => !t.browser)).toBe(true);
  } finally {
    fakeTabs.list = list;
  }
});

it("gives the signed-in person an overview of every open page, a preview of each, and switching to one", async () => {
  const { cookie, csrf } = await login(h);
  expect((await h.request("/api/browser/overview")).status).toBe(401);
  const overview = (await (await h.request("/api/browser/overview", { headers: { cookie } })).json()) as { pages: Array<{ target: string }> };
  expect(overview.pages).toEqual([expect.objectContaining({ target: "A1B2C3D4E5F60718", owner: "task", task: "查网页" })]);
  const shot = await h.request("/api/browser/overview/shot?target=A1B2C3D4E5F60718", { headers: { cookie } });
  expect(shot.status).toBe(200);
  expect(shot.headers.get("content-type")).toContain("image/jpeg");
  expect(shot.headers.get("cache-control")).toBe("no-store");
  expect(await shot.text()).toBe("thumb");
  expect((await h.request("/api/browser/overview/shot?target=0000000000000000", { headers: { cookie } })).status).toBe(404);
  // Switching is a write: CSRF-protected.
  const front = (target: string, headers: Record<string, string>) => h.request("/api/browser/overview/front", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify({ target }) });
  expect((await front("A1B2C3D4E5F60718", {})).status).toBe(403);
  expect((await front("A1B2C3D4E5F60718", { "x-csrf-token": csrf })).status).toBe(200);
  expect((await front("0000000000000000", { "x-csrf-token": csrf })).status).toBe(404);
  expect(calls).toEqual(expect.arrayContaining(["overview", "overview-shot:A1B2C3D4E5F60718", "front:A1B2C3D4E5F60718"]));
});

it("gives one of the account's tasks by id, for a console address that names it", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const task = ((await (await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "按地址打开的任务", clientMessageId: "by-id" }) })).json()) as { task: { id: string } }).task;
  expect((await h.request(`/api/tasks/${task.id}`)).status).toBe(401);
  const res = await h.request(`/api/tasks/${task.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(((await res.json()) as { task: { id: string; text: string } }).task).toMatchObject({ id: task.id, text: "按地址打开的任务" });
  expect((await h.request("/api/tasks/task_unknown", { headers: { cookie } })).status).toBe(404);
});

it("archives one of the account's unconfirmed tasks, and refuses anything else", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const task = ((await (await h.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ text: "待核对的任务", clientMessageId: "archive-api" }) })).json()) as { task: { id: string } }).task;
  const archive = (id: string, extra: Record<string, string> = headers) => h.request(`/api/tasks/${id}/archive`, { method: "POST", headers: extra, body: "{}" });
  expect((await archive(task.id, { cookie, "content-type": "application/json" })).status).toBe(403);
  expect((await archive(task.id)).status).toBe(409);
  h.ctx.db.prepare("UPDATE tasks SET status='unknown' WHERE id=?").run(task.id);
  expect((await archive(task.id)).status).toBe(200);
  expect(h.ctx.tasks.get(task.id)?.status).toBe("interrupted");
  expect((await archive("task_unknown")).status).toBe(404);
});
