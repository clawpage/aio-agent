import { test, expect, type Page } from "@playwright/test";
import zlib from "node:zlib";
import { mockConsole } from "./mock-api";
import type { Clawpage, ClawpageCollaborator, ClawpageRecord } from "../../src/ui/src/types";

const WS = "https://agent-workspace.example.com";

/** A real PNG (one flat color) for a cover. */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xc8)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}
const COVER = solidPng(96, 128);
const now = Date.now();
const PAGES: Clawpage[] = [
  {
    name: "lunch-poll", title: "午饭投票", url: `${WS}/u/owner/share/lunch-poll/`, files: 2, bytes: 18_432, updatedAt: now - 3_600_000, updatedBy: "Rui 的 Agent", collaborators: 1, cover: 123,
    tables: [
      { name: "votes", permission: "public", records: 3, bytes: 300, createdAt: now - 7_200_000, updatedAt: now - 600_000 },
      { name: "notes", permission: "private", records: 1, bytes: 80, createdAt: now - 7_200_000, updatedAt: now - 900_000 },
    ],
  },
  { name: "tokyo-trip", title: "东京行程", url: `${WS}/u/owner/share/tokyo-trip/`, files: 1, bytes: 9_000, updatedAt: now - 86_400_000, updatedBy: null, collaborators: 0, tables: [], cover: null },
];
const RECORDS: Record<string, ClawpageRecord[]> = {
  votes: [
    { key: "alice", value: { choice: "noodles" }, createdAt: now - 900_000, updatedAt: now - 900_000 },
    { key: "bob", value: { choice: "rice" }, createdAt: now - 800_000, updatedAt: now - 800_000 },
    { key: "carol", value: { choice: "rice", note: "no spice" }, createdAt: now - 700_000, updatedAt: now - 700_000 },
  ],
  notes: [{ key: "n1", value: { text: "订 12 点的位子" }, createdAt: now - 900_000, updatedAt: now - 900_000, by: { id: "user_rui", name: "rui", email: "rui@example.com" } }],
};

