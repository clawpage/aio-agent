import {test, expect, type Page} from "@playwright/test";
import {mockConsole} from "./mock-api";

async function setup(page: Page, pending: boolean, requiresInvite = true) {
  await mockConsole(page, {conversations: []});
  await page.route("**/api/main*", r => r.fulfill({json: {mode: "tasks", tasks: [], nextBefore: null}}));
  let authenticated = false;
  let google = pending ? {email: "member@example.com"} : null;
  const registrations: unknown[] = [];
  await page.route("**/api/auth/session", r => r.fulfill({json: {authenticated, username: authenticated ? "google-member" : null, registrationRequiresInvite: requiresInvite}}));
  await page.route("**/api/auth/google/pending", r => r.fulfill({json: {enabled: true, pending: google}}));
  await page.route("**/api/auth/google/register", r => {
    registrations.push(r.request().postDataJSON()); authenticated = true;
    return r.fulfill({json: {ok: true}});
  });
  await page.route("**/api/auth/google/cancel", r => { google = null; return r.fulfill({json: {ok: true}}); });
  return registrations;
}

test("Google first visit asks only for the invite, taking the Google email, then enters the member inbox", async ({page}, info) => {
  const registrations = await setup(page, true);
  await page.goto("/login?google=invite");
  await expect(page.getByText("member@example.com")).toBeVisible();
  await expect(page.getByLabel("密码", {exact: true})).toHaveCount(0);
  const enter = page.getByRole("button", {name: "验证邀请码并进入"});
  await expect(enter).toBeDisabled();
  await expect(page.getByLabel("邮箱", {exact: true})).toHaveCount(0);
  await page.getByLabel("邀请码", {exact: true}).fill("abcd-efgh-jkmn");
  await page.screenshot({path: info.outputPath("google-invite.png"), fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await enter.click();
  await expect(page.getByRole("heading", {name: "主会话", exact: true})).toBeVisible();
  expect(registrations).toEqual([{inviteCode: "ABCD-EFGH-JKMN"}]);
});

test("Google login opens the provider and reports a cancelled authorization", async ({page}) => {
  await setup(page, false);
  await page.route("**/api/auth/google/start", r => {
    expect(r.request().postDataJSON()).toEqual({native: false, timeZone: expect.any(String)});
    return r.fulfill({json: {url: "http://127.0.0.1:4288/login?google=error"}});
  });
  await page.goto("/login");
  await page.getByRole("button", {name: "使用 Google 登录 / 注册"}).click();
  await expect(page.getByText("Google 登录未完成或已过期，请重试。")).toBeVisible();
});

test("native Google sign-in uses the browser bridge and redeems the callback before showing the invite", async ({page}) => {
  await setup(page, false);
  await page.addInitScript(() => {
    (window as any).nativeUrls = [];
    (window as any).aioDeviceBrowser = {postMessage: (url: string) => (window as any).nativeUrls.push(url)};
  });
  await page.route("**/api/auth/google/start", r => {
    expect(r.request().postDataJSON()).toEqual({native: true, timeZone: expect.any(String)});
    return r.fulfill({json: {url: "https://agent.clawpage.ai/api/auth/google/authorize?state=fixture"}});
  });
  await page.route("**/api/auth/google/redeem", r => {
    expect(r.request().postDataJSON()).toEqual({ticket: "one-use-fixture"});
    return r.fulfill({json: {authenticated: false, pending: {email: "native@example.com"}}});
  });
  await page.goto("/login");
  await page.getByRole("button", {name: "使用 Google 登录 / 注册"}).click();
  await expect(page.getByText("请在浏览器中完成 Google 登录，然后返回 App。")).toBeVisible();
  expect(await page.evaluate(() => (window as any).nativeUrls)).toContain("https://agent.clawpage.ai/api/auth/google/authorize?state=fixture");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("aio-google-return", {detail: {ticket: "one-use-fixture"}})));
  await expect(page.getByText("native@example.com")).toBeVisible();
  await expect(page.getByRole("button", {name: "验证邀请码并进入"})).toBeDisabled();
});

test("Google first visit can return to ordinary sign-in without spending an invite", async ({page}) => {
  const registrations = await setup(page, true);
  await page.goto("/login?google=invite");
  await page.getByRole("button", {name: "换一个登录方式"}).click();
  await expect(page.getByLabel("密码", {exact: true})).toBeVisible();
  expect(registrations).toEqual([]);
});

