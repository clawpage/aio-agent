import { test, expect, type Page } from "@playwright/test";
import { mockConsole, mockTaskList } from "./mock-api";

const schedule = (over: Record<string, unknown> = {}) => ({
  id: "sched-1", title: "每日天气提醒", instruction: "查旧金山今天的天气，提醒是否需要带伞", rule: "每天 08:00", status: "active",
  timezone: "America/Los_Angeles", nextRunAt: Date.now() + 3600_000, nextRunText: "10月3日 周六 08:00", lastRunAt: Date.now() - 86400_000,
  lastTask: { id: "task-run", status: "completed" }, runCount: 3, createdAt: Date.now() - 3 * 86400_000, ...over,
});
const run = { id: "task-run", revision: 1, title: "每日天气提醒", text: "查旧金山今天的天气，提醒是否需要带伞", conversationId: "child-run", status: "completed",
  result: "今天晴，不用带伞。", error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 600_000, completedAt: Date.now() - 500_000,
  schedule: { id: "sched-1", title: "每日天气提醒", rule: "每天 08:00" } };

async function setup(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [run], nextBefore: null } }));
  await mockTaskList(page, () => [run]);
  let items = [schedule(), schedule({ id: "sched-2", title: "价格监控", rule: "每 2 小时", status: "paused", nextRunText: null, lastTask: null, runCount: 0 }),
    schedule({ id: "sched-feed", title: "每日推送", instruction: "每天看一下 Gmail 有没有要交的账单，少说新闻", builtin: "daily_feed", lastTask: null, runCount: 0,
      feed: { customized: true, memory: [{ id: "fm1", kind: "care", text: "Roy 的疫苗和体检预约", source: "user" }, { id: "fm2", kind: "avoid", text: "加密货币行情", source: "feed" }] } })];
  const actions: string[] = [];
  await page.route("**/api/schedules", (r) => r.fulfill({ json: { schedules: items } }));
  await page.route("**/api/schedules/*/*", (r) => {
    const [, id, action] = /schedules\/([^/]+)\/([^/?]+)/.exec(r.request().url())!;
    actions.push(`${id}:${action}`);
    if (action === "cancel") items = items.filter((s) => s.id !== id);
    else if (action === "pause" || action === "resume") items = items.map((s) => (s.id === id ? { ...s, status: action === "pause" ? "paused" : "active" } : s));
    return r.fulfill({ json: { message: action === "pause" ? "已暂停定时任务「每日天气提醒」。" : action === "resume" ? "已恢复定时任务「价格监控」，下次运行 10月2日 周五 20:00。" : "已取消", schedule: items.find((s) => s.id === id) ?? null } });
  });
  await page.goto("/");
  return { actions };
}

test("a scheduled run shows as an automatic run, not as something you typed", async ({ page }, info) => {
  await setup(page);
  const note = page.locator(".schedule-run-note");
  await expect(note).toContainText("定时任务「每日天气提醒」自动运行 · 每天 08:00", { timeout: 60_000 });
  await expect(page.locator(".msg.user")).toHaveCount(0);
  await expect(page.locator(".schedule-badge")).toHaveText("定时 · 每天 08:00");
  await expect(page.getByText("今天晴，不用带伞。")).toBeVisible();
  await page.screenshot({ path: info.outputPath("schedule-run.png") });
});

