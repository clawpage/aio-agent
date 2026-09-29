import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

/**
 * Browser lifecycle in the workspace panel.
 *
 * The panel is the only thing that keeps Chromium awake for a human, so these
 * specs assert the *observable* contract against a fully mocked control plane:
 * a visible browser panel claims a viewer lease, hiding the panel or the whole
 * document releases it, a released browser shows an honest restore affordance
 * instead of a dead frame, and a manual pin keeps it running.
 *
 * Everything is mocked, so this never touches a deployment and never stops a
 * real browser; the container-side behaviour is owned by the runtime tests.
 */

const CONV_ID = "conv_e2e_browser_lifecycle";

function replayOnly(): string {
  return `retry: 3000\n\nevent: replay.complete\ndata: ${JSON.stringify({ lastEventId: 0, replayed: 0 })}\n\n`;
}

test.describe("browser lifecycle panel", () => {
  test("shows the specific safe reason when recycling is blocked", async ({ page }) => {
    const reason = "页面有未提交的输入，已保留浏览器；提交或清除输入后可自动回收";
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "回收阻止原因")],
      browser: { snapshotBlockReason: reason },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "工作区", exact: true }).first().click();
    await expect(page.locator(".browser-status")).toContainText(reason);
    await page.locator(".browser-status").screenshot({ path: test.info().outputPath("recycle-blocked.png") });
  });

  test("a visible browser panel claims a viewer lease and shows the status bar", async ({ page, isMobile }) => {
    test.skip(isMobile, "the workspace overlay is desktop-first here; the mobile project covers layout only");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: {},
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();

    // The browser tab is the default; the lifecycle bar appears with it.
    const bar = page.locator(".browser-status");
    await expect(bar).toBeVisible({ timeout: 20_000 });
    await expect(bar).toContainText("浏览器已就绪");
    await expect(bar).toContainText("本窗口观看中");
  });

  test("switching away from the browser tab releases the viewer lease", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop keyboard/mouse tab switching");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: {},
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();
    await expect(page.locator(".browser-status")).toBeVisible({ timeout: 20_000 });

    // Leaving the browser tab unmounts the frame and drops the lease, so the bar
    // (which only describes the browser panel) goes with it.
    await page.getByRole("tab", { name: "终端" }).click();
    await expect(page.locator(".browser-status")).toHaveCount(0);
  });

  test("opening a released browser automatically restores before showing its frame", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only restore affordance");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: { startAsleep: true },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();

    // Opening the panel is the request to use it; no second click is needed.
    await expect(page.locator(".workspace iframe")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".browser-status")).toContainText("浏览器已就绪");
  });

  test("manual keep-alive pin is reflected in the status bar", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only control");
    await page.bringToFront();
    await mockConsole(page, {
      conversations: [makeConversation(CONV_ID, "浏览器生命周期")],
      sse: { [CONV_ID]: replayOnly() },
      browser: {},
    });

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).first().click();
    const bar = page.locator(".browser-status");
    await expect(bar).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "保留浏览器" }).click();
    await expect(page.getByRole("button", { name: "取消保留" })).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await page.getByRole("button", { name: "工作区" }).first().click();
    await expect(page.getByRole("button", { name: "取消保留" })).toBeVisible();
    await page.getByRole("button", { name: "取消保留" }).click();
    await expect(page.getByRole("button", { name: "保留浏览器" })).toBeVisible();
  });
});

test.describe("browser lifecycle panel responsiveness", () => {
  test("the status bar fits 1440, 390 and 360 without horizontal overflow", async ({ page, isMobile }) => {
    test.skip(isMobile, "this spec drives its own viewports from the desktop project");
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [360, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await mockConsole(page, {
        conversations: [makeConversation(`${CONV_ID}_${width}`, "浏览器生命周期")],
        sse: { [`${CONV_ID}_${width}`]: replayOnly() },
        browser: {},
      });

      await page.goto("/");
      await page.getByRole("button", { name: "工作区" }).first().click();
      // The workspace is an overlay on mobile; assert the bar itself never
      // overflows whatever width the workspace actually has.
      const bar = page.locator(".browser-status");
      await expect(bar).toBeVisible({ timeout: 20_000 });
      const box = (await bar.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(width + 1);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: test.info().outputPath(`browser-status-${width}.png`) });
    }
  });
});


test("a restore spanning heartbeats completes and the panel can then close", async ({page,isMobile}) => {
  test.skip(isMobile, "desktop drives visibility and timer races");
  await mockConsole(page, {conversations:[makeConversation(CONV_ID,"恢复竞态")],browser:{startAsleep:true}});
  let release!:()=>void;
  await page.route(url=>url.pathname==="/api/browser/wake", async route=>{
    await new Promise<void>(resolve=>{release=resolve});
    await route.fallback();
  });
  await page.clock.install();
  await page.goto('/');
  const waking=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/browser/wake');
  await page.getByRole('button',{name:'工作区'}).first().click();
  await waking;
  await page.clock.fastForward(25_000);
  await expect(page.locator('.workspace iframe')).toHaveCount(0);
  release();
  await expect(page.locator('.workspace iframe')).toBeVisible();
  await page.getByRole('button',{name:'关闭工作区'}).click();
  await expect(page.locator('.workspace iframe')).toHaveCount(0);
});


