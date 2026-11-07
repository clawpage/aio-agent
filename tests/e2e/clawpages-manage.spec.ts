import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import type { Clawpage, ClawpageRecord } from "../../src/ui/src/types";

const WS = "https://agent-workspace.example.com";
const now = Date.now();
/** A game saved as one long JSON value, as a board game page keeps it. */
const GAME = { version: 1, n: 9, komi: 6.5, moves: Array.from({ length: 24 }, (_, i) => ({ i: 20 + i, color: i % 2 ? 2 : 1, at: now - i * 1000 })) };
const PAGES: Clawpage[] = [
  {
    name: "go-class", title: "一手 · 围棋教室", url: `${WS}/u/owner/share/go-class/`, files: 4, bytes: 40_000, updatedAt: now - 3_600_000, updatedBy: null, collaborators: 0, cover: null, offlineAt: null,
    tables: [{ name: "games", permission: "per-user", records: 3, bytes: 9_000, createdAt: now - 86_400_000, updatedAt: now - 600_000 }],
  },
  { name: "old-quiz", title: "旧测验", url: `${WS}/u/owner/share/old-quiz/`, files: 1, bytes: 2_000, updatedAt: now - 86_400_000 * 3, updatedBy: null, collaborators: 0, tables: [], cover: null, offlineAt: now - 86_400_000 },
];
/** A signed-in visitor as the owner sees them: their public id and nickname. */
const by = { id: "6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c", name: "小站" };
const RECORDS: ClawpageRecord[] = [
  { key: "6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.state", value: { game: GAME, human: 1, mode: "coach", review: "黑棋第 12 手可以考虑先补断点，再去抢大场；这一步之后白棋的厚味开始发挥作用。", level: "beginner", extra: "hidden" }, createdAt: now - 900_000, updatedAt: now - 900_000, by },
  { key: "6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.prefs", value: { game: null, human: 2, mode: "play", review: "", level: "easy" }, createdAt: now - 800_000, updatedAt: now - 800_000, by },
  { key: "6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.last", value: { game: { n: 13 }, human: 1, mode: "coach", review: "short", level: "hard" }, createdAt: now - 700_000, updatedAt: now - 700_000, by },
];

/** How the server answers 打开's request for an owner link: at once, never, out of reach (the edge's 502), or the page gone. */
type OpenMode = "ok" | "hang" | "unreachable" | "gone";

