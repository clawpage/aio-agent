import { describe, expect, it } from "vitest";
import { AioClient, parseHttpUrl } from "../../src/control/aio/client.js";
import { Logger } from "../../src/common/logger.js";
import { runInLocale } from "../../src/control/i18n/index.js";

describe("AioClient capability inventory", () => {
  it("fetches the sandbox's list once and words it in each reader's language", async () => {
    let fetches = 0;
    const sandbox = {
      fetch: async (pathname: string) => {
        if (pathname === "/v1/openapi.json") fetches += 1;
        return new Response(JSON.stringify({ info: { version: "1.2.3" }, paths: { "/v1/shell/exec": { post: { summary: "Run" } } } }));
      },
    };
    const client = new AioClient(new Logger("error"), sandbox);
    const en = await client.buildInventory();
    const zh = await runInLocale("zh-CN", () => client.buildInventory());
    expect(en.groups.find((g) => g.id === "terminal")).toMatchObject({ title: "Terminal & shell", available: true });
    expect(zh.groups.find((g) => g.id === "terminal")?.title).toBe("终端与 Shell");
    expect(zh.groups.find((g) => g.id === "browser")?.surfaces[0]?.label).toBe("浏览器桌面（VNC）");
    expect(zh.sandboxVersion).toBe("1.2.3");
    // The second reader was served from the cache: one list fetch and one version fetch.
    expect(fetches).toBe(2);
  });
});

describe("parseHttpUrl", () => {
  it("refuses links that are not plain http/https, in the reader's language", () => {
    expect(parseHttpUrl("https://example.com/a")).toEqual({ ok: true, url: "https://example.com/a" });
    expect(parseHttpUrl("javascript:alert(1)")).toEqual({ ok: false, message: "Only http/https links are allowed" });
    expect(runInLocale("zh-CN", () => parseHttpUrl("https://u:p@example.com"))).toEqual({ ok: false, message: "链接不能包含用户名或密码" });
  });
});