test("the schedules page lists rules and pauses, resumes, runs and deletes them", async ({ page }, info) => {
  const { actions } = await setup(page);
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
  const list = page.getByRole("region", { name: "定时任务" });
  const weather = list.locator('[data-schedule-id="sched-1"]');
  await expect(weather).toContainText("每天 08:00 · 下次 10月3日 周六 08:00");
  await expect(weather).toContainText("已运行 3 次");
  await expect(weather.locator(".task-status-badge")).toHaveText("进行中");
  await expect(list.locator('[data-schedule-id="sched-2"] .task-status-badge')).toHaveText("已暂停");
  await expect(list).toContainText("在主会话里直接说就能创建");
  // The built-in daily feed can be paused or run, never deleted.
  const builtin = list.locator('[data-schedule-id="sched-feed"]');
  await expect(builtin).toContainText("内置");
  // The feed shows the person's own instruction; how it works and what it keeps in mind are folded to counts,
  // and open to the entries, learnt ones marked as such.
  await expect(builtin.locator(".task-list-summary")).toHaveText("你的要求每天看一下 Gmail 有没有要交的账单，少说新闻");
  const more = builtin.locator(".schedule-feed-more > summary");
  await expect(more).toHaveText("说明与记住的 2 条关心 1不再推 1");
  await expect(builtin.getByText("前一天发过消息才会推送")).toBeHidden();
  await more.click();
  await expect(builtin.getByText("前一天发过消息才会推送")).toBeVisible();
  const memory = builtin.getByRole("list", { name: "推送记住的内容" }).getByRole("listitem");
  await expect(memory).toHaveText(["关心Roy 的疫苗和体检预约", "不再推加密货币行情 · 从你的反馈学到"]);
  await expect(builtin.getByRole("button", { name: "删除" })).toHaveCount(0);
  await expect(builtin.getByRole("button", { name: "暂停" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("schedules.png") });

  await weather.getByRole("button", { name: "暂停" }).click();
  await expect(list.getByRole("status")).toContainText("已暂停定时任务「每日天气提醒」");
  await expect(weather.locator(".task-status-badge")).toHaveText("已暂停");
  await list.locator('[data-schedule-id="sched-2"]').getByRole("button", { name: "恢复" }).click();
  await expect(list.locator('[data-schedule-id="sched-2"] .task-status-badge')).toHaveText("进行中");
  await weather.getByRole("button", { name: "立即运行一次" }).click();
  await expect(list.getByRole("status")).toContainText("已开始运行，结果会出现在主会话");
  await weather.getByRole("button", { name: "删除" }).click();
  await expect(weather).toContainText("删除后不会再运行");
  await weather.getByRole("button", { name: "确认删除" }).click();
  await expect(list.locator('[data-schedule-id="sched-1"]')).toHaveCount(0);
  expect(actions).toEqual(["sched-1:pause", "sched-2:resume", "sched-1:run", "sched-1:cancel"]);
  if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test("a schedule is edited on the page: several times a day, or a few irregular dates", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await mockTaskList(page, () => []);
  let item: ReturnType<typeof schedule> & { spec?: unknown; needsBrowser?: boolean } = schedule({ spec: { kind: "daily", at: "08:00" }, needsBrowser: true });
  const sent: Array<Record<string, unknown>> = [];
  await page.route("**/api/schedules", (r) => r.fulfill({ json: { schedules: [item] } }));
  await page.route("**/api/schedules/sched-1", (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown> & { schedule: { kind: string; times?: string[]; dates?: string[] } };
    expect(r.request().method()).toBe("PATCH");
    sent.push(body);
    if (body.schedule.kind === "dates" && body.schedule.dates!.some((d) => d.startsWith("2020"))) return r.fulfill({ status: 409, json: { error: "schedule_refused", message: "这些时间都已经过去了" } });
    const rule = body.schedule.kind === "dates" ? "10月8日 09:00、10月15日 14:30（共 2 次）" : `每天 ${body.schedule.times!.join("、")}`;
    item = { ...item, title: body.title as string, instruction: body.instruction as string, rule, spec: body.schedule, needsBrowser: body.needsBrowser as boolean };
    return r.fulfill({ json: { message: `已更新定时任务「${item.title}」：${rule}，下次运行 10月3日 周六 07:30。\n\n每次会做：${item.instruction}`, schedule: item } });
  });
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
  const row = page.locator('[data-schedule-id="sched-1"]');
  await row.getByRole("button", { name: "修改" }).click();
  const form = page.getByRole("form", { name: /^修改定时任务：/ });
  await expect(page.getByRole("form", { name: "修改定时任务：每日天气提醒" })).toBeVisible();
  await expect(form.getByLabel("运行规则")).toHaveValue("daily");
  await expect(form.getByLabel("时间（一天多次用逗号隔开）")).toHaveValue("08:00");
  await form.getByLabel("时间（一天多次用逗号隔开）").fill("07:30，18:00");
  await form.getByLabel("名称").fill("天气提醒（早晚）");
  await form.screenshot({ path: info.outputPath("schedule-edit.png") });
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toContainText("已更新定时任务「天气提醒（早晚）」：每天 07:30、18:00");
  expect(sent[0]).toMatchObject({ title: "天气提醒（早晚）", instruction: "查旧金山今天的天气，提醒是否需要带伞", needsBrowser: true, schedule: { kind: "daily", times: ["07:30", "18:00"], maxRuns: null, until: null } });
  await expect(row).toContainText("每天 07:30、18:00");

  // Irregular dates: one a line; a refusal is shown and the form stays open.
  await row.getByRole("button", { name: "修改" }).click();
  await form.getByLabel("运行规则").selectOption("dates");
  await form.getByLabel("运行时间（一行一个）").fill("2020-10-08 09:00");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert")).toContainText("这些时间都已经过去了");
  await expect(form).toBeVisible();
  await form.getByLabel("运行时间（一行一个）").fill("2099-10-08 09:00\n2099-10-15 14:30\n");
  await form.getByLabel("运行时用浏览器查网页").uncheck();
  await form.getByRole("button", { name: "保存" }).click();
  await expect(row).toContainText("10月8日 09:00、10月15日 14:30（共 2 次）");
  expect(sent.at(-1)).toMatchObject({ needsBrowser: false, schedule: { kind: "dates", dates: ["2099-10-08 09:00", "2099-10-15 14:30"] } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("a conditional schedule shows that it has a condition and how its last check went", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await mockTaskList(page, () => []);
  const code = "import json, sys, urllib.request\nprice = json.load(urllib.request.urlopen('https://api.example.com/vacuum'))['price']\nprint(f'price {price}')\nsys.exit(0 if price < 449 else 1)";
  const items = [
    schedule({ id: "c-skip", title: "盯扫地机价格", rule: "每 15 分钟", runCount: 0, lastTask: null, condition: { language: "python", code }, lastCheck: { at: Date.now() - 5 * 60_000, result: "skipped", output: "price 479" } }),
    schedule({ id: "c-fired", title: "盯球票", rule: "每 30 分钟", condition: { language: "bash", code: "curl -s https://tickets.example.com | grep -q 'on sale'" }, lastCheck: { at: Date.now() - 2 * 60_000, result: "fired" } }),
    schedule({ id: "c-error", title: "盯库存", rule: "每小时", condition: { language: "node", code: "process.exit(2)" }, lastCheck: { at: Date.now() - 60_000, result: "error", error: "exit", exitCode: 2 } }),
    schedule({ id: "c-new", title: "盯新闻", rule: "每天 08:00", condition: { language: "bash", code: "exit 1" }, lastCheck: null }),
    schedule({ id: "plain", title: "每日天气提醒" }),
  ];
  await page.route("**/api/schedules", (r) => r.fulfill({ json: { schedules: items } }));
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
  const list = page.getByRole("region", { name: "定时任务" });
  const skip = list.locator('[data-schedule-id="c-skip"] .schedule-condition');
  await expect(skip).toContainText("条件触发");
  await expect(skip).toContainText("上次检查 5 分钟前：未满足，已跳过");
  await expect(list.locator('[data-schedule-id="c-fired"] .schedule-condition')).toContainText("上次检查 2 分钟前：满足，已运行");
  await expect(list.locator('[data-schedule-id="c-error"] .schedule-condition')).toContainText("出错（退出码 2），已跳过");
  await expect(list.locator('[data-schedule-id="c-new"] .schedule-condition')).toContainText("还没检查过");
  await expect(list.locator('[data-schedule-id="plain"] .schedule-condition')).toHaveCount(0);
  // Error and fired outcomes use the theme's error and done colors, not the muted text.
  const color = (id: string) => list.locator(`[data-schedule-id="${id}"] .schedule-check`).evaluate((el) => getComputedStyle(el).color);
  expect(new Set([await color("c-skip"), await color("c-fired"), await color("c-error")]).size).toBe(3);
  // The script and its last output are one tap away.
  await expect(skip.locator("pre").first()).toBeHidden();
  await skip.getByText("查看条件").click();
  await expect(skip).toContainText("满足（退出码 0）才运行");
  await expect(skip.locator("pre").first()).toContainText("# python");
  await expect(skip.locator("pre").first()).toContainText("sys.exit(0 if price < 449 else 1)");
  await expect(skip.locator("pre").nth(1)).toHaveText("price 479");
  await list.locator('[data-schedule-id="c-skip"]').screenshot({ path: info.outputPath("schedule-condition.png") });
  await page.screenshot({ path: info.outputPath("schedule-conditions.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  if (info.project.name.startsWith("mobile")) {
    await page.setViewportSize({ width: 360, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("schedule-conditions-360.png"), fullPage: true });
  }
});

// A real account's page: a daily feed that has learnt a lot, then nine ordinary schedules.
const longFeed = schedule({ id: "sched-feed", title: "每日推送", builtin: "daily_feed", lastTask: null, runCount: 12,
  instruction: "根据过往任务，整理今天可能感兴趣的内容和需要的提醒，保留现有关注与排除要求。每天早上08:00推送，内容尽量短，先说最重要的三件事，再列出其余值得留意的条目和对应的来源链接。",
  feed: { customized: true, memory: [
    { id: "m1", kind: "care", text: "持续关注伊尔库茨克/舍列霍夫鼠疫研究所员工不明原因肺炎死亡事件，核实病原体、接触者解除观察、新增病例、人传人和跨地区传播、WHO风险评估；官方原文与AP/Reuters交叉核实，只在可靠的重要新进展时纳入每日Feed，附日期来源，不重复传言。", source: "user" },
    { id: "m2", kind: "avoid", text: "用户2026年10月6日表示已买好 Roborock Qrevo Curv 2 Flow，相关扫地机器人价格监控已取消；不再主动查价、推荐或推送扫地机器人优惠。", source: "feed" },
    { id: "m3", kind: "care", text: "每天08:00完整阅读Gmail和Outlook所有未读邮件，成功整理后标记已读；突出重要信息、待办和截止日期，未完成事项继续提醒。用户已明确持续授权标记已读。优先留意Roy水奶订单补发、发货和送达变化。", source: "user" },
    { id: "m4", kind: "note", text: "用户认可2026-10-07的X与Reddit新闻精选形式，要求每日08:00沿用：中文简短卡片式摘要、原帖及可靠来源、事实与传言明确区分，旧报道标日期并避免重复。", source: "user" },
    { id: "m5", kind: "care", text: "用户10/12–10/13反复询购Explorer 36（124270）与Submariner 126610LV；关注美国授权门店公价购买机会及可核实的二手好价，无价格或库存重要变化不重复推送。", source: "user" },
    { id: "m6", kind: "avoid", text: "加密货币行情与币圈新闻", source: "feed" },
    { id: "m7", kind: "care", text: "Roy 的疫苗和体检预约，提前三天提醒", source: "user" },
    { id: "m8", kind: "note", text: "周末不推工作邮件，只推家庭和生活相关的事", source: "user" },
  ] } });
const ordinary = [
  ["天气提醒", "查旧金山今天的天气，下雨或气温低于 10 度时提醒带伞和外套", "每天 07:30"],
  ["机票价格", "盯旧金山到上海 12 月 20 日前后三天的往返机票，经济舱低于 900 美元或商务舱低于 3500 美元就告诉我，附上航班号、价格和购买链接", "每 6 小时"],
  ["周报整理", "把这周主会话里完成的任务整理成一份周报，按工作和家庭分开，每项一句话", "每周五 17:00"],
  ["信用卡账单", "看一下 Chase 和 Amex 的账单有没有到期，提前五天提醒", "每月 1 日 09:00"],
  ["Costco 特价", "看 Costco 本周的特价里有没有尿不湿、奶粉和湿巾", "每周一 08:00"],
  ["交材料提醒", "提醒我把报税材料交给会计", "10月8日 09:00、10月15日 14:30（共 2 次）"],
  ["球票开售", "Warriors 主场对湖人的票开售就告诉我", "每 30 分钟"],
  ["健身打卡", "问我今天有没有去健身，没去就鼓励一下", "每天 21:00"],
  ["股票提醒", "NVDA 收盘涨跌超过 5% 时总结原因", "工作日 13:30"],
].map(([title, instruction, rule], i) => schedule({ id: `plain-${i}`, title, instruction, rule, status: i === 3 ? "paused" : "active", nextRunText: i === 3 ? null : "11月7日 周六 08:00", spec: { kind: "daily", at: "08:00" } }));

test("a daily feed that has learnt a lot stays compact, so the other schedules fit on screen", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await mockTaskList(page, () => []);
  await page.route("**/api/schedules", (r) => r.fulfill({ json: { schedules: [longFeed, ...ordinary] } }));
  await page.goto("/");
  if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
  if (info.project.name.startsWith("mobile")) await expect(page.locator(".sidebar")).not.toBeInViewport();
  const list = page.getByRole("region", { name: "定时任务" });
  await expect(list.locator("[data-schedule-id]")).toHaveCount(10);
  // The how-to is one line; the examples are one tap away.
  const hint = list.locator(".schedule-hint");
  await expect(hint.locator("summary")).toHaveText("在主会话里直接说就能创建或修改");
  await expect(hint.getByText("每 2 小时看一下这个商品降价没", { exact: false })).toBeHidden();
  // The feed folds its explanation and the eight entries it remembers to a line of counts.
  const feed = list.locator('[data-schedule-id="sched-feed"]');
  await expect(feed.locator(".schedule-feed-more > summary")).toHaveText("说明与记住的 8 条关心 4不再推 2记住 2");
  await expect(feed.getByRole("list", { name: "推送记住的内容" })).toBeHidden();
  // Cards whose top edge is above the bottom of the screen, and those wholly on it.
  const onScreen = () => list.locator("[data-schedule-id]").evaluateAll((cards) => {
    const bottom = window.innerHeight;
    return { seen: cards.filter((c) => c.getBoundingClientRect().top < bottom).length, whole: cards.filter((c) => c.getBoundingClientRect().bottom <= bottom).length };
  });
  const sizes = info.project.name.startsWith("mobile") ? [{ width: 390, height: 844 }, { width: 360, height: 844 }] : [{ width: 1440, height: 900 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    const counts = await onScreen();
    info.annotations.push({ type: "on-screen", description: `${size.width}x${size.height}: ${counts.whole} whole, ${counts.seen} seen` });
    await page.screenshot({ path: info.outputPath(`schedules-dense-${size.width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(counts.whole).toBeGreaterThanOrEqual(size.width > 900 ? 4 : 3);
  }
  // Every control is at least 44px tall to a finger.
  if (info.project.name.startsWith("mobile")) {
    for (const [name, target] of Object.entries({ hint: hint.locator("summary"), feed: feed.locator(".schedule-feed-more > summary"), action: feed.getByRole("button", { name: "暂停" }), lastRun: list.locator('[data-schedule-id="plain-0"]').getByRole("button", { name: "上次：完成" }) })) {
      const reach = await target.evaluate((el) => {
        const box = el.getBoundingClientRect(), after = getComputedStyle(el, "::after");
        return after.content !== "none" && after.position === "absolute" ? box.height - parseFloat(after.top) - parseFloat(after.bottom) : box.height;
      });
      expect(reach, name).toBeGreaterThanOrEqual(44);
    }
  }
  // Nothing is lost: the examples, the feed's explanation, every entry and its whole request open in place.
  await hint.locator("summary").click();
  await expect(hint).toContainText("每 2 小时看一下这个商品降价没");
  await feed.locator(".schedule-feed-more > summary").click();
  await expect(feed).toContainText("前一天发过消息才会推送");
  await expect(feed.getByRole("list", { name: "推送记住的内容" }).getByRole("listitem")).toHaveCount(8);
  const request = feed.locator(".task-list-summary");
  expect(await request.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await feed.locator(".schedule-feed-more > summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`schedules-feed-open-${page.viewportSize()!.width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
