import { test, expect, type Page } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";
import type { KnowledgeNode, KnowledgeOverview, Task } from "../../src/ui/src/types";

const source = (id: string, task: string, over: Record<string, unknown> = {}) => ({ id, task, path: null, url: null, excerpt: "Roy 3 月 31 日出生", captured: "2026-10-20", ...over });

const roy: KnowledgeNode = {
  id: "kn_roy", kind: "entity", domain: "family", title: "Roy", summary: "家里的宝宝，2026 年 3 月出生。", status: "active", updated: "2026-10-26", reads: 4,
  claims: [
    { id: "c1", text: "Roy 生于 2026-03-31", certainty: "user_said", volatility: "stable", recheck: false, status: "active", supersededBy: null,
      sources: [source("s1", "task-roy"), source("s2", "task-gone", { path: "notes/roy.md", url: "https://example.com/roy-checkup", excerpt: "体检约在 11 月 3 日" })] },
    { id: "c2", text: "Roy 每天睡 14 小时", certainty: "inferred", volatility: "changes", recheck: true, status: "active", supersededBy: null, sources: [] },
    { id: "c3", text: "Roy 喝配方奶 A", certainty: "observed", volatility: "changes", recheck: false, status: "superseded", supersededBy: "c2", sources: [] },
  ],
  links: [{ rel: "part_of", direction: "out", node: "kn_daycare", title: "托儿所安排" }],
  pendingCorrections: [],
  wiki: "## 速查\n\n- **生日**：2026-03-31\n- 儿科：Dr. Lee",
  sourceTasks: { "task-roy": "记录 Roy 的出生信息", "task-gone": null },
};
const daycare: KnowledgeNode = {
  id: "kn_daycare", kind: "fact", domain: "family", title: "托儿所安排", summary: "周一到周五 8 点送。", status: "active", updated: "2026-10-25", reads: 1,
  claims: [{ id: "c4", text: "周一到周五 8:00 送托", certainty: "user_said", volatility: "changes", recheck: false, status: "active", supersededBy: null, sources: [source("s3", "task-roy", { excerpt: "每天 8 点送" })] }],
  links: [{ rel: "part_of", direction: "in", node: "kn_roy", title: "Roy" }],
  pendingCorrections: [{ packet: "p1", type: "outdated", text: "现在改成 8:30 送了", task: "task-roy", at: "2026-10-27" }],
  wiki: null,
  sourceTasks: { "task-roy": "记录 Roy 的出生信息" },
};
const clinic: KnowledgeNode = {
  id: "kn_clinic", kind: "procedure", domain: "health", title: "预约儿科", summary: "在 MyChart 上约 Dr. Lee。", status: "active", updated: "2026-10-22", reads: 0,
  claims: [], links: [], pendingCorrections: [], wiki: null, sourceTasks: {},
};

const task: Task = { id: "task-roy", revision: 1, title: "记录 Roy 的出生信息", text: "记住 Roy 的生日", conversationId: "child-roy", status: "completed", result: "记好了", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1001, completedAt: 1002 };

