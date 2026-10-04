import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

const share = "https://agent-workspace.clawpage.ai/u/owner/share/example/";
const result = `[公网域名](https://external.example/article)\n\n[公网 IP](https://8.8.8.8/)\n\n[内网页面](http://192.168.1.20:8080/page)\n\n[分享页面](${share})\n\n\`\`\`products\n[{"name":"测试商品","url":"https://external.example/product","price":"$10"}]\n\`\`\``;

async function setup(page: Page) {
  const opened: string[] = [];
  await mockConsole(page, { conversations: [], onBrowserTab: url => opened.push(url) });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [{ id: "link-task", revision: 1, title: "链接验证", text: "查看链接", conversationId: "child", status: "completed", result, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: 2000 }], nextBefore: null } }));
  await page.context().route(url => ["external.example", "8.8.8.8", "agent-workspace.clawpage.ai"].includes(url.hostname), r => r.fulfill({ contentType: "text/html; charset=utf-8", body: "<meta charset='utf-8'><h1>设备浏览器页面</h1>" }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
  return opened;
}

test("public links, product actions and share buttons open device tabs; private IP stays in the sandbox", async ({ page }) => {
  const opened = await setup(page);
  const targets = [
    [page.getByRole("link", { name: "公网域名", exact: true }), "https://external.example/article"],
    [page.getByRole("link", { name: "公网 IP", exact: true }), "https://8.8.8.8/"],
    [page.getByRole("link", { name: "去看看", exact: true }), "https://external.example/product"],
    [page.getByTestId("share-card").getByRole("link", { name: "打开", exact: true }), share],
    [page.locator(".markdown").getByRole("link", { name: "分享页面", exact: true }), share],
  ] as const;
  const original = page.url();
  for (const [link, url] of targets) {
    const popup = page.waitForEvent("popup");
    await link.click();
    const tab = await popup;
    await expect.poll(() => tab.url()).toBe(url);
    await expect(tab.getByRole("heading", { name: "设备浏览器页面" })).toBeVisible();
    expect(page.url()).toBe(original);
    expect(opened).toEqual([]);
    await tab.close();
  }
  await page.getByRole("link", { name: "内网页面", exact: true }).click();
  await expect.poll(() => opened).toEqual(["http://192.168.1.20:8080/page"]);
  await expect(page.locator(".workspace")).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
});

for (const platform of ["ios", "android"] as const) {
  test(`${platform}: native browser bridge handles taps without WebView popups or sandbox calls`, async ({ page }, info) => {
    test.skip(!info.project.name.startsWith("mobile"));
    await page.addInitScript(platform => {
      const urls: string[] = [];
      const bridge = { postMessage: (url: string) => urls.push(url) };
      Object.assign(window, { nativeOpened: urls });
      if (platform === "ios") Object.assign(window, { webkit: { messageHandlers: { aioDeviceBrowser: bridge } } });
      else Object.assign(window, { aioDeviceBrowser: bridge });
    }, platform);
    const opened = await setup(page);
    for (const link of [
      page.getByRole("link", { name: "公网域名", exact: true }),
      page.getByTestId("share-card").getByRole("link", { name: "打开", exact: true }),
      page.getByRole("link", { name: "去看看", exact: true }),
    ]) await link.tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeOpened: string[] }).nativeOpened)).toEqual(["https://external.example/article", share, "https://external.example/product"]);
    expect(opened).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
    await page.getByRole("link", { name: "内网页面", exact: true }).tap();
    await expect.poll(() => opened).toEqual(["http://192.168.1.20:8080/page"]);
    expect(await page.evaluate(() => (window as unknown as { nativeOpened: string[] }).nativeOpened)).toHaveLength(3);
  });
}
