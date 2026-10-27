import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockConsole } from "./mock-api";

const evidence = "var/.playwright-artifacts/mac-terminal";
type Status = { state: "unlinked" | "offline" | "outdated" } | { state: "ready"; enabled: boolean; tmux: boolean };

/** The workspace opened on Mac 终端, with `/api/mac-shell/status` answering what `status` holds at the time. */
async function openMacTerminal(page: Page, mobile: boolean, status: { current: Status }, linkIds: string[] = []) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route("**/api/workspace/ticket", (r) => r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/", expiresAt: Date.now() + 60000 } }));
  await page.route("http://127.0.0.1:4289/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body>sandbox</body></html>" }));
  await page.route("**/api/mac-shell/status", (r) => r.fulfill({ json: status.current }));
  await page.route("**/api/device-links**", (r) => r.fulfill({ json: { links: linkIds.map((id) => ({ id, name: "Mac", createdAt: Date.now(), lastSeenAt: Date.now(), online: true })) } }));
  await page.goto("/");
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("tablist", { name: "应用" }).getByRole("tab", { name: "Mac 终端", exact: true }).click();
  await expect(page.locator(".window-title")).toHaveText("Mac 终端");
  return page.getByRole("region", { name: "Mac 终端" });
}

test("Mac 终端 is its own app: in a browser it shows the Mac's terminal state but never a switch", async ({ page }, info) => {
  const status: { current: Status } = { current: { state: "unlinked" } };
  const app = await openMacTerminal(page, info.project.name.startsWith("mobile"), status);
  await expect(page.getByRole("tablist", { name: "应用" }).locator('.app-icon[data-app="macTerminal"]')).toHaveCount(1);
  await expect(app.getByRole("status")).toHaveText(/还没有连接 Mac/);
  await expect(app.getByRole("button", { name: "去连接 Mac" })).toBeVisible();

  status.current = { state: "ready", enabled: true, tmux: true };
  await expect(app.getByRole("status")).toHaveText(/已打开/, { timeout: 10_000 });
  await expect(app).toContainText("只能在那台 Mac 上的一站 App 里");
  await expect(app).toContainText("tmux -L aio-agent attach");
  await expect(app.getByRole("checkbox")).toHaveCount(0);

  status.current = { state: "ready", enabled: false, tmux: false };
  await expect(app.getByRole("status")).toHaveText(/已关闭/, { timeout: 10_000 });
  await expect(app.getByRole("alert")).toContainText("brew install tmux");

  status.current = { state: "outdated" };
  await expect(app.getByRole("status")).toHaveText(/版本太旧/, { timeout: 10_000 });
});

test("inside the Mac app on a linked Mac, Mac 终端 switches the terminal: the choice goes to the app, not the server", async ({ page }, info) => {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as unknown as { __sent: unknown[] }).__sent = sent;
    let shell = false;
    const emit = () => window.dispatchEvent(new CustomEvent("aio-device-link", { detail: { state: "online", linkId: "dlink_mine", name: "MacBook", shell } }));
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioDeviceLink: { postMessage(raw: string) {
      const message = JSON.parse(raw) as { type: string; enabled?: boolean };
      sent.push(message);
      if (message.type === "status") setTimeout(emit);
      // The app restarts its bridge before it reports the new state.
      if (message.type === "shell") { shell = Boolean(message.enabled); setTimeout(emit, 800); }
    } } } };
  });
  const status: { current: Status } = { current: { state: "ready", enabled: false, tmux: true } };
  const app = await openMacTerminal(page, info.project.name.startsWith("mobile"), status, ["dlink_mine"]);
  const terminal = app.getByRole("checkbox", { name: "允许 AI 使用这台 Mac 的终端" });
  await expect(terminal).not.toBeChecked();
  await expect(app.getByRole("status")).toHaveText(/已关闭/);
  await expect(app).toContainText("它和你本人一样有这台 Mac 的权限");
  await terminal.check();
  // On at once, while the app restarts its bridge.
  await expect(terminal).toBeChecked();
  await expect(app.getByRole("status")).toHaveText(/已打开/);
  expect(await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent.at(-1))).toEqual({ type: "shell", enabled: true });
  await page.waitForTimeout(1000);
  await expect(terminal).toBeChecked();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${info.project.name}-on.png`, fullPage: false });
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await terminal.uncheck();
  expect(await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent.at(-1))).toEqual({ type: "shell", enabled: false });
});

test("inside the Mac app on a Mac this account did not link, there is no switch", async ({ page }, info) => {
  await page.addInitScript(() => {
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { aioDeviceLink: { postMessage(raw: string) {
      if ((JSON.parse(raw) as { type: string }).type === "status") setTimeout(() => window.dispatchEvent(new CustomEvent("aio-device-link", { detail: { state: "online", linkId: "dlink_someone_else", name: "MacBook", shell: true } })));
    } } } };
  });
  const app = await openMacTerminal(page, info.project.name.startsWith("mobile"), { current: { state: "offline" } }, ["dlink_mine"]);
  await expect(app.getByRole("status")).toHaveText(/不在线/);
  await expect(app.getByRole("checkbox")).toHaveCount(0);
});
