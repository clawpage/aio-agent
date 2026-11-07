import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const inbox = (page: Page) => page.getByRole("heading", { name: "主会话", exact: true });
type Answer = { status: number; json: Record<string, unknown> };

/** Signed out on a deployment that emails a registration code (`emailCode`); each call's answer can be scripted. */
async function signedOut(page: Page, opts: { emailCode?: boolean; send?: Answer[]; register?: Answer[]; googlePending?: boolean } = {}) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  let user: string | null = null;
  const sends: unknown[] = [];
  const registers: Array<Record<string, string>> = [];
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ json: user ? { authenticated: true, username: user, role: "member" } : { authenticated: false, username: null, registrationRequiresInvite: false, inviteEmail: null, emailCode: opts.emailCode ?? true } }),
  );
  await page.route("**/api/auth/google/pending", (r) => r.fulfill({ json: { enabled: true, pending: opts.googlePending ? { email: "member@example.com" } : null } }));
  await page.route("**/api/auth/register/code", (r) => {
    sends.push(r.request().postDataJSON());
    const answer = opts.send?.shift() ?? { status: 200, json: { ok: true, retryAfter: 60 } };
    return r.fulfill({ status: answer.status, json: answer.json });
  });
  await page.route("**/api/auth/register", (r) => {
    const body = r.request().postDataJSON();
    registers.push(body);
    const answer = opts.register?.shift();
    if (answer) return r.fulfill({ status: answer.status, json: answer.json });
    user = body.email.split("@")[0];
    return r.fulfill({ json: { ok: true, username: user, email: body.email, expiresAt: Date.now() + 1e6 } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return { sends, registers };
}

async function fillAccount(page: Page, email: string) {
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill("carol-password-123");
  await page.getByLabel("确认密码", { exact: true }).fill("carol-password-123");
}

test("sends the code, counts down a minute, and registers with it", async ({ page }, info) => {
  await page.clock.install();
  const { sends, registers } = await signedOut(page);
  await page.goto("/register");
  const send = page.getByRole("button", { name: "发送验证码" });
  const submit = page.getByRole("button", { name: "注册并登录" });
  await expect(send).toBeDisabled();
  await fillAccount(page, "carol@example.com");
  await expect(send).toBeEnabled();
  // Without the code the form cannot be sent.
  await expect(submit).toBeDisabled();
  await send.click();
  expect(sends).toEqual([{ email: "carol@example.com" }]);
  await expect(page.getByText("验证码已发到 carol@example.com，10 分钟内有效。", { exact: false })).toBeVisible();
  const waiting = page.getByRole("button", { name: /秒后重发$/ });
  await expect(waiting).toBeDisabled();
  await expect(waiting).toHaveText("60 秒后重发");
  await page.clock.fastForward(20_000);
  await expect(waiting).toHaveText("40 秒后重发");

  const code = page.getByLabel("邮箱验证码", { exact: true });
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  // Only digits are kept, at most six.
  await code.fill("123 456 78");
  await expect(code).toHaveValue("123456");
  await expect(submit).toBeEnabled();

  for (const [name, width] of [["", 0], ["-360", 360]] as const) {
    if (width && info.project.name === "desktop") continue;
    if (width) await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: info.outputPath(`email-code${name}.png`), fullPage: true });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // The send button stays beside the email box, as tall as it, never below it or overflowing.
    const box = (await page.getByLabel("邮箱", { exact: true }).boundingBox())!;
    const button = (await waiting.boundingBox())!;
    expect(Math.abs(box.y - button.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - button.height)).toBeLessThanOrEqual(1);
    expect(button.x + button.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }

  await page.clock.fastForward(41_000);
  await expect(page.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  await submit.click();
  await expect(inbox(page)).toBeVisible();
  expect(registers).toEqual([{ email: "carol@example.com", password: "carol-password-123", inviteCode: "", emailCode: "123456", timeZone: expect.any(String) }]);
});

test("shows the server's refusals: too frequent with its wait, a wrong code, and a used-up one cleared", async ({ page }) => {
  await page.clock.install();
  const { registers } = await signedOut(page, {
    send: [{ status: 429, json: { error: "email_code_cooldown", message: "验证码发送太频繁，请在 42 秒后再试", retryAfter: 42 } }],
    register: [
      { status: 400, json: { error: "email_code_invalid", message: "验证码不正确" } },
      { status: 400, json: { error: "email_code_expired", message: "验证码已过期，请重新获取" } },
    ],
  });
  await page.goto("/register");
  await fillAccount(page, "dan@example.com");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByText("验证码发送太频繁，请在 42 秒后再试")).toBeVisible();
  await expect(page.getByRole("button", { name: "42 秒后重发" })).toBeDisabled();
  // Refused, so nothing says a code went out.
  await expect(page.getByText("验证码已发到", { exact: false })).toHaveCount(0);

  const code = page.getByLabel("邮箱验证码", { exact: true });
  await code.fill("000000");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText("验证码不正确")).toBeVisible();
  await expect(code).toHaveValue("000000");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText("验证码已过期，请重新获取")).toBeVisible();
  await expect(code).toHaveValue("");
  await expect(inbox(page)).toHaveCount(0);
  expect(registers).toHaveLength(2);
});

test("a deployment that sends no code shows no code step", async ({ page }) => {
  await signedOut(page, { emailCode: false });
  await page.goto("/register");
  await expect(page.getByLabel("确认密码", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送验证码" })).toHaveCount(0);
  await expect(page.getByLabel("邮箱验证码", { exact: true })).toHaveCount(0);
});

test("the login form and a pending Google registration ask for no code", async ({ page }) => {
  await signedOut(page);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送验证码" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await signedOut(page, { googlePending: true });
  await page.goto("/register");
  await expect(page.getByText("member@example.com")).toBeVisible();
  await expect(page.getByLabel("邮箱验证码", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送验证码" })).toHaveCount(0);
});

test("the code step reads well in every language", async ({ page }, info) => {
  await signedOut(page);
  for (const [lang, send] of [["en", "Send code"], ["es", "Enviar código"], ["ja", "コードを送信"], ["zh-TW", "傳送驗證碼"]] as const) {
    await page.addInitScript((l) => { try { localStorage.setItem("aio.locale", l); } catch { /* storage may be off */ } }, lang);
    await page.goto("/register");
    await expect(page.getByRole("button", { name: send })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`email-code-${lang}.png`), fullPage: true });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  }
});
