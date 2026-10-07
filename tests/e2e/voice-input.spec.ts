import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

// Chromium's fake microphone (a tone) stands in for a voice; the speech server is mocked.
test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });

async function open(page: Page, opts: { enabled?: boolean; heard?: string } = {}) {
  const posted: Buffer[] = [];
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } }));
  await page.route(url => url.pathname === "/api/asr", async r => {
    if (r.request().method() === "GET") return r.fulfill({ json: { enabled: opts.enabled ?? true } });
    posted.push(Buffer.from((r.request().postDataJSON() as { audioBase64: string }).audioBase64, "base64"));
    await r.fulfill({ json: { text: opts.heard ?? "打开走廊灯。" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  return posted;
}

test("records from the microphone, sends 16 kHz mono WAV and adds what was said to the draft", async ({ page }, info) => {
  const posted = await open(page);
  const composer = page.locator(".composer"), input = page.getByRole("textbox", { name: "消息", exact: true });
  const mic = composer.getByRole("button", { name: "语音输入" });
  await expect(mic).toBeVisible();
  await input.fill("已有内容，");
  await mic.click();
  const stop = composer.getByRole("button", { name: /停止录音/ });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(stop).toHaveClass(/recording/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("recording.png") });
  await stop.click();
  await expect(input).toHaveValue("已有内容，打开走廊灯。");
  await expect(mic).toBeEnabled();
  await expect(input).toBeFocused();

  expect(posted).toHaveLength(1);
  const wav = posted[0]!;
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.readUInt16LE(20)).toBe(1);          // PCM
  expect(wav.readUInt16LE(22)).toBe(1);          // mono
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt16LE(34)).toBe(16);
  const seconds = wav.readUInt32LE(40) / 2 / 16_000;
  expect(seconds).toBeGreaterThan(1);
  expect(seconds).toBeLessThan(5);
  // The fake microphone's tone is in there, not silence.
  let peak = 0;
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  expect(peak).toBeGreaterThan(1000);
  await page.screenshot({ path: info.outputPath("transcribed.png") });
});

test("says so when nothing was heard", async ({ page }) => {
  await open(page, { heard: "" });
  const mic = page.getByRole("button", { name: "语音输入" });
  await mic.click();
  await page.getByRole("button", { name: /停止录音/ }).click();
  await expect(page.getByRole("alert")).toContainText("没听清");
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
});

test("has no microphone when no speech recognizer is configured", async ({ page }) => {
  await open(page, { enabled: false });
  await expect(page.locator(".composer .file-button")).toBeVisible();
  await expect(page.getByRole("button", { name: "语音输入" })).toHaveCount(0);
});

test("on a phone the microphone sits beside send without covering the text", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"));
  await open(page);
  const composer = page.locator(".composer"), input = page.getByRole("textbox", { name: "消息", exact: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await input.evaluate(n => n.blur());
    const mic = (await composer.getByRole("button", { name: "语音输入" }).boundingBox())!;
    const send = (await composer.getByRole("button", { name: "发送", exact: true }).boundingBox())!;
    const attach = (await composer.locator(".file-button").boundingBox())!;
    expect(mic.width).toBeGreaterThanOrEqual(44);
    expect(mic.x + mic.width).toBeLessThanOrEqual(send.x + 1);
    expect(mic.x).toBeGreaterThan(attach.x + attach.width);
    const field = await input.evaluate(n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return { right: r.right - parseFloat(s.paddingRight) }; });
    expect(field.right).toBeLessThanOrEqual(mic.x + 1);
    await page.screenshot({ path: info.outputPath(`idle-${width}.png`) });
  }
});