async function setup(page: Page, open: OpenMode = "ok") {
  const calls: string[] = [];
  let list = structuredClone(PAGES);
  await mockConsole(page, { conversations: [] });
  await page.route((url) => url.pathname === "/api/main", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null, version: "v1" } }));
  await page.route((url) => url.pathname.startsWith("/api/clawpages"), async (r) => {
    const req = r.request();
    const parts = new URL(req.url()).pathname.split("/").slice(3).map(decodeURIComponent);
    const [name, sub, table] = parts;
    calls.push(`${req.method()} ${parts.join("/")}${req.method() === "PATCH" && !sub ? ` ${req.postData()}` : ""}`);
    if (!name) return r.fulfill({ json: { pages: list } });
    if (!sub && req.method() === "PATCH") {
      const { offline } = req.postDataJSON() as { offline: boolean };
      list = list.map((p) => p.name === name ? { ...p, offlineAt: offline ? Date.now() : null } : p);
      return r.fulfill({ json: list.find((p) => p.name === name) });
    }
    if (!sub && req.method() === "DELETE") { list = list.filter((p) => p.name !== name); return r.fulfill({ status: 204 }); }
    if (sub === "open") {
      if (open === "hang") return; // never answered
      if (open === "unreachable") return r.fulfill({ status: 502, json: { error: "control_unreachable", message: "服务暂时不可用，请稍后重试" } });
      if (open === "gone") return r.fulfill({ status: 404, json: { error: "PAGE_NOT_FOUND", message: "这个页面不存在" } });
      return r.fulfill({ json: { url: `${WS}/u/owner/share/${name}/#cp=owner-token` } });
    }
    if (sub === "collaborators") return r.fulfill({ json: { collaborators: [] } });
    if (sub === "tables" && req.method() === "GET" && table === "games") return r.fulfill({ json: { records: RECORDS, nextCursor: null } });
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return calls;
}
/** The sheet comes in with a motion: measure it where it stops. */
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Whether a box lies inside another (to the pixel). */
const inside = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;

test("a clawpage can be taken offline and put back online from its sheet; offline it says so, on its tile too", async ({ page }, info) => {
  const calls = await setup(page);
  await page.goto("/u/owner/clawpages");
  const list = page.getByTestId("clawpage-list");
  // Offline pages are marked on the home screen.
  await expect(list.locator('li[data-page="old-quiz"] .clawpage-cover-offline')).toHaveText("已下线");
  await expect(list.locator('li[data-page="go-class"] .clawpage-cover-offline')).toHaveCount(0);

  await list.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
  const offline = sheet.getByRole("button", { name: "下线", exact: true });
  const remove = sheet.getByRole("button", { name: "删除这个 clawpage" });
  await settled(page);
  // Both within the sheet's header area, big enough to tap.
  const panel = (await sheet.boundingBox())!;
  for (const button of [offline, remove, sheet.getByRole("button", { name: "打开", exact: true })]) {
    const box = (await button.boundingBox())!;
    expect(inside(box, panel)).toBe(true);
    expect(box.height).toBeGreaterThanOrEqual(36);
  }
  await expect(remove).toHaveClass(/clawpage-danger/);
  expect(await remove.evaluate((el) => getComputedStyle(el).color)).toBe(await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--error)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }));

  await offline.click();
  expect(calls).toContain('PATCH go-class {"offline":true}');
  await expect(sheet.getByRole("button", { name: "重新上线" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "打开", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "复制链接" })).toHaveCount(0);
  await expect(sheet.locator(".clawpage-offline-badge")).toHaveText("已下线");
  await expect(sheet.locator(".clawpage-offline-note")).toContainText("页面文件和数据都还在");
  // Its data stays in reach for the owner.
  await expect(sheet.getByTestId("clawpage-data").locator("tbody tr[data-key]")).toHaveCount(3);
  await expect(list.locator('li[data-page="go-class"] .clawpage-cover-offline')).toHaveText("已下线");
  expect(await noSideways(page)).toBeLessThanOrEqual(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("clawpage-offline.png") });

  await sheet.getByRole("button", { name: "重新上线" }).click();
  expect(calls).toContain('PATCH go-class {"offline":false}');
  await expect(sheet.getByRole("button", { name: "打开", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "下线", exact: true })).toBeVisible();
  await expect(sheet.locator(".clawpage-offline-badge")).toHaveCount(0);
  await expect(list.locator('li[data-page="go-class"] .clawpage-cover-offline')).toHaveCount(0);
});

test("deleting a clawpage asks first, saying its files and every table go for good", async ({ page }, info) => {
  const calls = await setup(page);
  await page.goto("/u/owner/clawpages");
  await page.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
  await sheet.getByRole("button", { name: "删除这个 clawpage" }).click();
  const confirm = sheet.getByRole("alertdialog");
  await settled(page);
  await expect(confirm).toContainText("删除「一手 · 围棋教室」？页面文件、历史版本和 1 张数据表（共 3 条数据）都会删掉，链接立即失效，无法恢复。");
  await expect(confirm).toContainText("只想暂时不让别人访问，用「下线」就好");
  // Asked right below the button, in view without scrolling.
  expect(inside((await confirm.boundingBox())!, (await sheet.boundingBox())!)).toBe(true);
  expect(await noSideways(page)).toBeLessThanOrEqual(0);
  await page.waitForTimeout(200);
  await page.screenshot({ path: info.outputPath("clawpage-delete-confirm.png") });
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toHaveCount(0);
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

  await sheet.getByRole("button", { name: "删除这个 clawpage" }).click();
  await sheet.getByRole("alertdialog").getByRole("button", { name: "确认删除" }).click();
  await expect(sheet).toHaveCount(0);
  expect(calls).toContain("DELETE go-class");
  await expect(page.locator('li[data-page="go-class"]')).toHaveCount(0);

  // An offline page can be deleted too; there is nothing to suggest instead.
  await page.getByRole("button", { name: "打开 旧测验 的详情" }).click();
  const quiz = page.getByRole("dialog", { name: "旧测验" });
  await quiz.getByRole("button", { name: "删除这个 clawpage" }).click();
  await expect(quiz.getByRole("alertdialog")).toContainText("页面文件、历史版本都会删掉");
  await expect(quiz.getByRole("alertdialog")).not.toContainText("下线");
});

