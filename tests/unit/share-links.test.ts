import { describe, expect, it } from "vitest";
import { extractShareLinks, isShareUrl } from "../../src/ui/src/shareLinks.js";

describe("share links in a message", () => {
  it("finds share pages linked or written bare, once each, and ignores code and other links", () => {
    const md = [
      "做好了：[东京行程](https://agent-workspace.clawpage.ai/u/owner/share/tokyo-trip/)",
      "直接链接 https://agent-workspace.clawpage.ai/u/cr/share?notes",
      "重复：[再看一次](https://agent-workspace.clawpage.ai/u/owner/share/tokyo-trip/)",
      "`https://agent-workspace.clawpage.ai/u/owner/share/in-code/`",
      "[普通页面](https://example.com/u/owner/shared/x/)",
    ].join("\n\n");
    expect(extractShareLinks(md)).toEqual([
      { url: "https://agent-workspace.clawpage.ai/u/owner/share/tokyo-trip/", title: "东京行程" },
      { url: "https://agent-workspace.clawpage.ai/u/cr/share?notes", title: "分享页面" },
    ]);
  });
  it("accepts only the share address shapes", () => {
    expect(isShareUrl("https://h/u/owner/share/a-b/")).toBe(true);
    expect(isShareUrl("https://h/u/owner/share/a-b")).toBe(true);
    expect(isShareUrl("https://h/u/owner/share/a-b/style.css")).toBe(false);
    expect(isShareUrl("https://h/u/owner/share/Bad_Name/")).toBe(false);
    expect(isShareUrl("javascript:alert(1)//h/u/owner/share/x/")).toBe(false);
  });
});
