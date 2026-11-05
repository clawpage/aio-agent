import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.shutdown(); });

describe("a Japanese console over real HTTP", () => {
  it("is refused in Japanese when signed out, from the console's language or the browser's", async () => {
    const own = await h.request("/api/schedules", { headers: { "x-aio-locale": "ja" } });
    expect(own.status).toBe(401);
    expect(await own.json()).toEqual({ error: "unauthenticated", message: "先にログインしてください" });
    const browser = await h.request("/api/schedules", { headers: { "accept-language": "ja-JP,ja;q=0.9,en;q=0.8" } });
    expect(browser.status).toBe(401);
    expect(await browser.json()).toMatchObject({ message: "先にログインしてください" });
  });

  it("follows the console's language over the browser's", async () => {
    const ja = await h.request("/api/schedules", { headers: { "x-aio-locale": "ja", "accept-language": "zh-CN,zh;q=0.9" } });
    expect(await ja.json()).toMatchObject({ message: "先にログインしてください" });
    const en = await h.request("/api/schedules", { headers: { "x-aio-locale": "en", "accept-language": "ja-JP" } });
    expect(await en.json()).toMatchObject({ message: "Please log in first" });
  });

  it("shows the built-in daily feed in Japanese", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/schedules", { headers: { cookie, "x-aio-locale": "ja" } });
    expect(res.status).toBe(200);
    const { schedules } = (await res.json()) as { schedules: Array<{ builtin: string | null; title: string; instruction: string; rule: string; nextRunText: string }> };
    const feed = schedules.find((s) => s.builtin === "daily_feed");
    expect(feed).toMatchObject({
      title: "デイリーフィード",
      instruction: "これまでのタスクをもとに、今日あなたが興味を持ちそうな内容と必要なリマインダーをまとめます",
      rule: expect.stringMatching(/^毎日 \d{2}:\d{2}$/),
      nextRunText: expect.stringMatching(/^\d{1,2}月\d{1,2}日（[月火水木金土日]）\d{2}:\d{2}$/),
    });
  });
});
