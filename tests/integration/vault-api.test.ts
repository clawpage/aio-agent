import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import type { TabRecord, TabServerLike } from "../../src/control/browser/tabs.js";

const SECRET = "hunter2-密码";
let h: TestHarness;
let headers: Record<string, string>;
let cookie: string;
const logins: Array<{ key: string; tab: string; account: Record<string, string> }> = [];
let tabs: TabRecord[] = [];
const json = async (res: { json(): Promise<unknown> }) => (await res.json()) as Record<string, any>;
const send = (path: string, method: string, body?: unknown, h2 = headers) => h.request(path, { method, headers: h2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(async () => {
  h = await startHarness();
  Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "登录网站", related: [], dependencies: [], resources: ["browser"] }) });
  h.ctx.tabs = {
    list: async (key?: string) => tabs.filter((t) => !key || t.key === key),
    login: async (key: string, tab: string, account: Record<string, string>) => (logins.push({ key, tab, account }), { status: 200, body: { result: "submitted" } }),
  } as unknown as TabServerLike;
  const auth = await login(h);
  cookie = auth.cookie;
  headers = { cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" };
});
afterAll(async () => {
  await h?.shutdown();
});

it("saves, lists, shows, edits and removes accounts for the signed-in person only", async () => {
  expect((await h.request("/api/vault")).status).toBe(401);
  // Saving is a write: without the CSRF token nothing is stored.
  expect((await send("/api/vault", "POST", { site: "github.com", username: "max", password: SECRET }, { cookie, "content-type": "application/json" })).status).toBe(403);
  const created = await send("/api/vault", "POST", { site: "https://github.com/login", username: "max", password: SECRET });
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("no-store");
  const entry = (await json(created)).entry as { id: string };
  expect(entry).toMatchObject({ site: "github.com", username: "max" });
  expect(JSON.stringify(entry)).not.toContain(SECRET);

  // The list never carries a password; one call shows one, to its owner, uncached.
  const listed = await h.request("/api/vault", { headers: { cookie } });
  expect(await listed.text()).not.toContain(SECRET);
  expect((await json(await h.request("/api/vault?site=gist.github.com", { headers: { cookie } }))).entries).toHaveLength(1);
  expect((await json(await h.request("/api/vault?site=example.org", { headers: { cookie } }))).entries).toEqual([]);
  expect((await send(`/api/vault/${entry.id}/reveal`, "POST", {}, { cookie, "content-type": "application/json" })).status).toBe(403);
  const shown = await send(`/api/vault/${entry.id}/reveal`, "POST", {});
  expect(shown.headers.get("cache-control")).toBe("no-store");
  expect(await json(shown)).toEqual({ password: SECRET });

  expect((await json(await send(`/api/vault/${entry.id}`, "PUT", { username: "max2" }))).entry).toMatchObject({ username: "max2", site: "github.com" });
  expect((await send(`/api/vault/${entry.id}`, "PUT", { site: "not a site" })).status).toBe(400);
  expect((await send("/api/vault/vault_missing", "PUT", { username: "x" })).status).toBe(404);
  expect((await send("/api/vault", "POST", { site: "github.com", username: "max", password: "" })).status).toBe(400);

  // Another account never reaches this vault, even when its request lands on this runtime.
  await createMember(h.ctx.db, "vaultmember", "member-password-123");
  const res = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "vaultmember", password: "member-password-123" }) });
  const cookies = res.headers.getSetCookie().map((s) => s.split(";")[0]!);
  const member = { cookie: cookies.join("; "), "x-csrf-token": decodeURIComponent(cookies.find((s) => s.startsWith("pa_csrf="))!.slice(8)), "content-type": "application/json" };
  expect((await h.request("/api/vault", { headers: member })).status).toBe(404);
  expect((await send(`/api/vault/${entry.id}/reveal`, "POST", {}, member)).status).toBe(404);
  expect((await send(`/api/vault/${entry.id}`, "DELETE", undefined, member)).status).toBe(404);

  expect((await send(`/api/vault/${entry.id}`, "DELETE")).status).toBe(200);
  expect((await send(`/api/vault/${entry.id}/reveal`, "POST", {})).status).toBe(404);
  expect((await json(await h.request("/api/vault", { headers: { cookie } }))).entries).toEqual([]);
});

it("answers a task's sign-in request from the vault without the password ever coming back", async () => {
  const task = (await json(await send("/api/tasks", "POST", { text: "登录 example.com 看账单", clientMessageId: "vault-login" }))).task as { id: string };
  const key = h.ctx.tasks.browserKey(task.id)!;
  const waiting: TabRecord = { id: "t1", key, title: "登录网站", url: "https://billing.example.com/signin", createdAt: 1, lastUsed: 1, finishedAt: null, holder: "ai", humanSince: null, request: { kind: "login", site: "billing.example.com", reason: "需要登录 billing.example.com", at: 5 } };
  tabs = [waiting];
  // The card shows a sign-in request, with the site, like any other request for the person.
  expect((await json(await h.request(`/api/tasks/${task.id}/browser`, { headers: { cookie } }))).tabs[0].request).toMatchObject({ kind: "login", site: "billing.example.com" });

  // Typed once in the vault prompt: signed in, and saved for next time.
  const typed = await send(`/api/tasks/${task.id}/browser/login`, "POST", { tab: "t1", username: "max@example.com", password: SECRET });
  expect(typed.status).toBe(200);
  const body = await typed.text();
  expect(JSON.parse(body)).toEqual({ result: "submitted" });
  expect(body).not.toContain(SECRET);
  expect(logins.at(-1)).toEqual({ key, tab: "t1", account: { site: "billing.example.com", username: "max@example.com", password: SECRET } });
  const saved = (await json(await h.request("/api/vault", { headers: { cookie } }))).entries as Array<{ id: string; site: string; lastUsedAt: number | null }>;
  expect(saved).toMatchObject([{ site: "billing.example.com", username: "max@example.com" }]);
  expect(saved[0]!.lastUsedAt).not.toBeNull();

  // Next time: one tap on the saved account.
  expect(await json(await send(`/api/tasks/${task.id}/browser/login`, "POST", { tab: "t1", entryId: saved[0]!.id }))).toEqual({ result: "submitted" });
  expect(logins).toHaveLength(2);

  // Refused: without CSRF, on a tab that is not waiting for a sign-in, with an account for another site, on someone else's task.
  expect((await send(`/api/tasks/${task.id}/browser/login`, "POST", { tab: "t1", entryId: saved[0]!.id }, { cookie, "content-type": "application/json" })).status).toBe(403);
  expect((await send(`/api/tasks/${task.id}/browser/login`, "POST", { tab: "t9", entryId: saved[0]!.id })).status).toBe(404);
  const elsewhere = (await json(await send("/api/vault", "POST", { site: "other.org", username: "max", password: "x" }))).entry as { id: string };
  expect((await send(`/api/tasks/${task.id}/browser/login`, "POST", { tab: "t1", entryId: elsewhere.id })).status).toBe(404);
  tabs = [{ ...waiting, request: { reason: "请输入验证码", at: 6 } }];
  expect((await send(`/api/tasks/${task.id}/browser/login`, "POST", { tab: "t1", entryId: saved[0]!.id })).status).toBe(409);
  expect((await send("/api/tasks/task_missing/browser/login", "POST", { tab: "t1", entryId: saved[0]!.id })).status).toBe(404);
  expect(logins).toHaveLength(2);
});
