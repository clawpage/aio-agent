import { test, expect, type Page } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";
import type { Task, VaultEntry } from "../../src/ui/src/types";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const task = (): Task => ({ id: "task-1", revision: 1, title: "查 OpenTable 订位", text: "登录 OpenTable 看我的订位", conversationId: "child-1", status: "running", result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1001, completedAt: null, browser: { tabs: 1, request: "需要登录 www.opentable.com", human: false } });

async function setup(page: Page, saved: VaultEntry[]) {
  const row = task();
  await mockConsole(page, { conversations: [makeConversation(row.conversationId, row.title)] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [row], nextBefore: null } }));
  const tab = { id: "t1", title: "Sign in", url: "https://www.opentable.com/signin", lastUsed: 1, finishedAt: null, holder: "ai" as "ai" | "human", request: { kind: "login", site: "www.opentable.com", reason: "需要登录 www.opentable.com", at: 1 } as Record<string, unknown> | null };
  await page.route("**/api/tasks/task-1/browser", (r) => r.fulfill({ json: { tabs: [tab] } }));
  await page.route("**/api/tasks/task-1/browser/screenshot*", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  const logins: Array<Record<string, unknown>> = [];
  const controls: string[] = [];
  await page.route("**/api/tasks/task-1/browser/login", async (r) => {
    logins.push(r.request().postDataJSON());
    tab.request = null;
    row.browser = { tabs: 1, request: null, human: false };
    await r.fulfill({ json: { result: "submitted" } });
  });
  await page.route("**/api/tasks/task-1/browser/control", async (r) => {
    const { action } = r.request().postDataJSON();
    controls.push(action);
    tab.holder = action === "take" ? "human" : "ai";
    row.browser = { tabs: 1, request: tab.request ? String(tab.request.reason) : null, human: tab.holder === "human" };
    await r.fulfill({ json: { tab } });
  });
  await page.route("**/api/vault*", (r) => r.fulfill({ json: { entries: saved } }));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  return { logins, controls };
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("a sign-in request asks for the account on the card, and only the outcome comes back", async ({ page }, info) => {
  const { logins } = await setup(page, []);
  const card = page.getByRole("group", { name: "任务浏览器：需要登录" });
  await expect(card.getByTestId("vault-prompt")).toContainText("www.opentable.com");
  await expect(card.getByRole("button", { name: "去浏览器操作" })).toHaveCount(0);
  await card.getByLabel("账号", { exact: true }).fill("max@example.com");
  await card.getByLabel("密码", { exact: true }).fill("s3cret");
  await expect(card.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await page.screenshot({ path: info.outputPath("vault-prompt.png"), fullPage: true });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await card.getByRole("button", { name: "填入并登录" }).click();
  await expect.poll(() => logins.length).toBe(1);
  expect(logins[0]).toEqual({ tab: "t1", username: "max@example.com", password: "s3cret", save: true });
  await expect(page.getByTestId("vault-prompt")).toHaveCount(0);
});

test("a saved account signs in with one tap; skipping hands the page over as before", async ({ page }) => {
  const saved: VaultEntry[] = [{ id: "vault_1", site: "opentable.com", method: "password", username: "max@example.com", createdAt: 1, updatedAt: 1, lastUsedAt: null }];
  const { logins, controls } = await setup(page, saved);
  const card = page.getByRole("group", { name: "任务浏览器：需要登录" });
  await expect(card.getByRole("button", { name: "用 max@example.com 登录" })).toBeVisible();
  await card.getByRole("button", { name: "跳过，自己在浏览器里输入" }).click();
  await expect.poll(() => controls).toEqual(["take"]);
  expect(logins).toEqual([]);
});

test("the vault page lists accounts, shows a password only when asked, and edits and removes them", async ({ page }, info) => {
  const entries: VaultEntry[] = [{ id: "vault_1", site: "github.com", method: "password", username: "max", createdAt: 1, updatedAt: 1, lastUsedAt: Date.UTC(2026, 9, 2) }];
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const scripts = [{ site: "github.com", steps: 4, successes: 3, failures: 1, lastNote: "要短信验证码", updatedAt: 1 }];
  await page.route("**/api/vault**", async (r) => {
    const url = new URL(r.request().url());
    const method = r.request().method();
    if (method === "GET") return r.fulfill({ json: { entries, scripts } });
    const body = method === "DELETE" ? null : r.request().postDataJSON();
    writes.push({ method, path: url.pathname, body });
    if (url.pathname.startsWith("/api/vault/scripts/")) { scripts.length = 0; return r.fulfill({ json: { ok: true } }); }
    if (url.pathname.endsWith("/reveal")) return r.fulfill({ json: { password: "hunter2" } });
    if (method === "POST") { entries.push({ id: "vault_2", site: body.site, method: body.method ?? "password", username: body.username, createdAt: 2, updatedAt: 2, lastUsedAt: null }); return r.fulfill({ status: 201, json: { entry: entries.at(-1) } }); }
    if (method === "DELETE") { entries.splice(entries.findIndex((e) => url.pathname.endsWith(e.id)), 1); return r.fulfill({ json: { ok: true } }); }
    return r.fulfill({ json: { entry: entries[0] } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "密码器", exact: true }).click();
  const vault = page.getByRole("region", { name: "密码器" });
  await expect(vault).toContainText("github.com");
  await expect(vault.getByTestId("vault-password")).toHaveText("••••••••");
  await vault.getByRole("button", { name: "显示密码" }).click();
  await expect(vault.getByTestId("vault-password")).toHaveText("hunter2");
  await vault.getByRole("button", { name: "隐藏密码" }).click();
  await expect(vault.getByTestId("vault-password")).toHaveText("••••••••");

  // The steps the agent wrote for this site, how they fared, and a way to drop them.
  const script = vault.locator('[data-vault-id="vault_1"]').getByTestId("vault-script");
  await expect(script).toContainText("AI 写的登录步骤已记住（4 步，成功 3 次，之后失败 1 次：要短信验证码）");
  await script.getByRole("button", { name: "清除" }).click();
  await expect(script).toContainText("还没有：AI 第一次登录成功后记下");
  expect(writes.some((w) => w.method === "DELETE" && w.path === "/api/vault/scripts/github.com")).toBe(true);

  await vault.getByRole("button", { name: "添加账号" }).click();
  const form = vault.getByRole("form", { name: "添加账号" });
  await form.getByLabel("网站").fill("example.org");
  await form.getByLabel("账号", { exact: true }).fill("me");
  await form.getByLabel("密码", { exact: true }).fill("pw");
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
  await page.screenshot({ path: info.outputPath("vault-page.png"), fullPage: true });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await form.getByRole("button", { name: "保存" }).click();
  await expect(vault).toContainText("example.org");
  expect(writes.find((w) => w.method === "POST" && w.path === "/api/vault")?.body).toEqual({ site: "example.org", method: "password", username: "me", password: "pw" });

  await vault.locator('[data-vault-id="vault_2"]').getByRole("button", { name: "删除" }).click();
  await vault.getByRole("button", { name: "确认删除" }).click();
  await expect(vault).not.toContainText("example.org");
});

test("a site that signs in with Google is answered with one tap and saved without a password", async ({ page }) => {
  const { logins } = await setup(page, []);
  const card = page.getByRole("group", { name: "任务浏览器：需要登录" });
  await card.getByLabel("账号", { exact: true }).fill("max@gmail.com");
  await card.getByRole("button", { name: "用 Google 登录" }).click();
  await expect.poll(() => logins.length).toBe(1);
  expect(logins[0]).toEqual({ tab: "t1", method: "google", username: "max@gmail.com", save: true });
});

test("a saved Google sign-in shows as one, on the card and on the vault page, with no password to show", async ({ page }, info) => {
  const google: VaultEntry = { id: "vault_g", site: "notion.so", method: "google", username: "", createdAt: 1, updatedAt: 1, lastUsedAt: null };
  const { logins } = await setup(page, [google]);
  const card = page.getByRole("group", { name: "任务浏览器：需要登录" });
  await card.getByRole("button", { name: "用 Google 登录", exact: true }).first().click();
  await expect.poll(() => logins).toEqual([{ tab: "t1", entryId: "vault_g" }]);

  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "密码器", exact: true }).click();
  const row = page.getByRole("region", { name: "密码器" }).locator('[data-vault-id="vault_g"]');
  await expect(row).toContainText("用 Google 登录（浏览器里已登录的账号）");
  await expect(row.getByRole("button", { name: "显示密码" })).toHaveCount(0);
  await expect(row.getByTestId("vault-password")).toHaveCount(0);
});

test("the vault page saves a site as Google sign-in, with no password field", async ({ page }, info) => {
  const entries: VaultEntry[] = [];
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  const posted: unknown[] = [];
  await page.route("**/api/vault**", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: { entries } });
    const body = r.request().postDataJSON();
    posted.push(body);
    entries.push({ id: "vault_1", site: body.site, method: body.method, username: body.username, createdAt: 1, updatedAt: 1, lastUsedAt: null });
    return r.fulfill({ status: 201, json: { entry: entries[0] } });
  });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "密码器", exact: true }).click();
  const vault = page.getByRole("region", { name: "密码器" });
  await vault.getByRole("button", { name: "添加账号" }).click();
  const form = vault.getByRole("form", { name: "添加账号" });
  await form.getByLabel("网站").fill("figma.com");
  await form.getByLabel("登录方式").selectOption("google");
  await expect(form.getByLabel("密码", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "保存" }).click();
  await expect(vault).toContainText("用 Google 登录（浏览器里已登录的账号）");
  expect(posted).toEqual([{ site: "figma.com", method: "google", username: "" }]);
});

test("editing an account far down the list opens its form where it is, on screen", async ({ page }, info) => {
  const entries: VaultEntry[] = Array.from({ length: 20 }, (_, i) => ({ id: `vault_${i}`, site: `site-${i}.example`, method: "password" as const, username: `user${i}`, createdAt: i, updatedAt: i, lastUsedAt: null }));
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/vault**", (r) => r.fulfill({ json: { entries, scripts: [] } }));
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "密码器", exact: true }).click();
  const vault = page.getByRole("region", { name: "密码器" });
  const last = vault.locator('[data-vault-id="vault_19"]');
  await last.getByRole("button", { name: "修改" }).click();
  const form = last.getByRole("form", { name: "修改账号" });
  await expect(form.getByLabel("网站")).toHaveValue("site-19.example");
  await expect(form).toBeInViewport();
  await expect(vault.getByRole("form")).toHaveCount(1);
  await form.getByRole("button", { name: "取消" }).click();
  await expect(last.getByRole("button", { name: "修改" })).toBeVisible();
});
