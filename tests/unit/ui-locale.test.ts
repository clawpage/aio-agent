import { describe, expect, it } from "vitest";
import { LOCALES, matchLocale, systemLocale } from "../../src/ui/src/i18n";

describe("the console's language", () => {
  it("matches system language tags to the languages it speaks", () => {
    expect(matchLocale("zh")).toBe("zh-CN");
    expect(matchLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(matchLocale("zh-Hant-HK")).toBe("zh-TW");
    expect(matchLocale("zh-TW")).toBe("zh-TW");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("es-419")).toBe("es");
    expect(matchLocale("ja")).toBe("ja");
    expect(matchLocale("ja-JP")).toBe("ja");
    expect(matchLocale("JA-jp")).toBe("ja");
    expect(matchLocale("jav")).toBeNull();
    expect(matchLocale("ko-KR")).toBeNull();
  });

  it("takes the first system language it speaks, English when none", () => {
    expect(systemLocale(["ja-JP", "en-US"])).toBe("ja");
    expect(systemLocale(["ko-KR", "ja"])).toBe("ja");
    expect(systemLocale(["ko-KR"])).toBe("en");
    expect(systemLocale([])).toBe("en");
  });

  it("names Japanese in Japanese in the language picker", () => {
    expect(LOCALES.ja.settings.language.name).toBe("日本語");
  });
});
