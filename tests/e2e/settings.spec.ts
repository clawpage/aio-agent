import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { makeConversation, mockConsole, MOCK_STATUS } from "./mock-api";

const id = "settings-layout";
const evidence = "var/.playwright-artifacts/config";

function stream() {
  return (
    `id: 1\nevent: item/completed\ndata: ${JSON.stringify({
      id: 1,
      type: "item/completed",
      turnId: "t1",
      createdAt: Date.now(),
      payload: { item: { type: "agentMessage", id: "answer", text: "已处理。" } },
    })}\n\n` + 'event: replay.complete\ndata: {"lastEventId":1,"replayed":1}\n\n'
  );
}

async function openSettings(page: Page, mobile: boolean) {
  if (mobile) {
    await page.locator(".bottom-nav button", { hasText: "配置" }).click();
  } else {
    await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  }
  await expect(page.getByRole("heading", { name: "配置" })).toBeVisible();
}

/** Wait until the settings form is really interactive (not the loading state). */
async function waitForLoadedSettings(page: Page) {
  await expect(page.getByLabel("模型", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
}

async function setup(
  page: Page,
  opts: { running?: boolean; settingsModels?: unknown[]; settings?: { model: string | null; effort: string | null } } = {},
) {
  const conversation = makeConversation(id, "配置页验证会话");
  if (opts.running) conversation.status = "running";
  const settings = opts.settings ?? { model: null as string | null, effort: null as string | null };
  await mockConsole(page, {
    conversations: [conversation],
    sse: { [id]: stream() },
    settings,
    settingsModels: opts.settingsModels as never,
    status: opts.running
      ? { ...MOCK_STATUS, agent: { ...MOCK_STATUS.agent, activeConversationId: id, activeTurnId: "t1" } }
      : MOCK_STATUS,
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".composer textarea")).toBeVisible();
  return settings;
}

test("config page saves, survives a reload and applies to later messages without model fields", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const settings = await setup(page);
  let savedBody: unknown;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") savedBody = route.request().postDataJSON();
    await route.fallback();
  });

  await openSettings(page, mobile);
  await waitForLoadedSettings(page);

  // Default choice: model defaults to the app default, effort to "按模型默认".
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gpt-6-sol");
  await expect(page.getByLabel("思考强度", { exact: true })).toHaveValue("");

  await page.getByLabel("模型", { exact: true }).selectOption("gpt-5.5");
  // gpt-5.5 supports only minimal/low.
  await page.getByLabel("思考强度", { exact: true }).selectOption("low");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".banner.ok")).toContainText("已保存");
  expect(savedBody).toMatchObject({ model: "gpt-5.5", effort: "low" });
  expect(settings).toMatchObject({ model: "gpt-5.5", effort: "low" });

  // Reload: the stored choice is read back from the server, not local state.
  await page.reload();
  await openSettings(page, mobile);
  await waitForLoadedSettings(page);
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gpt-5.5");
  await expect(page.getByLabel("思考强度", { exact: true })).toHaveValue("low");

  // Returning to the conversation must not send model/effort: the server reads
  // the saved config. Draft text typed before navigating is preserved too.
  await page.getByRole("button", { name: "← 返回会话" }).click();
  await page.getByRole("textbox", { name: "消息" }).fill("这条消息用统一配置");
  await openSettings(page, mobile);
  await page.getByRole("button", { name: "← 返回会话" }).click();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("这条消息用统一配置");

  let turnBody: any;
  await page.route(`**/api/conversations/${id}/turns`, async (route) => {
    turnBody = route.request().postDataJSON();
    await route.fulfill({ json: { turn: { id: "t2" }, duplicate: false } });
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => turnBody).toBeTruthy();
  expect(turnBody).toMatchObject({ text: "这条消息用统一配置" });
  expect(turnBody).not.toHaveProperty("model");
  expect(turnBody).not.toHaveProperty("effort");
});

