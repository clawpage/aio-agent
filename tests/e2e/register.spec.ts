import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import type { Invite } from "../../src/ui/src/types";

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const inbox = (page: Page) => page.getByRole("heading", { name: "主会话", exact: true });

/** Signed out until the register call succeeds; then the session belongs to the new account. */
async function signedOut(page: Page, opts: { inviteEmail?: string | null; fail?: { status: number; error: string; message: string } } = {}) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  let user: string | null = null;
  const registers: Array<Record<string, string>> = [];
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ json: user ? { authenticated: true, username: user, role: "member" } : { authenticated: false, username: null, inviteEmail: opts.inviteEmail === undefined ? "invitation@clawpage.ai" : opts.inviteEmail } }),
  );
  await page.route("**/api/auth/register", async (r) => {
    const body = r.request().postDataJSON();
    registers.push(body);
    if (opts.fail) return r.fulfill({ status: opts.fail.status, json: { error: opts.fail.error, message: opts.fail.message } });
    user = body.username;
    return r.fulfill({ json: { ok: true, username: body.username, expiresAt: Date.now() + 1e6 } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return registers;
}

test("/register opens the register form; an invite code creates the account and signs it in", async ({ page }, info) => {
  const registers = await signedOut(page);
  await page.goto("/register");
  await expect(page.getByRole("button", { name: "注册并登录" })).toBeDisabled();
  const mail = page.getByRole("link", { name: "invitation@clawpage.ai" });
  await expect(mail).toHaveAttribute("href", /^mailto:invitation@clawpage\.ai\?subject=/);
  await page.getByLabel("账号", { exact: true }).fill("Alice");
  // Self-registered names are lowercase; the field says so by doing it.
  await expect(page.getByLabel("账号", { exact: true })).toHaveValue("alice");
  await page.getByLabel("密码", { exact: true }).fill("alice-password-123");
  await page.getByLabel("确认密码", { exact: true }).fill("alice-password-123");
  await page.getByLabel("邀请码", { exact: true }).fill("abcd-efgh-jkmn");
  await page.screenshot({ path: info.outputPath("register.png"), fullPage: true });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(inbox(page)).toBeVisible();
  expect(registers).toEqual([{ username: "alice", password: "alice-password-123", inviteCode: "ABCD-EFGH-JKMN" }]);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/u/alice");
});

test("mismatched passwords never reach the server, and server refusals are shown as written", async ({ page }) => {
  const registers = await signedOut(page, { fail: { status: 400, error: "invite_used", message: "这个邀请码已经用过了" } });
  await page.goto("/register");
  await page.getByLabel("账号", { exact: true }).fill("bob");
  await page.getByLabel("密码", { exact: true }).fill("bob-password-123");
  await page.getByLabel("确认密码", { exact: true }).fill("bob-password-124");
  await page.getByLabel("邀请码", { exact: true }).fill("ABCD-EFGH-JKMN");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText("两次输入的密码不一样")).toBeVisible();
  expect(registers).toHaveLength(0);
  await page.getByLabel("确认密码", { exact: true }).fill("bob-password-123");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText("这个邀请码已经用过了")).toBeVisible();
  await expect(inbox(page)).toHaveCount(0);
});

test("login and register switch in place, and the address follows", async ({ page }) => {
  await signedOut(page, { inviteEmail: null });
  await page.goto("/");
  await expect(page.getByLabel("确认密码", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "用邀请码注册" }).click();
  await expect(page.getByLabel("邀请码", { exact: true })).toBeVisible();
  // Without a configured address the form points at the administrator instead of a dead link.
  await expect(page.getByText("邀请码向管理员索取")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/register");
  await page.getByRole("button", { name: "去登录" }).click();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByLabel("邀请码", { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/login");
});

test("the owner generates, copies and revokes invite codes on the config page", async ({ page, context }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  if (info.project.name === "desktop") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  const invites: Invite[] = [{ code: "USED-2222-3333", note: "", createdAt: 1, usedAt: 2, usedBy: "cr", revokedAt: null }];
  await page.route("**/api/settings/invites**", async (r) => {
    const req = r.request();
    if (req.method() === "POST") {
      const invite: Invite = { code: "NEW4-5678-9ABC", note: req.postDataJSON().note, createdAt: Date.now(), usedAt: null, usedBy: null, revokedAt: null };
      invites.unshift(invite);
      return r.fulfill({ json: { invite } });
    }
    if (req.method() === "DELETE") {
      const code = decodeURIComponent(new URL(req.url()).pathname.split("/").pop()!);
      invites.find((i) => i.code === code)!.revokedAt = Date.now();
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ json: { invites } });
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".composer textarea")).toBeVisible();
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "配置", exact: true }).click();
  const card = page.getByRole("region", { name: "邀请码" });
  await expect(card.getByText("已被 cr 使用")).toBeVisible();
  await card.getByLabel("备注").fill("friend@example.com");
  await card.getByRole("button", { name: "生成邀请码" }).click();
  const row = card.locator("li", { hasText: "NEW4-5678-9ABC" });
  await expect(row).toContainText("未使用");
  await expect(row).toContainText("friend@example.com");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("invites.png"), fullPage: false });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await row.getByRole("button", { name: "作废" }).click();
  await expect(row).toContainText("已作废");
  await expect(row.getByRole("button", { name: "作废" })).toHaveCount(0);
});
