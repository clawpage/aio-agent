import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// A console that runs behind the deployed one (an app resumed for days) keeps when it first found that out, says so,
// and three hours after that switches to the deployed page, unless something typed would be lost (src/ui/src/staleBuild.ts).
async function setup(page: Page, newer = true) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null, version: "v1" } }));
  const events: { name: string; props: Record<string, unknown> }[] = [];
  await page.route("**/api/analytics", (r) => { events.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); });
  const deployed = { newer, checks: 0 };
  // The console's own check asks for the page with fetch; opening it stays a real navigation.
  await page.route((url) => url.pathname === "/", async (r) => {
    if (r.request().resourceType() !== "fetch") return r.fallback();
    deployed.checks += 1;
    if (!deployed.newer) return r.fallback();
    const html = (await (await r.fetch()).text()).replace(/\/assets\/index-[^"']+\.js/, "/assets/index-NEWER.js");
    await r.fulfill({ body: html, headers: { "content-type": "text/html" } });
  });
  let loads = 0;
  page.on("load", () => { loads += 1; });
  await page.goto("/");
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  return { events, loads: () => loads, deployed };
}
const stale = (events: { name: string; props: Record<string, unknown> }[]) => events.filter((e) => e.name === "stale_build").map((e) => e.props);
/** Moves the time this device first found its build behind back by `hours`. */
const foundEarlier = (page: Page, hours: number) => page.evaluate((h) => {
  const kept = JSON.parse(localStorage.getItem("aio.behindSince")!);
  localStorage.setItem("aio.behindSince", JSON.stringify({ ...kept, since: kept.since - h * 3600_000 }));
}, hours);

test("found behind: kept and reported, and the console stays; caught up, the count is dropped", async ({ page }) => {
  const { events, loads, deployed } = await setup(page);
  await expect.poll(() => stale(events)).toEqual([expect.objectContaining({ deployed: "index-NEWER", behind_min: 0, switched: false })]);
  expect(loads()).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("aio.behindSince")!).since)).toBeGreaterThan(0);
  deployed.newer = false;
  await page.reload();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("aio.behindSince"))).toBeNull();
});

test("three hours after it was first found behind, the console switches to the deployed page, once", async ({ page }) => {
  const { events, loads } = await setup(page);
  await expect.poll(() => stale(events).length).toBe(1);
  await foundEarlier(page, 3.5);
  // Found behind again on opening: three and a half hours since the first time.
  await page.reload();
  await expect.poll(() => stale(events)[1]).toEqual(expect.objectContaining({ behind_min: 210, switched: true }));
  await expect.poll(loads).toBe(3);
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  // Here the page it loads is still not the newer one: it says so, but does not reload again and again.
  await expect.poll(() => stale(events).length).toBe(3);
  await page.waitForTimeout(1000);
  expect(loads()).toBe(3);
});

test("with a message being typed, the console waits", async ({ page }) => {
  await page.clock.install();
  const { events, loads, deployed } = await setup(page, false);
  expect(deployed.checks).toBe(1);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("还没写完");
  deployed.newer = true;
  // Back on screen: found behind for the first time (a check at most every ten minutes).
  await page.clock.fastForward("11:00");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => stale(events)).toEqual([expect.objectContaining({ behind_min: 0, switched: false })]);
  // Back again, long after that: still typing, so it stays.
  await foundEarlier(page, 4);
  await page.clock.fastForward("11:00");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => deployed.checks).toBe(3);
  await page.waitForTimeout(500);
  expect(loads()).toBe(1);
  expect(stale(events)).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("还没写完");
});