test("config page is reachable from the mobile conversation list and keeps drafts and attachments", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "mobile drawer entry");
  await setup(page);
  // Draft + attachment typed before opening the drawer.
  await page.getByRole("textbox", { name: "消息" }).fill("保留这段草稿");
  await page.route("**/api/sandbox/upload", (route) =>
    route.fulfill({ json: { path: "/home/gem/workspace/uploads/keep.txt", name: "保留附件.txt", kind: "file" } }),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".file-button").click();
  await (await chooser).setFiles({ name: "保留附件.txt", mimeType: "text/plain", buffer: Buffer.from("keep") });
  await expect(page.locator(".composer .chip")).toContainText("保留附件.txt");

  // Open the drawer (会话), then the 配置 entry inside it.
  await page.locator(".bottom-nav button", { hasText: "会话" }).click();
  await expect(page.locator(".sidebar.show-mobile")).toBeVisible();
  await page.locator(".sidebar-foot button", { hasText: "配置" }).click();
  await expect(page.getByRole("heading", { name: "配置" })).toBeVisible();
  // The drawer must be closed, or it would cover the settings view.
  await expect(page.locator(".sidebar.show-mobile")).toHaveCount(0);
  await waitForLoadedSettings(page);

  await page.getByRole("button", { name: "← 返回会话" }).click();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("保留这段草稿");
  await expect(page.locator(".composer .chip")).toContainText("保留附件.txt");
});

test("config page surfaces a save failure, retries a failed load and disables saving without a model list", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await setup(page);
  await openSettings(page, mobile);
  await waitForLoadedSettings(page);
  await page.getByLabel("模型", { exact: true }).selectOption("gpt-5.5");
  // Fail the next save once.
  let fail = true;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT" && fail) {
      fail = false;
      return route.fulfill({ status: 500, json: { error: "server_error", message: "保存失败，请重试" } });
    }
    await route.fallback();
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".banner.error")).toContainText("保存失败");

  // A failed load shows a retry that recovers into the real form.
  await page.unroute("**/api/settings");
  let failLoad = true;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PUT" && failLoad) {
      failLoad = false;
      return route.fulfill({ status: 500, json: { error: "server_error", message: "读取失败" } });
    }
    await route.fallback();
  });
  await page.reload();
  await openSettings(page, mobile);
  await expect(page.locator(".banner.error")).toContainText("加载配置失败");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await waitForLoadedSettings(page);

  // No model list: saving is disabled and an explanatory banner shows.
  await page.unroute("**/api/settings");
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PUT") {
      return route.fulfill({
        json: { settings: { model: null, effort: null }, defaultModel: "gpt-6-sol", models: [], savedModelAvailable: null },
      });
    }
    await route.fallback();
  });
  await page.reload();
  await openSettings(page, mobile);
  await expect(page.locator(".banner.warn")).toContainText("无法获取模型列表");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
});