async function setup(page: Page) {
  const nodes = [roy, daycare, clinic];
  let enabled = true;
  const overview = (): KnowledgeOverview => ({
    enabled,
    domains: ["family", "health", "shopping"].map((name) => ({ name, description: name, nodes: nodes.filter((n) => n.domain === name).length })),
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, domain: n.domain, title: n.title, summary: n.summary, claims: n.claims.length, wiki: !!n.wiki, flagged: n.pendingCorrections.length, updated: n.updated })),
    pending: 2,
  });
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await mockConsole(page, { conversations: [makeConversation(task.conversationId, task.title)] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route((url) => url.pathname === "/api/tasks/task-roy", (r) => r.fulfill({ json: { task } }));
  await page.route((url) => url.pathname.startsWith("/api/knowledge"), async (r) => {
    const { pathname } = new URL(r.request().url());
    const method = r.request().method();
    if (method !== "GET") writes.push({ method, path: pathname, body: method === "POST" ? r.request().postDataJSON() : null });
    if (pathname === "/api/knowledge") return r.fulfill({ json: overview() });
    if (pathname === "/api/knowledge/libraries") return r.fulfill({ json: { libraries: [], presets: { family: "收：家里的事", project: "收：项目的事", blank: "" } } });
    if (pathname === "/api/knowledge/settings") { enabled = r.request().postDataJSON().enabled; return r.fulfill({ json: { enabled } }); }
    const nodeId = /^\/api\/knowledge\/nodes\/([^/]+)$/.exec(pathname)?.[1];
    if (nodeId) {
      const at = nodes.findIndex((n) => n.id === decodeURIComponent(nodeId));
      if (at < 0) return r.fulfill({ status: 404, json: { error: "not_found" } });
      if (method === "DELETE") { nodes.splice(at, 1); return r.fulfill({ json: { ok: true } }); }
      return r.fulfill({ json: { node: nodes[at] } });
    }
    const domain = /^\/api\/knowledge\/domains\/([^/]+)$/.exec(pathname)?.[1];
    if (domain && method === "DELETE") {
      const gone = nodes.filter((n) => n.domain === domain).length;
      for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i]!.domain === domain) nodes.splice(i, 1);
      return r.fulfill({ json: { ok: true, deleted: gone } });
    }
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return { writes };
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the knowledge page lists entries by domain, shows sources and the quick reference, and deletes after confirming", async ({ page }, info) => {
  const { writes } = await setup(page);
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "知识库", exact: true }).click();
  await expect(page).toHaveURL(/\/u\/owner\/knowledge$/);
  const kb = page.getByRole("region", { name: "知识库" });
  await expect(kb).toContainText("每条都标了来源");
  await expect(kb).toContainText("还有 2 条在整理");
  await expect(kb.locator("[data-node-id]")).toHaveCount(3);
  const royRow = kb.locator('[data-node-id="kn_roy"]');
  await expect(royRow).toContainText("人和事物");
  await expect(royRow).toContainText("3 条");
  await expect(royRow).toContainText("速查页");
  await expect(royRow).toContainText("更新于 2026-10-26");
  await expect(kb.locator('[data-node-id="kn_daycare"]')).toContainText("1 条待更正");
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // Domain filter with counts (an empty domain is not offered), and the search box.
  const filters = kb.getByRole("group", { name: "按领域筛选" });
  await expect(filters.getByRole("button")).toHaveText(["全部3", "家庭2", "健康1"]);
  await filters.getByRole("button", { name: "健康" }).click();
  await expect(kb.locator("[data-node-id]")).toHaveCount(1);
  await expect(kb.locator('[data-node-id="kn_clinic"]')).toBeVisible();
  await filters.getByRole("button", { name: "全部" }).click();
  await kb.getByRole("searchbox", { name: "搜索知识" }).fill("8 点");
  await expect(kb.locator("[data-node-id]")).toHaveCount(1);
  await expect(kb.locator('[data-node-id="kn_daycare"]')).toBeVisible();
  await kb.getByRole("searchbox", { name: "搜索知识" }).fill("");

  // The detail: certainty labels, sources with their task, path, address and quote, relations and the wiki.
  await royRow.getByRole("button").click();
  const detail = kb.getByRole("article", { name: "Roy" });
  const c1 = detail.locator('[data-claim-id="c1"]');
  await expect(c1).toContainText("你说的");
  await expect(c1.getByRole("button", { name: "记录 Roy 的出生信息" })).toBeVisible();
  await expect(c1.getByRole("button", { name: "已删除的任务" })).toBeVisible();
  await expect(c1).toContainText("notes/roy.md");
  await expect(c1.getByRole("button", { name: "https://example.com/roy-checkup" })).toBeVisible();
  await expect(c1.locator("blockquote").first()).toHaveText("Roy 3 月 31 日出生");
  await expect(detail.locator('[data-claim-id="c2"]')).toContainText("可能已变化");
  await expect(detail.locator('[data-claim-id="c3"]')).toHaveClass(/superseded/);
  const wiki = detail.getByRole("region", { name: "速查页" });
  await expect(wiki.locator("strong")).toHaveText("生日");
  await expect(wiki.locator("li")).toHaveCount(2);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // A relation opens the other entry, whose pending correction is shown.
  await detail.getByRole("region", { name: "关系" }).getByRole("button", { name: "托儿所安排" }).click();
  const other = kb.getByRole("article", { name: "托儿所安排" });
  await expect(other.getByRole("note", { name: "有待处理的更正" })).toContainText("现在改成 8:30 送了");
  await expect(other.getByRole("note", { name: "有待处理的更正" })).toContainText("可能过时");

  // Deleting asks first; cancelling sends nothing.
  await other.getByRole("button", { name: "删除这条知识" }).click();
  await expect(other.getByRole("alert")).toContainText("永久删除");
  await other.getByRole("button", { name: "取消" }).click();
  expect(writes).toEqual([]);
  await other.getByRole("button", { name: "删除这条知识" }).click();
  await other.getByRole("button", { name: "确认删除" }).click();
  await expect.poll(() => writes.map((w) => `${w.method} ${w.path}`)).toEqual(["DELETE /api/knowledge/nodes/kn_daycare"]);
  await expect(kb.locator("[data-node-id]")).toHaveCount(2);
  await expect(kb.locator('[data-node-id="kn_daycare"]')).toHaveCount(0);

  // A whole domain goes the same way.
  await filters.getByRole("button", { name: "健康" }).click();
  await kb.getByRole("button", { name: "删除「健康」整个领域" }).click();
  await expect(kb.getByRole("alert")).toContainText("将永久删除「健康」下的 1 条知识");
  await kb.getByRole("button", { name: "确认删除" }).click();
  await expect.poll(() => writes.at(-1)?.path).toBe("/api/knowledge/domains/health");
  await expect(kb).toContainText("已删除「健康」下的 1 条知识。");
  await expect(kb.locator("[data-node-id]")).toHaveCount(1);
});

