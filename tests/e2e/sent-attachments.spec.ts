import { test, expect } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** A picture of the given shape, drawn as SVG so the test carries no binary fixtures. */
const picture = (w: number, h: number, a: string, b: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.35}" r="${Math.min(w, h) * 0.16}" fill="#fff8"/></svg>`;
const pictures: Record<string, string> = {
  "/home/gem/workspace/uploads/IMG_1378.png": picture(1170, 1560, "#3a3f8f", "#d98a5b"),
  "/home/gem/workspace/uploads/a.jpg": picture(1600, 1200, "#1f6f5c", "#9fd8b0"),
  "/home/gem/workspace/uploads/b.jpg": picture(1200, 1200, "#6b4fe0", "#f0b2d0"),
  "/home/gem/workspace/uploads/c.jpg": picture(900, 1200, "#a15f00", "#ffd38a"),
};
const att = (path: string) => ({ path, name: path.split("/").pop()!, size: 120_000, mimeType: path.endsWith(".pdf") ? "application/pdf" : "image/png" });
const base = { revision: 1, error: null, relatedTaskId: null, dependencies: [], approvals: 0, status: "completed", result: "好的，已经看过了。" };

test("pictures the person sent show as pictures, files as cards under them", async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/documents/image*", (r) => {
    const svg = pictures[new URL(r.request().url()).searchParams.get("path")!];
    return svg ? r.fulfill({ contentType: "image/svg+xml", body: svg }) : r.fulfill({ status: 404, body: "missing" });
  });
  const tasks = [
    { ...base, id: "t1", title: "导读博客", text: "帮我找到这篇博客并中文导读", conversationId: "c1", attachments: [att("/home/gem/workspace/uploads/IMG_1378.png")], createdAt: Date.now() - 600_000, completedAt: Date.now() - 500_000 },
    { ...base, id: "t2", title: "整理照片", text: "这几张照片和行程单一起整理一下", conversationId: "c2", attachments: ["a.jpg", "b.jpg", "c.jpg"].map((n) => att(`/home/gem/workspace/uploads/${n}`)).concat(att("/home/gem/workspace/uploads/行程单.pdf")), createdAt: Date.now() - 60_000, completedAt: Date.now() - 30_000 },
  ];
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", version: "v1", tasks, nextBefore: null } }));
  await page.goto("/");

  const first = page.locator(".msg.user").filter({ hasText: "中文导读" });
  const single = first.locator('[data-testid="file-card"][data-kind="image"]');
  // The feed opens at the latest message; pictures load as they come near.
  await single.scrollIntoViewIfNeeded();
  await expect(single.getByTestId("file-card-thumb")).toBeVisible({ timeout: 60_000 });
  // The picture keeps its own (portrait) shape and no file name or "点击预览" line.
  await expect.poll(async () => { const b = (await single.boundingBox())!; return b.height / b.width; }).toBeCloseTo(1560 / 1170, 1);
  await expect(first).not.toContainText("点击预览");
  await expect(single.getByRole("link", { name: "下载 IMG_1378.png" })).toHaveAttribute("download", "IMG_1378.png");

  const second = page.locator(".msg.user").filter({ hasText: "行程单一起" });
  await expect(second.locator('[data-kind="image"] [data-testid="file-card-thumb"]')).toHaveCount(3);
  await expect(second.locator('[data-testid="file-card"][data-kind="pdf"]')).toContainText("行程单.pdf");
  // Nothing spills sideways on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await second.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sent-attachments.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.screenshot({ path: info.outputPath("sent-attachments-dark.png") });

  // Tapping the picture opens its preview.
  await single.getByRole("button", { name: "预览 IMG_1378.png" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