test("config page explains a text-only bridge model and saves it with its own efforts", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await setup(page, {
    settingsModels: [
      { id: "gpt-6-sol", displayName: "GPT-6-Sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
      {
        id: "deepseek-v4.1-flash",
        displayName: "DeepSeek V4.1 Flash（OpenCode Go）",
        supportedReasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
        inputModalities: ["text"],
        modelProvider: "opencode_go",
      },
      {
        id: "mimo-v2.6-pro",
        displayName: "MiMo V2.6 Pro（OpenCode Go）",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
        inputModalities: ["text"],
        modelProvider: "opencode_go",
      },
    ],
  });
  let savedBody: unknown;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") savedBody = route.request().postDataJSON();
    await route.fallback();
  });

  await openSettings(page, mobile);
  await waitForLoadedSettings(page);
  // A plain ChatGPT model says nothing about input modalities.
  await expect(page.getByRole("note")).toHaveCount(0);

  await page.getByLabel("模型", { exact: true }).selectOption("deepseek-v4.1-flash");
  await expect(page.getByRole("note")).toContainText("只支持文本输入");
  // The effort list belongs to the bridge model, not the ChatGPT one.
  await page.getByLabel("思考强度", { exact: true }).selectOption("max");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".banner.ok")).toContainText("已保存");
  expect(savedBody).toMatchObject({ model: "deepseek-v4.1-flash", effort: "max" });

  // The second bridge model has its own, narrower effort list: `max` must not
  // be offered for it, because the upstream rejects that combination.
  await page.getByLabel("模型", { exact: true }).selectOption("mimo-v2.6-pro");
  await expect(page.getByRole("note")).toContainText("只支持文本输入");
  // Options render with Chinese labels ("低"/"高"/"最高"), so assert on values.
  const mimoEffortValues = await page
    .getByLabel("思考强度", { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(mimoEffortValues).toContain("high");
  expect(mimoEffortValues).not.toContain("max");
  await page.getByLabel("思考强度", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".banner.ok")).toContainText("已保存");
  expect(savedBody).toMatchObject({ model: "mimo-v2.6-pro", effort: "high" });

  // Switching back to a ChatGPT model withdraws the text-only note.
  await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-sol");
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("config page chooses the executor, then only that executor's models", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const claude = (id: string, name: string) => ({
    id,
    displayName: `${name}（Claude Code）`,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: null,
    inputModalities: ["text", "image"],
    modelProvider: "claude-code",
  });
  const settings = await setup(page, {
    settingsModels: [
      { id: "gpt-6-sol", displayName: "GPT-6-Sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
      {
        id: "deepseek-v4.1-flash",
        displayName: "DeepSeek V4.1 Flash（OpenCode Go）",
        supportedReasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
        inputModalities: ["text"],
        modelProvider: "opencode_go",
      },
      claude("claude-opus-5-5", "Claude Opus 5.5"),
      claude("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ],
  });
  let savedBody: unknown;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") savedBody = route.request().postDataJSON();
    await route.fallback();
  });
  const optionValues = (label: string) =>
    page.getByLabel(label, { exact: true }).locator("option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));

  await openSettings(page, mobile);
  await waitForLoadedSettings(page);
  const executor = page.getByLabel("执行器", { exact: true });
  await expect(executor).toHaveValue("codex");
  // Codex keeps its own models (including the bridge ones) and nothing else.
  expect(await optionValues("模型")).toEqual(["gpt-6-sol", "deepseek-v4.1-flash"]);

  await executor.selectOption("claude-code");
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("claude-opus-5-5");
  expect(await optionValues("模型")).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  await expect(page.locator(".settings-fields")).toContainText("主会话派单和任务执行都由 Claude Code 完成");
  // Claude models take images: no text-only note.
  await expect(page.getByRole("note")).toHaveCount(0);
  await page.getByLabel("思考强度", { exact: true }).selectOption("xhigh");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".banner.ok")).toContainText("已保存");
  expect(savedBody).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
  expect(settings).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });

  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/executor-${info.project.name}.png`, fullPage: true });

  // The saved executor comes back after a reload.
  await page.reload();
  await openSettings(page, mobile);
  await waitForLoadedSettings(page);
  await expect(page.getByLabel("执行器", { exact: true })).toHaveValue("claude-code");
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("claude-opus-5-5");

  // Switching back selects the configured Codex default with its own default effort.
  await page.getByLabel("执行器", { exact: true }).selectOption("codex");
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gpt-6-sol");
  await expect(page.getByLabel("思考强度", { exact: true })).toHaveValue("");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("config page shows no executor choice when only Codex is configured", async ({ page }, info) => {
  await setup(page);
  await openSettings(page, info.project.name.startsWith("mobile"));
  await waitForLoadedSettings(page);
  await expect(page.getByLabel("执行器", { exact: true })).toHaveCount(0);
});

test("config page locks edits while saving and restores defaults", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await setup(page, { running: true });
  await openSettings(page, mobile);
  await waitForLoadedSettings(page);
  await page.getByLabel("模型", { exact: true }).selectOption("gpt-5.5");
  await page.getByLabel("思考强度", { exact: true }).selectOption("low");

  // Delay the PUT so the in-flight state is observable.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      await gate;
      return route.fulfill({ json: { ok: true, settings: { model: "gpt-5.5", effort: "low" } } });
    }
    await route.fallback();
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
  await expect(page.getByLabel("模型", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("思考强度", { exact: true })).toBeDisabled();
  release();
  await expect(page.locator(".banner.ok")).toBeVisible();

  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gpt-6-sol");
  await expect(page.getByLabel("思考强度", { exact: true })).toHaveValue("");

  // The running turn is untouched: back in the chat the stop control is still
  // there, so the SSE stream and task were never torn down by the view change.
  await page.getByRole("button", { name: "← 返回会话" }).click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
});

test("config page has no horizontal overflow in dark and light at each viewport", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await setup(page);
  await mkdir(evidence, { recursive: true });
  const widths = mobile ? [390, 360] : [1440];
  for (const theme of ["dark", "light"] as const) {
    // emulateMedia must run before load for the shell's initial theme read; the
    // reload makes the light run genuinely light instead of inheriting dark.
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await expect(page.locator(".composer textarea")).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: mobile ? 844 : 900 });
      await openSettings(page, mobile);
      await waitForLoadedSettings(page);
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      expect(applied, `${theme} theme applied`).toBe(theme);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${theme} ${width}`).toBeLessThanOrEqual(1);
      // Stay on the settings view for the screenshot.
      await page.screenshot({
        animations: "disabled",
        scale: "css",
        path: `${evidence}/${info.project.name}-${width}-${theme}.png`,
      });
      await page.getByRole("button", { name: "← 返回会话" }).click();
    }
  }
});

