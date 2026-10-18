import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { mockConsole } from "./mock-api";

type MacPage = { id: number; title: string; url: string; owner: "you" | "task" | "none"; holder: "ai" | "human" | null; task: { id: string; title: string } | null };

/** The workspace with its sandbox desktop stubbed, opened on one of its apps. */
async function openWorkspace(page: Page, app: string, mobile: boolean) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/workspace/ticket", (r) => {
    const path = r.request().postDataJSON().next;
    return r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: `http://127.0.0.1:4289${path}`, expiresAt: Date.now() + 60000 } });
  });
  await page.route("http://127.0.0.1:4289/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body>沙箱页面</body></html>" }));
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("tablist", { name: "应用" }).getByRole("tab", { name: app, exact: true }).click();
}

test("the workspace keeps the sandbox browser and the Mac's AI Chrome apart, and asks for a Mac when none is linked", async ({ page }, info) => {
  await page.route("**/api/user-browser/pages", (r) => r.fulfill({ json: { state: "unlinked", pages: [] } }));
  await openWorkspace(page, "Mac 浏览器", info.project.name.startsWith("mobile"));
  const dock = page.getByRole("tablist", { name: "应用" });
  // Two browsers, each with its own name and icon.
  await expect(dock.getByRole("tab", { name: "沙盒浏览器", exact: true })).toBeVisible();
  await expect(dock.getByRole("tab", { name: "Mac 浏览器", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".window-title")).toHaveText("Mac 浏览器");
  await expect(dock.locator('.app-icon[data-app="macBrowser"]')).toHaveCount(1);
  await expect(dock.locator('.app-icon[data-app="browser"]')).toHaveCount(1);
  // On a narrow phone every app still fits in the Dock, without scrolling it.
  if (info.project.name.startsWith("mobile")) {
    await page.setViewportSize({ width: 360, height: 780 });
    await expect.poll(() => dock.evaluate((el) => el.lastElementChild!.getBoundingClientRect().right - el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    expect(await dock.evaluate((el) => el.scrollLeft)).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  const app = page.locator(".mac-browser");
  await expect(app).toContainText("还没有连接 Mac");
  await page.screenshot({ path: info.outputPath("mac-browser-unlinked.png") });
  // The button goes to the Phone app, where a Mac is linked.
  await app.getByRole("button", { name: "去连接 Mac" }).click();
  await expect(dock.getByRole("tab", { name: "手机", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("the Mac browser lists the AI Chrome's pages, shows one live, opens and closes the person's own, and takes a task's over", async ({ page }, info) => {
  const pages: MacPage[] = [
    { id: 2, title: "OpenTable", url: "https://www.opentable.com/r/nopa", owner: "task", holder: "ai", task: { id: "task-7", title: "订周五晚餐" } },
  ];
  const calls: string[] = [];
  await page.route("**/api/user-browser/pages", async (r) => {
    if (r.request().method() === "POST") {
      const { url } = r.request().postDataJSON();
      calls.push(`open ${url}`);
      pages.push({ id: 5, title: "Sign in", url, owner: "you", holder: null, task: null });
      return r.fulfill({ json: { page: 5 } });
    }
    return r.fulfill({ json: { state: "ready", pages } });
  });
  await page.route("**/api/user-browser/pages/*", (r) => {
    calls.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
    pages.splice(pages.findIndex((p) => p.id === 5), 1);
    return r.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/tasks/task-7/user-browser/control", (r) => {
    const { action } = r.request().postDataJSON();
    calls.push(`control ${action}`);
    pages[0]!.holder = action === "take" ? "human" : "ai";
    return r.fulfill({ json: { userBrowser: { page: true, title: "OpenTable", url: pages[0]!.url, holder: pages[0]!.holder, request: null } } });
  });
  const jpeg = fs.readFileSync("src/ui/public/icon-192.png");
  const sent: Array<{ page: string; msg: Record<string, unknown> }> = [];
  await page.routeWebSocket(/\/api\/user-browser\/screen\?page=\d+$/, (ws) => {
    const id = new URL(ws.url()).searchParams.get("page")!;
    ws.send(JSON.stringify({ type: "size", width: 1280, height: 800 }));
    ws.send(jpeg);
    ws.onMessage((m) => sent.push({ page: id, msg: JSON.parse(String(m)) }));
  });
  await openWorkspace(page, "Mac 浏览器", info.project.name.startsWith("mobile"));
  const app = page.locator(".mac-browser");
  const tabs = app.getByRole("tablist", { name: "AI Chrome 里的页面" });

  // A task's page: watched, not used, until taken over.
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab").first()).toContainText("任务：订周五晚餐");
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(app).toContainText("这是任务「订周五晚餐」的页面，只能看");
  await expect(page.locator("canvas.user-browser-picture")).toHaveJSProperty("width", 192);
  await expect(app.getByRole("toolbar", { name: "页面操作" })).toHaveCount(0);
  await expect(app.getByRole("button", { name: "关闭 OpenTable" })).toHaveCount(0);
  await app.getByRole("button", { name: "接管", exact: true }).click();
  await expect.poll(() => calls).toContain("control take");
  await expect(app.getByRole("toolbar", { name: "页面操作" })).toBeVisible();
  await app.getByRole("button", { name: "交还给 AI", exact: true }).click();
  await expect.poll(() => calls).toContain("control release");
  await expect(app.getByRole("toolbar", { name: "页面操作" })).toHaveCount(0);

  // A page of the person's own (signing in first, say): an address without a scheme gets https.
  await app.getByRole("textbox", { name: "网址" }).fill("accounts.example.com/login");
  await app.getByRole("button", { name: "打开", exact: true }).click();
  await expect.poll(() => calls).toContain("open https://accounts.example.com/login");
  const mine = tabs.getByRole("tab", { name: /你的/ });
  await expect(mine).toHaveAttribute("aria-selected", "true");
  await expect(app.getByRole("toolbar", { name: "页面操作" })).toBeVisible();
  await app.getByRole("textbox", { name: "发送到页面的文字" }).fill("me@example.com");
  await app.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => sent.find((s) => s.msg.t === "text")).toEqual({ page: "5", msg: { t: "text", s: "me@example.com" } });
  await page.screenshot({ path: info.outputPath("mac-browser-own-page.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Closing it goes to the Mac; the task's page is selected again.
  await app.getByRole("button", { name: "关闭 Sign in" }).click();
  await expect.poll(() => calls).toContain("DELETE /api/user-browser/pages/5");
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
});