for (const width of [390, 360]) {
  test(`at ${width} wide, a clawpage's data keeps one line a cell and scrolls in its own box; a record opens whole`, async ({ page }, info) => {
    test.skip(info.project.name === "desktop" && width !== 390, "one desktop run is enough");
    if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
    else await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await page.goto("/u/owner/clawpages");
    await page.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
    const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
    const data = sheet.getByTestId("clawpage-data");
    await expect(data.locator("thead th")).toHaveText(["时间", "谁写的", "game", "human", "mode", "review", "level", ""]);
    const rows = data.locator("tbody tr[data-key]");
    await expect(rows).toHaveCount(3);
    await settled(page);

    // One line a row, however long the JSON: nothing a character a line.
    const line = await rows.first().locator("td").nth(1).evaluate((td) => parseFloat(getComputedStyle(td).lineHeight) || 20);
    for (let i = 0; i < 3; i++) expect((await rows.nth(i).boundingBox())!.height).toBeLessThanOrEqual(line + 24);
    for (const column of ["谁写的", "human", "mode"]) {
      const th = data.locator("thead th", { hasText: column });
      expect((await th.boundingBox())!.height).toBeLessThanOrEqual(40);
    }
    const game = rows.first().locator("td").nth(2).locator(".clawpage-cell");
    await expect(game).toHaveText(/^\{"version":1/);
    expect(await game.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // The table scrolls sideways in its box, never the page; its box is no taller than about half the screen.
    const wrap = data.locator(".clawpage-table-wrap");
    const viewport = page.viewportSize()!;
    if (viewport.width < 900) expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect((await wrap.boundingBox())!.height).toBeLessThanOrEqual(Math.min(420, viewport.height * 0.55) + 2);
    expect(await noSideways(page)).toBeLessThanOrEqual(0);

    // Five permissions, all inside the panel; on a phone three to a row, each the same width.
    const radios = data.getByRole("radio");
    await expect(radios).toHaveText(["仅自己", "公开只读", "公开读写", "登录后共享", "每人各自"]);
    const panel = (await data.boundingBox())!;
    const boxes = await Promise.all([0, 1, 2, 3, 4].map(async (i) => (await radios.nth(i).boundingBox())!));
    for (const box of boxes) expect(inside(box, panel)).toBe(true);
    if (viewport.width < 900) {
      expect(new Set(boxes.map((b) => Math.round(b.width))).size).toBe(1);
      expect(Math.round(boxes[3]!.x)).toBe(Math.round(boxes[0]!.x));
      for (const box of boxes) expect(box.height).toBeLessThanOrEqual(40);
    }
    // The sheet's own actions are all inside it.
    for (const name of ["打开", "下线", "删除这个 clawpage"]) expect(inside((await sheet.getByRole("button", { name, exact: true }).boundingBox())!, (await sheet.boundingBox())!)).toBe(true);
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath(`clawpage-data-${viewport.width}.png`) });

    // A tap on a row shows the record whole, within the box as far as it is scrolled; another tap folds it.
    await wrap.evaluate((el) => el.scrollTo({ left: 80 }));
    await rows.first().locator("td").nth(3).click();
    const record = data.getByTestId("clawpage-record");
    await expect(record).toBeVisible();
    await expect(rows.first().getByRole("button", { name: "查看完整数据（6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.state）" })).toHaveAttribute("aria-expanded", "true");
    await expect(record.locator("pre")).toContainText('"komi": 6.5');
    await expect(record.locator("pre")).toContainText("这一步之后白棋的厚味开始发挥作用");
    await expect(record).toContainText("键 6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.state");
    const [full, box] = await Promise.all([record.locator(".clawpage-record-full").boundingBox(), wrap.boundingBox()]);
    expect(full!.x).toBeGreaterThanOrEqual(box!.x - 1);
    expect(full!.x + full!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    expect((await record.locator("pre").boundingBox())!.height).toBeLessThanOrEqual(242);
    expect(await noSideways(page)).toBeLessThanOrEqual(0);
    await page.waitForTimeout(200);
    await page.screenshot({ path: info.outputPath(`clawpage-record-${viewport.width}.png`) });
    // Deleting a record does not open it.
    await rows.nth(1).getByRole("button", { name: "删除这条数据（6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.prefs）" }).click();
    await expect(data.getByTestId("clawpage-record")).toContainText("6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.state");
    await rows.first().getByRole("button", { name: "查看完整数据（6a1d3c2e-8f4b-4d7a-9c10-2b3e4f5a6b7c.state）" }).click();
    await expect(data.getByTestId("clawpage-record")).toHaveCount(0);
  });
}

/** The iOS and Android apps' in-app browser: the shell takes the address through this bridge. */
const nativeBrowser = (page: Page) => page.addInitScript(() => {
  (window as unknown as { opened: string[] }).opened = [];
  (window as unknown as { aioDeviceBrowser: { postMessage(url: string): void } }).aioDeviceBrowser = { postMessage: (url) => (window as unknown as { opened: string[] }).opened.push(url) };
});
const nativeOpened = (page: Page) => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

test("in the app, 打开 hands the owner link to the in-app browser at once", async ({ page }) => {
  await nativeBrowser(page);
  const calls = await setup(page);
  await page.goto("/u/owner/clawpages");
  await page.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
  const open = sheet.getByRole("button", { name: "打开", exact: true });
  await open.click();
  await expect.poll(() => nativeOpened(page)).toEqual([`${WS}/u/owner/share/go-class/#cp=owner-token`]);
  expect(calls).toContain("POST go-class/open");
  await expect(open).toBeEnabled();
});

test("in the app, when the server does not answer, 打开 opens the public address within seconds and the button comes back", async ({ page }) => {
  await nativeBrowser(page);
  await setup(page, "hang");
  await page.goto("/u/owner/clawpages");
  await page.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
  const started = Date.now();
  await sheet.getByRole("button", { name: "打开", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "正在打开…" })).toBeDisabled();
  await expect.poll(() => nativeOpened(page), { timeout: 5000 }).toEqual([`${WS}/u/owner/share/go-class/`]);
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(sheet.getByRole("button", { name: "打开", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("on the web, 打开 opens a new tab; with the server out of reach, at the public address", async ({ page, context }) => {
  await context.route(`${WS}/**`, (r) => r.fulfill({ contentType: "text/html", body: "<p>clawpage</p>" }));
  await setup(page, "unreachable");
  await page.goto("/u/owner/clawpages");
  await page.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
  const open = sheet.getByRole("button", { name: "打开", exact: true });
  const [tab] = await Promise.all([context.waitForEvent("page"), open.click()]);
  await expect.poll(() => tab.url()).toBe(`${WS}/u/owner/share/go-class/`);
  await tab.close();
  await expect(open).toBeEnabled();
});

test("打开 on a page deleted meanwhile says so, opens nothing and comes back", async ({ page }) => {
  await nativeBrowser(page);
  await setup(page, "gone");
  await page.goto("/u/owner/clawpages");
  await page.getByRole("button", { name: "打开 一手 · 围棋教室 的详情" }).click();
  const sheet = page.getByRole("dialog", { name: "一手 · 围棋教室" });
  await sheet.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("这个页面不存在");
  await expect(sheet.getByRole("button", { name: "打开", exact: true })).toBeEnabled();
  expect(await nativeOpened(page)).toEqual([]);
});