test('SOUL editor saves independently, preserves conflict drafts and persists empty clearing',async({page},info)=>{
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 await setup(page,{settingsModels:[]});
 const openSoul=async()=>{if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'配置',exact:true}).click();};
 let content='# SOUL.md\n你是小助理。';let revision='one';let conflict=false;
 await page.route('**/api/settings/soul',async r=>{
  if(r.request().method()==='PUT'){
   const body=r.request().postDataJSON();
   if(conflict)return r.fulfill({status:409,json:{message:'SOUL.md 已在其他页面修改，请重新加载后合并你的修改。'}});
   expect(body.revision).toBe(revision);content=body.content;revision+='x';
  }
  return r.fulfill({json:{content,revision,defaultContent:'# SOUL.md\n默认助理',maxBytes:65536}});
 });
 await openSoul();
 const editor=page.getByRole('textbox',{name:'SOUL.md 内容'});
 await expect(editor).toHaveValue(content);
 await editor.fill('# SOUL.md\n我叫 AIO，是你的个人助理。');
 await page.getByRole('button',{name:'保存 SOUL.md',exact:true}).click();
 await expect(page.getByText('SOUL.md 已保存，下次任务开始时生效。',{exact:true})).toBeVisible();
 await page.reload();await openSoul();await expect(editor).toHaveValue(content);
 conflict=true;await editor.fill('保留未保存草稿');await page.getByRole('button',{name:'保存 SOUL.md',exact:true}).click();
 await expect(page.getByRole('region',{name:'助理设定'}).getByRole('alert')).toContainText('其他页面');await expect(editor).toHaveValue('保留未保存草稿');
 conflict=false;await editor.fill('');await page.getByRole('button',{name:'保存 SOUL.md',exact:true}).click();await expect(page.locator('.soul-saved')).toBeVisible();expect(content).toBe('');
 await page.getByRole('button',{name:'填入默认设定'}).click();await expect(editor).toHaveValue('# SOUL.md\n默认助理');
 if(info.project.name.startsWith('mobile'))await page.setViewportSize({width:360,height:844});
 await editor.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 await page.screenshot({path:info.outputPath('soul.png')});
});


test('main settings use consistent cards and keep the mobile header clear',async({page},info)=>{
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 await setup(page);
 const mobile=info.project.name.startsWith('mobile');
 if(mobile)await page.getByRole('button',{name:'打开导航'}).click();
 await page.locator('.sidebar').getByRole('button',{name:'配置',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'SOUL.md 内容'})).toBeEnabled();
 for(const theme of ['light','dark'] as const){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
  for(const width of mobile?[390,360]:[1440]){
   await page.setViewportSize({width,height:mobile?844:900});
   await page.locator('.settings').evaluate(el=>el.scrollTop=0);
   const cards=page.locator('.settings-card');await expect(cards).toHaveCount(5);
   expect(await cards.first().getAttribute('aria-label')).toBe('助理设定');
   const a=await cards.nth(0).boundingBox();
   for(const i of [1,2,3,4]){const b=await cards.nth(i).boundingBox();expect(a!.x).toBe(b!.x);expect(a!.width).toBe(b!.width);}
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
   if(mobile){const menu=await page.getByRole('button',{name:'打开导航'}).boundingBox();const heading=await page.locator('.settings-head h2').boundingBox();expect(heading!.x).toBeGreaterThanOrEqual(menu!.x+menu!.width);}
   await page.screenshot({path:info.outputPath(`settings-${width}-${theme}.png`)});
   await page.getByRole('button',{name:'保存',exact:true}).scrollIntoViewIfNeeded();
   await expect(page.getByRole('button',{name:'恢复默认',exact:true})).toBeVisible();
  }
 }
});

test("config page shows how well the dispatcher recalls past tasks, per range", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await setup(page);
  await openSettings(page, mobile);
  const card = page.getByRole("region", { name: "历史召回" });
  await expect(card).toContainText("34 次（失败 1 · 自动修正 3）");
  await expect(card).toContainText("召回找到 7、搜索找到 2");
  await expect(card).toContainText("检索能排进前 10 名 83%");
  await card.getByRole("button", { name: "近 30 天" }).click();
  await expect(card).toContainText("120 次");
  await expect(card.getByRole("button", { name: "近 30 天" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await card.screenshot({ path: info.outputPath("recall-card.png") });
});

test("the debug switch is remembered by this browser", async ({ page }, info) => {
  await setup(page);
  await openSettings(page, info.project.name.startsWith("mobile"));
  const toggle = page.getByRole("checkbox", { name: /已关闭|已开启/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByText("已开启", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("aio.debug"))).toBe("1");
  await page.reload();
  await openSettings(page, info.project.name.startsWith("mobile"));
  await expect(page.getByRole("checkbox", { name: "已开启" })).toBeChecked();
});