async function setup(page: Page, pages = PAGES) {
  const calls: string[] = [];
  let list = structuredClone(pages);
  const records = structuredClone(RECORDS);
  let collaborators: ClawpageCollaborator[] = [{ id: "c1", label: "Rui 的 Agent", createdAt: now - 7_200_000, lastUsedAt: now - 600_000 }];
  await mockConsole(page, { conversations: [] });
  await page.route((url) => url.pathname === "/api/main", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null, version: "v1" } }));
  await page.route((url) => url.pathname.startsWith("/api/clawpages"), async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
    calls.push(`${req.method()} ${parts.join("/")}`);
    const [name, sub, table, rest, key] = parts;
    if (!name) return r.fulfill({ json: { pages: list } });
    if (sub === "cover") return name === "lunch-poll" ? r.fulfill({ contentType: "image/png", body: COVER }) : r.fulfill({ status: 404, json: { error: "not_found" } });
    if (sub === "collaborators" && req.method() === "GET") return r.fulfill({ json: { collaborators: name === "lunch-poll" ? collaborators : [] } });
    if (sub === "collaborators" && req.method() === "POST") {
      const { label } = req.postDataJSON() as { label: string };
      const added = { id: "c2", label, createdAt: Date.now(), lastUsedAt: null };
      collaborators = [...collaborators, added];
      return r.fulfill({ status: 201, json: { ...added, api: `${WS}/u/owner/share/${name}/.api`, invitation: `owner invites your agent…\nCollaborator API: ${WS}/u/owner/share/${name}/.api\nToken: cpc_secret` } });
    }
    if (sub === "collaborators" && req.method() === "DELETE") { collaborators = collaborators.filter((c) => c.id !== table); return r.fulfill({ status: 204 }); }
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

test("the clawpages page is a home screen of mini apps and pages; an icon opens its sheet to open, look through and manage it", async ({ page, context }, info) => {
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

  // One list of clawpages, newest first, whether or not they keep data: an icon, a title, and how much data it holds.
  const list = page.getByTestId("clawpage-list");
  await expect(list.locator("li")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: /小应用|网页/ })).toHaveCount(0);
  const poll = list.locator('li[data-page="lunch-poll"]');
  // Its cover, the page as rendered; on it, how much data the app holds.
  await expect(poll.locator(".clawpage-cover img")).toHaveJSProperty("complete", true);
  expect(await poll.locator(".clawpage-cover img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96);
  expect(calls).toContain("GET lunch-poll/cover");
  await expect(poll.locator(".clawpage-tile-title")).toHaveText("午饭投票");
  await expect(poll.locator(".clawpage-cover-count")).toHaveText("4 条");
  // No cover: the title's first character stands in, and nothing is asked for.
  const trip = list.locator('li[data-page="tokyo-trip"]');
  await expect(trip.locator(".clawpage-cover-glyph")).toHaveText("东");
  await expect(trip.locator(".clawpage-cover-count")).toHaveCount(0);
  expect(calls).not.toContain("GET tokyo-trip/cover");
  // Nothing else on the list: no links, names, sizes or buttons.
  await expect(page.locator(".clawpages-page").getByText("lunch-poll")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (mobile) { await expect(page.locator(".sidebar.show-mobile")).toHaveCount(0); await page.waitForTimeout(500); }
  await page.screenshot({ path: info.outputPath("clawpages-list.png") });

  // The sheet: who it is, open as the owner in a new tab, its data.
  await poll.getByRole("button", { name: "打开 午饭投票 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "午饭投票" });
  await expect(sheet).toContainText("2 张表，4 条数据");
  await expect(sheet.locator(".clawpage-sheet-cover img")).toBeVisible();
  await context.route(`${WS}/**`, (r) => r.fulfill({ contentType: "text/html", body: "<p>clawpage</p>" }));
  const [tab] = await Promise.all([context.waitForEvent("page"), sheet.getByRole("button", { name: "打开", exact: true }).click()]);
  await expect.poll(() => tab.url()).toContain("/u/owner/share/lunch-poll/#cp=owner-token");
  await tab.close();

  // Records as a table: their fields as columns.
  const data = sheet.getByTestId("clawpage-data");
  await expect(data.locator("thead th")).toHaveText(["时间", "choice", "note", ""]);
  await expect(data.locator("tbody tr")).toHaveCount(3);
  await expect(data.locator('tr[data-key="carol"] td').nth(2)).toHaveText("no spice");
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath("clawpages-sheet.png") });
  // Deleting a record takes two taps.
  await data.getByRole("button", { name: "删除这条数据（bob）" }).click();
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  await data.getByRole("button", { name: "删除这条数据（bob）" }).click();
  await expect(data.locator("tbody tr")).toHaveCount(2);
  expect(calls).toContain("DELETE lunch-poll/tables/votes/records/bob");
  // Who has access, as five choices (two for visitors who sign in), all within the sheet even on a phone.
  await expect(data.getByRole("radio")).toHaveText(["仅自己", "公开只读", "公开读写", "登录后共享", "每人各自"]);
  const [segments, panel] = await Promise.all([data.locator(".clawpage-segments").boundingBox(), data.boundingBox()]);
  expect(segments!.x + segments!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
  await data.getByRole("radio", { name: "公开只读" }).click();
  await expect(data.getByRole("radio", { name: "公开只读" })).toHaveAttribute("aria-checked", "true");
  await expect(data.locator(".clawpage-permission-hint")).toHaveText("访客能看、不能改");
  expect(calls).toContain("PATCH lunch-poll/tables/votes");
  await data.getByRole("tab", { name: /^notes/ }).click();
  // A record a signed-in visitor wrote says who.
  await expect(data.locator("thead th")).toHaveText(["时间", "谁写的", "text", ""]);
  await expect(data.locator("tbody tr")).toHaveText([/rui@example\.com.*订 12 点的位子/]);
  await expect(data.getByRole("link", { name: "导出" })).toHaveAttribute("href", /\/api\/clawpages\/lunch-poll\/tables\/notes\/export$/);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Deleting a clawpage asks first, and says its data goes too.
  await list.getByRole("button", { name: "打开 东京行程 的详情" }).click();
  const tripSheet = page.getByRole("dialog", { name: "东京行程" });
  await expect(tripSheet).not.toContainText("网页");
  await expect(tripSheet.locator(".clawpage-sheet-cover .clawpage-cover-glyph")).toHaveText("东");
  await expect(tripSheet.getByTestId("clawpage-data")).toHaveCount(0);
  await tripSheet.getByRole("button", { name: "删除这个 clawpage" }).click();
  await expect(tripSheet.getByRole("alertdialog")).toContainText("里面的数据也一起删除");
  await tripSheet.getByRole("button", { name: "确认删除" }).click();
  await expect(tripSheet).toHaveCount(0);
  await expect(page.locator('li[data-page="tokyo-trip"]')).toHaveCount(0);
  expect(calls).toContain("DELETE tokyo-trip");
});

test("a clawpage's sheet lets the owner invite other people's agents, hands over the invitation once, and removes a collaborator", async ({ page, context }, info) => {
  const calls = await setup(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  await page.goto("/u/owner/clawpages");
  await page.getByRole("button", { name: "打开 午饭投票 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "午饭投票" });
  // Who published the version shown.
  await expect(sheet.locator(".clawpage-sheet-name")).toContainText("由 Rui 的 Agent 更新");
  const collab = sheet.getByTestId("clawpage-collab");
  await expect(collab.getByRole("heading", { name: "让别人的 Agent 一起改" })).toBeVisible();
  await expect(collab.locator('li[data-id="c1"]')).toContainText("Rui 的 Agent");
  await expect(collab.locator('li[data-id="c1"]')).toContainText("最近使用");
  // A name first; then the invitation, with its token, shown once to copy.
  await expect(collab.getByRole("button", { name: "生成邀请" })).toBeDisabled();
  await collab.getByRole("textbox", { name: "协作者名称" }).fill("妈妈的 Agent");
  await collab.getByRole("button", { name: "生成邀请" }).click();
  const invitation = collab.getByTestId("clawpage-invitation");
  await expect(invitation.locator("textarea")).toHaveValue(/Token: cpc_secret/);
  expect(calls).toContain("POST lunch-poll/collaborators");
  await expect(collab.locator('li[data-id="c2"]')).toContainText("还没用过");
  await collab.getByRole("button", { name: "复制邀请" }).click();
  await expect(invitation.getByRole("status")).toHaveText(/邀请已复制|复制失败/);
  await sheet.evaluate((el) => el.querySelector(".clawpage-sheet-body")?.scrollTo(0, 1e6));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("clawpage-collaborators.png") });
  await collab.getByRole("button", { name: "完成" }).click();
  await expect(invitation).toHaveCount(0);
  // Removing takes two taps.
  await collab.getByRole("button", { name: "移除 Rui 的 Agent" }).click();
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  await collab.getByRole("button", { name: "移除 Rui 的 Agent" }).click();
  await expect(collab.locator('li[data-id="c1"]')).toHaveCount(0);
  expect(calls).toContain("DELETE lunch-poll/collaborators/c1");
});

test("an account without clawpages is told how to make one", async ({ page }) => {
  await setup(page, []);
  await page.goto("/u/owner/clawpages");
  await expect(page.getByRole("heading", { name: "还没有 clawpage" })).toBeVisible();
  await expect(page.getByText("做个团队午饭投票")).toBeVisible();
});

test("a clawpage linked in the main session shows as a card with its cover; another account's page has none", async ({ page }, info) => {
  const calls = await setup(page);
  const own = `${WS}/u/owner/share/lunch-poll/`, other = `${WS}/u/someone/share/lunch-poll/`;
  const task = { id: "task-1", revision: 1, title: "做个午饭投票", text: "做个午饭投票", conversationId: "child-1", status: "completed",
    result: `做好了：[午饭投票](${own})\n\n参考了别人的 [投票页](${other})。`, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: now - 60_000, completedAt: now };
  await page.route((url) => url.pathname === "/api/main", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task], nextBefore: null, version: "v1" } }));
  await page.goto("/u/owner");
  const cards = page.getByTestId("share-card");
  await expect(cards).toHaveCount(2);
  const mine = cards.filter({ hasText: "午饭投票" }).first();
  await expect(mine.getByTestId("share-card-cover")).toBeVisible();
  expect(await mine.getByTestId("share-card-cover").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96);
  await expect(mine.getByTestId("share-card-url")).toHaveText(own);
  await expect(mine.getByRole("link", { name: "打开" })).toHaveAttribute("href", own);
  // A strip, not a poster: the thumbnail beside the text keeps the card short on a phone too.
  const box = (await mine.boundingBox())!, thumb = (await mine.getByTestId("share-card-cover").boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(160);
  expect(thumb.width).toBeLessThanOrEqual(100);
  // Someone else's page: the card, but no cover asked for under this account's name.
  const theirs = cards.filter({ hasText: "投票页" });
  await expect(theirs.getByTestId("share-card-url")).toHaveText(other);
  await expect(theirs.getByTestId("share-card-cover")).toHaveCount(0);
  expect(calls.filter((c) => c === "GET lunch-poll/cover")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.locator(".boot-cover")).toHaveCount(0);
  await mine.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath("share-card-cover.png") });
});
