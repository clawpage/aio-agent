import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mockConsole, openSettingsEntry } from "./mock-api";

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Shots at this project's width, and on a phone also at 360. */
async function shoot(page: Page, info: TestInfo, name: string) {
  const mobile = info.project.name.startsWith("mobile");
  for (const width of mobile ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
  }
}

/** A member's console; `email` null is an account from before email. The account calls are recorded. */
async function member(page: Page, email: string | null) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/auth/session", (r) => r.fulfill({ json: { authenticated: true, username: "lin", role: "member", email } }));
  const state = { email };
  const calls: Array<{ path: string; body: Record<string, string> }> = [];
  await page.route((url) => /^\/api\/account\/(security|email|password)(\/code)?$/.test(url.pathname), async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (r.request().method() === "GET") return r.fulfill({ json: { available: true, email: state.email, minPassword: 12 } });
    const body = (r.request().postDataJSON() ?? {}) as Record<string, string>;
    calls.push({ path, body });
    if (path.endsWith("/code")) return r.fulfill({ json: { ok: true, retryAfter: 60 } });
    if (path === "/api/account/email") {
      if (body.code !== "123456") return r.fulfill({ status: 400, json: { error: "email_code_invalid", message: "验证码不正确" } });
      state.email = body.email!;
      return r.fulfill({ json: { ok: true, email: body.email } });
    }
    return r.fulfill({ json: { ok: true } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/u/lin/settings");
  await openSettingsEntry(page, "邮箱与密码");
  await expect(page).toHaveURL(/\/settings\/security$/);
  return { calls, card: page.getByRole("region", { name: "邮箱与密码" }) };
}

test("an account from before email binds one with a code, then the password form appears", async ({ page }, info) => {
  await page.clock.install();
  const { calls, card } = await member(page, null);
  await expect(card.getByText("这个账号还没有绑定邮箱", { exact: false })).toBeVisible();
  await expect(card.getByLabel("新密码", { exact: true })).toHaveCount(0);
  const send = card.getByRole("button", { name: "发送验证码" });
  const bind = card.getByRole("button", { name: "绑定邮箱" });
  await expect(send).toBeDisabled();
  await card.getByLabel("邮箱", { exact: true }).fill("lin@example.com");
  await send.click();
  await expect(card.getByText("验证码已发到 lin@example.com", { exact: false })).toBeVisible();
  await expect(card.getByRole("button", { name: "60 秒后重发" })).toBeDisabled();
  await shoot(page, info, "bind");
  await expect(bind).toBeDisabled();
  await card.getByLabel("邮箱验证码").fill("12 34 5");
  await expect(card.getByLabel("邮箱验证码")).toHaveValue("12345");
  await expect(bind).toBeDisabled();
  // The server's refusal is shown as written.
  await card.getByLabel("邮箱验证码").fill("654321");
  await bind.click();
  await expect(card.getByRole("alert")).toHaveText("验证码不正确");
  await card.getByLabel("邮箱验证码").fill("123456");
  await bind.click();
  await expect(card.getByText("邮箱已绑定，现在可以修改密码了。")).toBeVisible();
  await expect(card.getByText("已绑定邮箱：lin@example.com")).toBeVisible();
  await expect(card.getByLabel("新密码", { exact: true })).toBeVisible();
  expect(calls.map((c) => c.path)).toEqual(["/api/account/email/code", "/api/account/email", "/api/account/email"]);
  expect(calls.at(-1)!.body).toEqual({ email: "lin@example.com", code: "123456" });
});

test("changes the password with the emailed code", async ({ page }, info) => {
  const { calls, card } = await member(page, "lin@example.com");
  await expect(card.getByText("已绑定邮箱：lin@example.com")).toBeVisible();
  const change = card.getByRole("button", { name: "修改密码" });
  await card.getByLabel("新密码", { exact: true }).fill("brand-new-password");
  await card.getByLabel("确认新密码").fill("brand-new-passwor");
  await expect(card.getByText("两次输入的密码不一样")).toBeVisible();
  await card.getByLabel("确认新密码").fill("brand-new-password");
  await expect(card.getByText("两次输入的密码不一样")).toHaveCount(0);
  // Without a code sent, the form cannot be sent.
  await expect(change).toBeDisabled();
  await card.getByRole("button", { name: "发送验证码" }).click();
  await expect(card.getByText("验证码已发到 lin@example.com", { exact: false })).toBeVisible();
  await card.getByLabel("邮箱验证码").fill("123456");
  await shoot(page, info, "change");
  await change.click();
  await expect(card.getByText("密码已修改，其他设备上的登录已退出。")).toBeVisible();
  await expect(card.getByLabel("新密码", { exact: true })).toHaveValue("");
  expect(calls).toEqual([{ path: "/api/account/password/code", body: {} }, { path: "/api/account/password", body: { password: "brand-new-password", code: "123456" } }]);
});
