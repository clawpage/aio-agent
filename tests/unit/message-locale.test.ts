import { it, expect } from "vitest";
import { messageLocale } from "../../src/control/locale.js";

it("tells the language of a person's own message, for the notes added to what they read", () => {
  expect(messageLocale("質問遠慮なくどうぞ")).toBe("ja");
  expect(messageLocale("とりま全部読み込んで！ GitHub の repo")).toBe("ja");
  expect(messageLocale("帮我查一下这个价格")).toBe("zh-CN");
  expect(messageLocale("幫我查一下這個價格")).toBe("zh-TW");
  expect(messageLocale("把 https://example.com/a 的价格告诉我")).toBe("zh-CN");
  expect(messageLocale("¿Puedes revisar el precio?")).toBe("es");
  expect(messageLocale("quiero que lo hagas para mi familia")).toBe("es");
  expect(messageLocale("Can you check the price for me?")).toBe("en");
  expect(messageLocale("ok")).toBe("en");
  // Nothing to go by: the console's language decides.
  expect(messageLocale("https://example.com/only-a-link")).toBeNull();
  expect(messageLocale("12345 👍")).toBeNull();
});
