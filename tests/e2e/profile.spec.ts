import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mockConsole, openSettingsEntry } from "./mock-api";
import type { Profile } from "../../src/ui/src/types";

// The browser's time zone is what the profile page sends for the location it does not ask for.
test.use({ timezoneId: "Asia/Shanghai" });

const EMPTY: Profile = { nickname: "", preferredName: "", location: "", language: "", occupation: "", interests: "", notes: "" };
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Shots at this project's width, and on a phone also at 360. */
async function shoot(page: Page, info: TestInfo, name: string) {
  const mobile = info.project.name.startsWith("mobile");
  for (const width of mobile ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
  }
}

/** A member who just registered: the session says the profile step is ahead, until it is saved or skipped. */
async function newAccount(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  const state = { profile: { ...EMPTY }, onboarding: true };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/auth/session", (r) => r.fulfill({ json: { authenticated: true, username: "lin", role: "member", onboarding: state.onboarding } }));
  await page.route((url) => url.pathname.startsWith("/api/profile"), async (r) => {
    const req = r.request(), path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, body: req.postDataJSON() });
    if (req.method() === "PUT") { state.profile = { ...EMPTY, ...(req.postDataJSON() as { profile: Profile }).profile }; state.onboarding = false; return r.fulfill({ json: { profile: state.profile, onboarding: false } }); }
    if (path === "/api/profile/skip") { state.onboarding = false; return r.fulfill({ json: { onboarding: false } }); }
    return r.fulfill({ json: state });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return { state, calls };
}

test("a new account starts on its own profile page: four questions, one name for both, where and which language unasked", async ({ page }, info) => {
  const { calls } = await newAccount(page);
  await page.goto("/u/lin");
  const step = page.getByRole("form", { name: "介绍一下你自己" });
  await expect(step).toBeVisible();
  // A page of its own, not a dialog over the console: the console underneath is out of reach until it is done.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".app")).toHaveAttribute("inert", "");
  // Exactly four boxes; one name stands for both the nickname and the form of address, and its hint says a clawpage sees it.
  await expect(step.getByRole("textbox")).toHaveCount(4);
  await expect(step.getByLabel("怎么称呼你")).toHaveAccessibleDescription("助理会这样称呼你；登录 clawpage 页面时，页面看到的也是这个名字");
  for (const label of ["职业或身份", "兴趣", "想让助理注意的事"]) await expect(step.getByLabel(label)).toBeVisible();
  for (const unasked of ["昵称", "希望怎么称呼你", "所在地或时区", "常用语言"]) await expect(step.getByLabel(unasked, { exact: true })).toHaveCount(0);
  // Nothing talks about the sandbox starting.
  await expect(page.getByText(/启动|正在准备|准备中/)).toHaveCount(0);
  await step.getByLabel("怎么称呼你").fill("林老师");
  await step.getByLabel("兴趣").fill("摄影、徒步");
  await step.getByLabel("想让助理注意的事").fill("回答简短一些");
  await shoot(page, info, "onboarding");
  await step.getByRole("button", { name: "完成" }).click();
  await expect(step).toHaveCount(0);
  // The name fills both; the browser's time zone and the console's language go along, for the control plane to fill in where empty.
  expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "PUT", path: "/api/profile", body: {
    profile: { ...EMPTY, nickname: "林老师", preferredName: "林老师", interests: "摄影、徒步", notes: "回答简短一些" },
    browser: { timeZone: "Asia/Shanghai", language: "中文" },
  } }]);
  await expect(page.locator(".app")).not.toHaveAttribute("inert");
  await expect(page.getByText("林老师，你好，我是一站")).toBeVisible();
  await shoot(page, info, "welcome");

  // It comes only once.
  await page.reload();
  await expect(page.getByText("林老师，你好，我是一站")).toBeVisible();
  await expect(page.getByRole("form", { name: "介绍一下你自己" })).toHaveCount(0);
});

test("the profile page can be skipped, and does not come back", async ({ page }, info) => {
  const { calls } = await newAccount(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/u/lin");
  const step = page.getByRole("form", { name: "介绍一下你自己" });
  await step.getByLabel("怎么称呼你").fill("半途");
  await shoot(page, info, "onboarding-dark");
  // Escape is no way out: the step ends only by a choice.
  await page.keyboard.press("Escape");
  await expect(step).toBeVisible();
  await step.getByRole("button", { name: "跳过" }).click();
  await expect(step).toHaveCount(0);
  expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/profile/skip"]);
  await expect(page.getByText("你好，我是一站", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("你好，我是一站", { exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "介绍一下你自己" })).toHaveCount(0);
});

test("every account edits its profile on the settings page", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  let profile: Profile = { ...EMPTY, nickname: "小站", location: "上海" };
  const saves: Profile[] = [];
  let refuse = true;
  await page.route((url) => url.pathname === "/api/profile", async (r) => {
    if (r.request().method() !== "PUT") return r.fulfill({ json: { profile, onboarding: false } });
    const next = (r.request().postDataJSON() as { profile: Profile }).profile;
    saves.push(next);
    // The server's own refusal is shown as written.
    if (refuse) { refuse = false; return r.fulfill({ status: 400, json: { error: "sensitive", message: "资料里像是有密码、验证码、证件号或卡号，请删掉后再保存" } }); }
    profile = next;
    return r.fulfill({ json: { profile, onboarding: false } });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/u/owner/settings");
  await openSettingsEntry(page, "个人资料");
  await expect(page).toHaveURL(/\/u\/owner\/settings\/profile$/);
  const card = page.getByRole("region", { name: "个人资料" });
  await expect(card.getByLabel("昵称")).toHaveValue("小站");
  await expect(card.getByLabel("所在地或时区")).toHaveValue("上海");
  const save = card.getByRole("button", { name: "保存" });
  await expect(save).toBeDisabled();
  await card.getByLabel("职业或身份").fill("产品经理");
  await card.getByLabel("想让助理注意的事").fill("我的密码是 hunter2hunter2");
  await save.click();
  await expect(card.getByRole("alert")).toHaveText("资料里像是有密码、验证码、证件号或卡号，请删掉后再保存");
  await card.getByLabel("想让助理注意的事").fill("买东西先比价");
  await save.click();
  await expect(card.getByRole("status")).toHaveText("已保存");
  await expect(save).toBeDisabled();
  expect(saves.at(-1)).toEqual({ ...EMPTY, nickname: "小站", location: "上海", occupation: "产品经理", notes: "买东西先比价" });
  await shoot(page, info, "settings-profile");
  // Back on the main session the hello uses the nickname (no preferred name given).
  await page.goto("/u/owner");
  await expect(page.getByText("小站，你好，我是一站")).toBeVisible();
});