test("closing the panel during restore prevents a late frame mount", async ({page,isMobile}) => {
  test.skip(isMobile, "desktop interaction race");
  await mockConsole(page, {conversations:[makeConversation(CONV_ID,"关闭恢复")],browser:{startAsleep:true}});
  let release!:()=>void;
  await page.route(url=>url.pathname==="/api/browser/wake",async route=>{
    await new Promise<void>(resolve=>{release=resolve});await route.fallback();
  });
  await page.goto('/');
  const waking=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/browser/wake');
  await page.getByRole('button',{name:'工作区'}).first().click();await waking;
  await page.getByRole('button',{name:'关闭工作区'}).click();release();
  await expect(page.locator('.workspace')).toHaveCount(0);
  await expect(page.locator('.workspace iframe')).toHaveCount(0);
});

test("failed focus recovery keeps an honest retry state and retry reveals the browser", async ({page}) => {
  let state: any;
  await mockConsole(page, {conversations:[makeConversation(CONV_ID,"恢复失败")],browser:{startAsleep:true,onChange:s=>{state=s;}}});
  let fail=true;
  await page.route(url=>url.pathname==='/api/browser/wake',async route=>{
    if(!fail) return route.fallback();
    Object.assign(state,{state:'error',browserRunning:true,restorePending:true,lastErrorCode:'wake_failed',lastError:'恢复浏览器失败，快照仍然保留'});
    await route.fulfill({status:502,json:{error:'browser_wake_failed',message:'恢复浏览器失败，快照仍然保留'}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'工作区'}).first().click();
  await expect(page.locator('.frame-hint')).toContainText('浏览器恢复尚未完成，现有标签和快照已保留');
  await expect(page.locator('.workspace iframe')).toHaveCount(0);
  fail=false;
  await page.getByRole('button',{name:'重试恢复浏览器',exact:true}).click();
  await expect(page.locator('.workspace iframe')).toBeVisible();
  await expect(page.locator('.frame-hint')).toHaveCount(0);
});

test("phones get a native input bar that types into the page in front; desktops do not", async ({ page, isMobile }, info) => {
  await mockConsole(page, { conversations: [makeConversation(CONV_ID, "手机输入")] });
  const bodies: Array<Record<string, unknown>> = [];
  let refuse = true;
  await page.route("**/api/browser/input", async (r) => {
    bodies.push(r.request().postDataJSON());
    if (refuse) {
      refuse = false;
      await r.fulfill({ status: 409, json: { error: "task_tab", message: "这个页面正由任务「订餐厅」操作，请先在任务卡片上点“接管”" } });
    } else await r.fulfill({ json: { title: "登录", url: "https://example.com/login" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作区", exact: true }).first().click();
  const bar = page.getByRole("form", { name: "向网页输入" });
  if (!isMobile) {
    await expect(page.locator(".ws-body iframe").first()).toBeVisible();
    await expect(bar).toHaveCount(0);
    return;
  }
  const field = bar.getByRole("textbox", { name: "要输入到网页的文字" });
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("enterkeyhint", "send");

  // The phone's return key sends the text only; the page refusing it is explained.
  await field.fill("你好 world");
  await field.press("Enter");
  await expect(bar.getByRole("alert")).toContainText("请先在任务卡片上点“接管”");
  await expect(field).toHaveValue("你好 world");
  await bar.getByRole("button", { name: "发送", exact: true }).click();
  await expect(field).toHaveValue("");
  await (info.project.use.hasTouch ? bar.getByRole("button", { name: "回车", exact: true }).tap() : bar.getByRole("button", { name: "回车", exact: true }).click());
  await (info.project.use.hasTouch ? bar.getByRole("button", { name: "删除", exact: true }).tap() : bar.getByRole("button", { name: "删除", exact: true }).click());
  expect(bodies).toEqual([{ text: "你好 world" }, { text: "你好 world" }, { key: "Enter" }, { key: "Backspace" }]);
  await expect(bar.getByRole("alert")).toHaveCount(0);

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await bar.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  }
  await page.screenshot({ path: info.outputPath("remote-keyboard.png") });
});

test("coming back from the background reopens the frame on a fresh one-time ticket", async ({ page }) => {
  await mockConsole(page, { conversations: [makeConversation(CONV_ID, "回到前台")], browser: {} });
  let issued = 0;
  await page.route((url) => url.pathname === "/api/workspace/ticket", (route) => {
    issued += 1;
    return route.fulfill({ json: { ticket: `t-${issued}`, origin: "http://127.0.0.1:4289", url: `http://127.0.0.1:4289/browser-ui?ticket=t-${issued}`, expiresAt: Date.now() + 60_000 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作区", exact: true }).first().click();
  const frame = page.locator(".workspace iframe");
  await expect(frame).toHaveAttribute("src", /ticket=t-1$/);

  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((s) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await setVisibility("hidden");
  await expect(frame).toHaveCount(0);
  await setVisibility("visible");
  // The first ticket was spent by the first load: the frame must not replay it.
  await expect(frame).toHaveAttribute("src", /ticket=t-2$/);
  expect(issued).toBe(2);
});