test("Google first visit can register without an invite while places remain", async ({ page }, info) => {
  const registrations = await setup(page, true, false);
  await page.goto("/login?google=invite");
  await expect(page.getByLabel("邀请码", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("google-open-register.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "注册并进入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  expect(registrations).toEqual([{ inviteCode: "" }]);
});

// The iOS shell's system Sign in with Apple, stood in for: it answers with an identity token, or a cancel.
const appleShell = (a: {identityToken?: string; error?: string}) => {
  (window as any).nonces = [];
  (window as any).webkit = {messageHandlers: {aioSaveFiles: {postMessage() {}}, aioAppleSignIn: {postMessage: (nonce: string) => {
    (window as any).nonces.push(nonce);
    setTimeout(() => window.dispatchEvent(new CustomEvent("aio-apple-return", {detail: a})), 50);
  }}}};
};

test("the iOS app signs in with Apple first, then a new Apple ID registers with its own email (App Store rule 4.8)", async ({page}, info) => {
  const registrations = await setup(page, false, false);
  let pending: {email: string} | null = null;
  await page.route("**/api/auth/apple/pending", r => r.fulfill({json: {enabled: true, pending}}));
  await page.route("**/api/auth/apple/start", r => r.fulfill({json: {nonce: "nonce-fixture"}}));
  await page.route("**/api/auth/apple/verify", r => {
    expect(r.request().postDataJSON()).toEqual({identityToken: "signed-by-apple", timeZone: expect.any(String)});
    pending = {email: "abc@privaterelay.appleid.com"};
    return r.fulfill({json: {authenticated: false, pending}});
  });
  const appleRegistrations: unknown[] = [];
  await page.route("**/api/auth/apple/register", async r => {
    appleRegistrations.push(r.request().postDataJSON());
    await page.unroute("**/api/auth/session");
    await page.route("**/api/auth/session", s => s.fulfill({json: {authenticated: true, username: "apple-member"}}));
    return r.fulfill({json: {ok: true}});
  });
  await page.addInitScript(appleShell, {identityToken: "signed-by-apple"});
  await page.goto("/login");
  const apple = page.getByRole("button", {name: "通过 Apple 登录"});
  const google = page.getByRole("button", {name: "使用 Google 登录 / 注册"});
  await expect(apple).toBeVisible();
  await expect(google).toBeVisible();
  // First, and no smaller than Google's.
  const [a, g] = [(await apple.boundingBox())!, (await google.boundingBox())!];
  expect(a.y).toBeLessThan(g.y);
  expect(a.height).toBeGreaterThanOrEqual(g.height);
  expect(a.width).toBeGreaterThanOrEqual(g.width);
  await page.screenshot({path: info.outputPath("apple-login.png"), fullPage: true});
  await apple.click();
  await expect(page.getByText("Apple ID 已验证")).toBeVisible();
  await expect(page.getByText("abc@privaterelay.appleid.com")).toBeVisible();
  expect(await page.evaluate(() => (window as any).nonces)).toEqual(["nonce-fixture"]);
  await page.getByRole("button", {name: "注册并进入"}).click();
  await expect(page.getByRole("heading", {name: "主会话", exact: true})).toBeVisible();
  expect(appleRegistrations).toEqual([{inviteCode: "", timeZone: expect.any(String)}]);
  expect(registrations).toEqual([]);
});

test("backing out of Sign in with Apple leaves the login page as it was, without an error", async ({page}) => {
  await setup(page, false, false);
  await page.route("**/api/auth/apple/pending", r => r.fulfill({json: {enabled: true, pending: null}}));
  await page.route("**/api/auth/apple/start", r => r.fulfill({json: {nonce: "nonce-fixture"}}));
  await page.addInitScript(appleShell, {error: "canceled"});
  await page.goto("/login");
  await page.getByRole("button", {name: "通过 Apple 登录"}).click();
  await expect(page.getByRole("button", {name: "通过 Apple 登录"})).toBeEnabled();
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("the web console, with no iOS shell, shows no Apple button", async ({page}) => {
  await setup(page, false);
  await page.goto("/login");
  await expect(page.getByRole("button", {name: "使用 Google 登录 / 注册"})).toBeVisible();
  await expect(page.getByRole("button", {name: "通过 Apple 登录"})).toHaveCount(0);
});

test("a suspended account's sign-in shows the account notice: Google on the web, and a password", async ({page}, info) => {
  await setup(page, false);
  await page.route("**/api/auth/login", r => r.fulfill({status: 403, json: {error: "account_suspended", message: "账号异常，已停止使用。如有疑问，请发邮件至 feedback@clawpage.ai"}}));
  await page.goto("/login?google=suspended");
  await expect(page.getByText("账号异常，已停止使用。如有疑问，请发邮件至 feedback@clawpage.ai")).toBeVisible();
  await page.screenshot({path: info.outputPath("suspended.png"), fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.goto("/login");
  await page.getByLabel("邮箱", {exact: true}).fill("stopped@example.com");
  await page.getByLabel("密码", {exact: true}).fill("member-password-123");
  await page.getByRole("button", {name: "登录", exact: true}).click();
  await expect(page.getByText("账号异常，已停止使用。如有疑问，请发邮件至 feedback@clawpage.ai")).toBeVisible();
});
