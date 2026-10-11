import {test, expect, type Page} from "@playwright/test";
import {mockConsole} from "./mock-api";

async function setup(page: Page, pending: boolean) {
  await mockConsole(page, {conversations: []});
  await page.route("**/api/main*", r => r.fulfill({json: {mode: "tasks", tasks: [], nextBefore: null}}));
  let authenticated = false;
  let google = pending ? {email: "member@example.com"} : null;
  const registrations: unknown[] = [];
  await page.route("**/api/auth/session", r => r.fulfill({json: {authenticated, username: authenticated ? "google-member" : null}}));
  await page.route("**/api/auth/google/pending", r => r.fulfill({json: {enabled: true, pending: google}}));
  await page.route("**/api/auth/google/register", r => {
    registrations.push(r.request().postDataJSON()); authenticated = true;
    return r.fulfill({json: {ok: true}});
  });
  await page.route("**/api/auth/google/cancel", r => { google = null; return r.fulfill({json: {ok: true}}); });
  return registrations;
}

test("Google first visit asks for username and invite, without a password, then enters the member inbox", async ({page}, info) => {
  const registrations = await setup(page, true);
  await page.goto("/login?google=invite");
  await expect(page.getByText("member@example.com")).toBeVisible();
  await expect(page.getByLabel("密码", {exact: true})).toHaveCount(0);
  const enter = page.getByRole("button", {name: "验证邀请码并进入"});
  await expect(enter).toBeDisabled();
  await page.getByLabel("账号", {exact: true}).fill("Google-Member");
  await expect(enter).toBeDisabled();
  await page.getByLabel("邀请码", {exact: true}).fill("abcd-efgh-jkmn");
  await page.screenshot({path: info.outputPath("google-invite.png"), fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await enter.click();
  await expect(page.getByRole("heading", {name: "主会话", exact: true})).toBeVisible();
  expect(registrations).toEqual([{username: "google-member", inviteCode: "ABCD-EFGH-JKMN"}]);
});

test("Google login opens the provider and reports a cancelled authorization", async ({page}) => {
  await setup(page, false);
  await page.route("**/api/auth/google/start", r => {
    expect(r.request().postDataJSON()).toEqual({native: false});
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
    expect(r.request().postDataJSON()).toEqual({native: true});
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
