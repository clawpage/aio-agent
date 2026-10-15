import { afterAll, beforeAll, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { postSupportCard } from "../../src/control/tasks/support.js";

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h?.shutdown(); });

type FeedTask = { id: string; title: string; text: string; status: string; result: string | null; support?: boolean; clientMessageId: string };
const feed = async (cookie: string) => ((await (await h.request("/api/main", { headers: { cookie } })).json()) as { tasks: FeedTask[] }).tasks;

it("puts a support card in the account's feed as a finished answer that nobody typed", async () => {
  const { cookie, csrf } = await login(h);
  await h.request("/api/tasks", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "改一下辅食表", clientMessageId: "before-support" }) });
  const body = "表格已经重做好了。\n\n![辅食表](/home/gem/workspace/tasks/roy-week1-html/roy-week1.png)";
  const card = postSupportCard(h.ctx.db, { ownerId: "owner_1", title: "辅食表清晰版", body, key: "roy-week1", cwd: "/home/gem/workspace" });
  expect(card.duplicate).toBe(false);
  const tasks = await feed(cookie);
  const shown = tasks.find((t) => t.id === card.taskId)!;
  expect(shown).toMatchObject({ title: "辅食表清晰版", text: "", status: "completed", result: body, support: true, clientMessageId: "support:roy-week1" });
  // It comes after everything already in the feed, like a message sent now.
  expect(tasks.at(-1)?.id).toBe(card.taskId);
  expect(tasks.find((t) => t.clientMessageId === "before-support")?.support).toBe(false);
  // Posting again under the same key keeps the one card.
  expect(postSupportCard(h.ctx.db, { ownerId: "owner_1", title: "辅食表清晰版", body, key: "roy-week1", cwd: "/home/gem/workspace" })).toEqual({ ...card, duplicate: true });
  expect((await feed(cookie)).filter((t) => t.support)).toHaveLength(1);
});

it("refuses a key used for another account and out-of-range cards", () => {
  const cwd = "/home/gem/workspace";
  postSupportCard(h.ctx.db, { ownerId: "owner_1", title: "通知", body: "正文", key: "shared-key", cwd });
  expect(() => postSupportCard(h.ctx.db, { ownerId: "user_other", title: "通知", body: "正文", key: "shared-key", cwd })).toThrow("另一个账号");
  expect(() => postSupportCard(h.ctx.db, { ownerId: "owner_1", title: " ", body: "正文", cwd })).toThrow("标题");
  expect(() => postSupportCard(h.ctx.db, { ownerId: "owner_1", title: "通知", body: "x".repeat(20_001), cwd })).toThrow("正文");
  expect(() => postSupportCard(h.ctx.db, { ownerId: "owner_1", title: "通知", body: "正文", key: "bad key", cwd })).toThrow("--id");
});
