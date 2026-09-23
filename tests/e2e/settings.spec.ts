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
