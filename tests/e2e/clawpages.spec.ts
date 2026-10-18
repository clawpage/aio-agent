import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import type { Clawpage, ClawpageRecord } from "../../src/ui/src/types";

const WS = "https://agent-workspace.example.com";
const now = Date.now();
const PAGES: Clawpage[] = [
  {
    name: "lunch-poll", title: "午饭投票", url: `${WS}/u/owner/share/lunch-poll/`, files: 2, bytes: 18_432, updatedAt: now - 3_600_000,
    tables: [
      { name: "votes", permission: "public", records: 3, bytes: 300, createdAt: now - 7_200_000, updatedAt: now - 600_000 },
      { name: "notes", permission: "private", records: 1, bytes: 80, createdAt: now - 7_200_000, updatedAt: now - 900_000 },
    ],
  },
  { name: "tokyo-trip", title: "东京行程", url: `${WS}/u/owner/share/tokyo-trip/`, files: 1, bytes: 9_000, updatedAt: now - 86_400_000, tables: [] },
];
const RECORDS: Record<string, ClawpageRecord[]> = {
  votes: [
    { key: "alice", value: { choice: "noodles" }, createdAt: now - 900_000, updatedAt: now - 900_000 },
    { key: "bob", value: { choice: "rice" }, createdAt: now - 800_000, updatedAt: now - 800_000 },
    { key: "carol", value: { choice: "rice", note: "no spice" }, createdAt: now - 700_000, updatedAt: now - 700_000 },
  ],
  notes: [{ key: "n1", value: { text: "订 12 点的位子" }, createdAt: now - 900_000, updatedAt: now - 900_000 }],
};

async function setup(page: Page, pages = PAGES) {
  const calls: string[] = [];
  let list = structuredClone(pages);
  const records = structuredClone(RECORDS);
  await mockConsole(page, { conversations: [] });
  await page.route((url) => url.pathname === "/api/main", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null, version: "v1" } }));
  await page.route((url) => url.pathname.startsWith("/api/clawpages"), async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
    calls.push(`${req.method()} ${parts.join("/")}`);
    const [name, sub, table, rest, key] = parts;
    if (!name) return r.fulfill({ json: { pages: list } });
    if (sub === "open") return r.fulfill({ json: { url: `${WS}/u/owner/share/${name}/#cp=owner-token` } });
    if (!sub && req.method() === "DELETE") { list = list.filter((p) => p.name !== name); return r.fulfill({ status: 204 }); }
    if (sub === "tables" && rest === "records" && req.method() === "DELETE") {
      records[table!] = records[table!]!.filter((x) => x.key !== key);
      list = list.map((p) => ({ ...p, tables: p.tables.map((t) => t.name === table ? { ...t, records: records[table!]!.length, updatedAt: Date.now() } : t) }));
      return r.fulfill({ status: 204 });
    }
    if (sub === "tables" && req.method() === "PATCH") {
      const permission = (req.postDataJSON() as { permission: string }).permission;
      list = list.map((p) => ({ ...p, tables: p.tables.map((t) => t.name === table ? { ...t, permission: permission as never } : t) }));
      return r.fulfill({ json: list[0]!.tables.find((t) => t.name === table) });
    }
    if (sub === "tables" && req.method() === "GET") return r.fulfill({ json: { records: records[table!] ?? [], nextCursor: null } });
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return calls;
}

test("the clawpages page lists the mini apps with their data, opens one as the owner, and manages its data", async ({ page, context }, info) => {
  const calls = await setup(page);
  await page.goto("/u/owner");
  const mobile = (page.viewportSize()?.width ?? 1440) < 900;
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "Clawpages", exact: true }).click();
  await expect(page).toHaveURL(/\/u\/owner\/clawpages$/);
  await expect(page.getByRole("heading", { name: "Clawpages" })).toBeVisible();
  if (mobile) {
    const menu = (await page.getByRole("button", { name: "打开导航" }).boundingBox())!, title = (await page.getByRole("heading", { name: "Clawpages" }).boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(menu.x + menu.width);
  }

  const poll = page.locator('li[data-page="lunch-poll"]');
  await expect(poll.locator(".clawpage-title")).toHaveText("午饭投票");
  await expect(poll.locator(".clawpage-url")).toHaveText(`${WS}/u/owner/share/lunch-poll/`);
  await expect(poll.locator(".clawpage-chip")).toHaveText(["votes · 公开读写 · 3 条", "notes · 仅自己 · 1 条"]);
  await expect(page.locator('li[data-page="tokyo-trip"] .task-tag')).toHaveText("静态页面");
  await expect(page.locator('li[data-page="tokyo-trip"]').getByRole("button", { name: /^数据/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // The menu has slid away before the picture.
  if (mobile) { await expect(page.locator(".sidebar.show-mobile")).toHaveCount(0); await page.waitForTimeout(500); }
  await page.screenshot({ path: info.outputPath("clawpages-list.png") });

  // Open: an owner link, in a new tab opened by the tap itself.
  await context.route(`${WS}/**`, (r) => r.fulfill({ contentType: "text/html", body: "<p>clawpage</p>" }));
  const [tab] = await Promise.all([context.waitForEvent("page"), poll.getByRole("button", { name: "打开", exact: true }).click()]);
  await expect.poll(() => tab.url()).toContain("/u/owner/share/lunch-poll/#cp=owner-token");
  await tab.close();

  // Data: records of the first table, permission, deleting a record takes two taps.
  await poll.getByRole("button", { name: "数据 · 4" }).click();
  const data = poll.getByTestId("clawpage-data");
  await expect(data.locator(".clawpage-record")).toHaveCount(3);
  await expect(data.locator('.clawpage-record[data-key="carol"] pre')).toContainText('"note": "no spice"');
  await data.getByRole("button", { name: "删除记录 bob" }).click();
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  await data.getByRole("button", { name: "删除记录 bob" }).click();
  await expect(data.locator(".clawpage-record")).toHaveCount(2);
  expect(calls).toContain("DELETE lunch-poll/tables/votes/records/bob");
  await data.getByLabel("谁能访问").selectOption("read-public");
  await expect(poll.locator(".clawpage-chip").first()).toHaveText("votes · 公开只读 · 2 条");
  await data.getByRole("group", { name: "数据表" }).getByRole("button", { name: /^notes/ }).click();
  await expect(data.locator(".clawpage-record")).toHaveText([/订 12 点的位子/]);
  await expect(data.getByRole("link", { name: "导出 JSON" })).toHaveAttribute("href", /\/api\/clawpages\/lunch-poll\/tables\/notes\/export$/);
  await page.screenshot({ path: info.outputPath("clawpages-data.png") });

  // Deleting a page asks first, and says its data goes too.
  const trip = page.locator('li[data-page="tokyo-trip"]');
  await trip.getByRole("button", { name: "删除", exact: true }).click();
  await expect(trip.getByRole("alertdialog")).toContainText("页面里的数据也一起删除");
  await trip.getByRole("button", { name: "确认删除" }).click();
  await expect(trip).toHaveCount(0);
  expect(calls).toContain("DELETE tokyo-trip");
});

test("an account without clawpages is told how to make one", async ({ page }) => {
  await setup(page, []);
  await page.goto("/u/owner/clawpages");
  await expect(page.getByRole("heading", { name: "还没有 clawpage" })).toBeVisible();
  await expect(page.getByText("做个团队午饭投票页")).toBeVisible();
});
