import { test, expect } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";

for (const mode of ["main", "legacy"]) {
  test(`${mode}: floating input contracts when idle, expands on focus/draft and keeps icon actions`, async ({ page }, info) => {
    test.skip(!info.project.name.startsWith("mobile"));
    await mockConsole(page, { conversations: mode === "legacy" ? [makeConversation("composer", "输入区")] : [] });
    if (mode === "main") await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.addStyleTag({ content: ":root { --safe-top:62px; --safe-bottom:34px; }" });
    const composer = page.locator(".composer"), input = page.getByRole("textbox", { name: "消息", exact: true });
    await expect(input).toBeVisible();
    const height = () => composer.evaluate(n => n.getBoundingClientRect().height);
    const blur = () => input.evaluate(n => n.blur());
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await blur();
      expect(await height()).toBeLessThanOrEqual(60);
      const idle = (await composer.boundingBox())!;
      expect(idle.x).toBeGreaterThan(0);
      expect(idle.x + idle.width).toBeLessThan(width);
      expect(idle.y + idle.height).toBeLessThan(844 - 34);
      await input.focus();
      expect(await height()).toBeGreaterThan(110);
      await blur();
      expect(await height()).toBeLessThanOrEqual(60);
      await input.fill("保留的草稿"); await blur();
      expect(await height()).toBeGreaterThan(110);
      await input.fill(Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
      const tall = await input.evaluate(n => ({ height: n.clientHeight, scroll: n.scrollHeight }));
      expect(tall.scroll).toBeGreaterThan(tall.height);
      expect(tall.height).toBeLessThanOrEqual((844 - 96) * .25 + 1);
      await input.fill(""); await blur();
      expect(await height()).toBeLessThanOrEqual(60);
      await expect(composer.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
      for (const node of [composer.locator(".file-button"), composer.getByRole("button", { name: "发送", exact: true })]) {
        await expect(node.locator("svg")).toHaveCount(1);
        await expect(node.locator(".composer-button-label")).toBeHidden();
        expect((await node.boundingBox())!.width).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: info.outputPath(`${mode}-idle-${width}.png`) });
    }
    await page.route("**/api/sandbox/upload", r => r.fulfill({ json: { path: "/home/gem/workspace/note.txt", name: "笔记.txt", kind: "file" } }));
    const chooser = page.waitForEvent("filechooser"); await composer.locator(".file-button").click();
    await (await chooser).setFiles({ name: "笔记.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
    await expect(composer.locator(".chip")).toContainText("笔记.txt"); await blur();
    expect(await height()).toBeGreaterThan(110);
    await expect(composer.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await composer.getByRole("button", { name: "移除附件" }).click();
    expect(await height()).toBeLessThanOrEqual(60);
    await input.focus();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 420 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => page.locator(".app").evaluate(n => n.clientHeight)).toBe(420);
    expect((await composer.boundingBox())!.y + (await height())).toBeLessThan(420);
    await input.fill("键盘上方继续输入");
    await page.screenshot({ path: info.outputPath(`${mode}-keyboard.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  });
}
