import type { Page } from "@playwright/test";

/** Open the workspace at its own address. The console has no menu entry for it: it opens from links in the conversation, so tests go by address. */
export async function openWorkspace(page: Page): Promise<void> {
  await page.locator(".main").waitFor({ state: "attached", timeout: 60_000 });
  await page.evaluate(() => {
    const home = location.pathname.match(/^\/u\/[^/]+/)?.[0] ?? "";
    history.pushState({ aio: true, workspace: true }, "", `${home}/workspace`);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
}