test("the switch turns knowledge off and on, and a source opens its task", async ({ page }) => {
  const { writes } = await setup(page);
  await page.goto("/u/owner/knowledge");
  const kb = page.getByRole("region", { name: "知识库" });
  const toggle = kb.getByRole("checkbox", { name: "整理和使用知识" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => writes).toEqual([{ method: "POST", path: "/api/knowledge/settings", body: { enabled: false } }]);
  await expect(toggle).not.toBeChecked();
  await expect(kb).toContainText("已关闭：不再整理新任务");
  await toggle.check();
  await expect.poll(() => writes.at(-1)?.body).toEqual({ enabled: true });

  await kb.locator('[data-node-id="kn_roy"]').getByRole("button").click();
  await kb.locator('[data-claim-id="c1"]').getByRole("button", { name: "记录 Roy 的出生信息" }).click();
  await expect(page).toHaveURL(/\/u\/owner\/tasks\/task-roy$/);
  await page.getByRole("button", { name: "← 返回知识库" }).click();
  await expect(page).toHaveURL(/\/u\/owner\/knowledge$/);
  // Coming back lands on the entry that was open.
  await expect(page.getByRole("article", { name: "Roy" })).toBeVisible();
});

test("an empty knowledge base says it fills itself from finished tasks", async ({ page }) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route((url) => url.pathname === "/api/knowledge", (r) => r.fulfill({ json: { enabled: true, domains: [], nodes: [], pending: 0 } }));
  await page.goto("/u/owner/knowledge");
  const kb = page.getByRole("region", { name: "知识库" });
  await expect(kb.locator(".empty")).toContainText("还没有内容");
  await expect(kb.locator(".empty")).toContainText("做完任务后会自动整理。");
  await expect(kb).not.toContainText("在整理");
});
