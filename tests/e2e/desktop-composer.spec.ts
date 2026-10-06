import { test, expect } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

for (const mode of ["main", "legacy"]) {
  test(`${mode}: on a wide screen the input is a floating card with its controls inside`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await mockConsole(page, { conversations: mode === "legacy" ? [makeConversation("composer", "输入区")] : [] });
    if (mode === "main") await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const composer = page.locator(".composer"), input = page.getByRole("textbox", { name: "消息", exact: true });
    await expect(input).toBeVisible();
    const card = await composer.evaluate(n => { const s = getComputedStyle(n), p = n.parentElement!.getBoundingClientRect(), r = n.getBoundingClientRect(); return { radius: parseFloat(s.borderTopLeftRadius), shadow: s.boxShadow, left: r.left - p.left, right: p.right - r.right, bottom: p.bottom - r.bottom, width: r.width }; });
    expect(card.radius).toBeGreaterThanOrEqual(16);
    expect(card.shadow).not.toBe("none");
    expect(card.left).toBeGreaterThan(16);
    expect(Math.abs(card.left - card.right)).toBeLessThanOrEqual(1);
    expect(card.bottom).toBeGreaterThanOrEqual(12);
    expect(card.width).toBeLessThanOrEqual(860);
    // The textarea blends into the card; the card itself shows focus.
    expect(await input.evaluate(n => getComputedStyle(n).borderTopWidth)).toBe("0px");
    const before = await composer.evaluate(n => getComputedStyle(n).borderTopColor);
    await input.focus();
    await expect.poll(() => composer.evaluate(n => getComputedStyle(n).borderTopColor)).not.toBe(before);
    for (const node of [composer.locator(".file-button"), composer.getByRole("button", { name: "发送", exact: true })]) {
      const box = (await node.boundingBox())!, outer = (await composer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(outer.x);
      expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
      expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height);
    }
    await input.fill("一条草稿");
    await page.screenshot({ path: info.outputPath(`${mode}-light.png`) });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: info.outputPath(`${mode}-dark.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  });
}
