import { describe, expect, it } from "vitest";
import { extractVideoLinks, MAX_VIDEOS, parseVideoUrl } from "../../src/ui/src/videoLinks.js";

describe("video links in a message", () => {
  it("finds YouTube and Bilibili videos linked or written bare, once each, and ignores code and other links", () => {
    const md = [
      "推荐：[3Blue1Brown 讲神经网络](https://www.youtube.com/watch?v=aircAruvnKk&t=1m30s)",
      "B 站版 https://www.bilibili.com/video/BV1bx411c7ux/?p=2&t=45",
      "重复：https://youtu.be/aircAruvnKk",
      "`https://www.youtube.com/watch?v=dQw4w9WgXcQ`",
      "```\nhttps://www.bilibili.com/video/BV1GJ411x7h7\n```",
      "[频道](https://www.youtube.com/@3blue1brown) [普通页面](https://example.com/watch?v=aircAruvnKk)",
    ].join("\n\n");
    expect(extractVideoLinks(md)).toEqual([
      {
        key: "youtube:aircAruvnKk", provider: "youtube", url: "https://www.youtube.com/watch?v=aircAruvnKk&t=1m30s", title: "3Blue1Brown 讲神经网络",
        embed: "https://www.youtube-nocookie.com/embed/aircAruvnKk?rel=0&playsinline=1&start=90",
      },
      {
        key: "bilibili:BV1bx411c7ux:2", provider: "bilibili", url: "https://www.bilibili.com/video/BV1bx411c7ux/?p=2&t=45", title: null,
        embed: "https://player.bilibili.com/player.html?bvid=BV1bx411c7ux&page=2&autoplay=0&high_quality=1&t=45",
      },
    ]);
  });

  it("reads every YouTube address shape and Bilibili av numbers", () => {
    for (const href of ["https://youtu.be/aircAruvnKk?si=x", "https://m.youtube.com/watch?v=aircAruvnKk", "https://www.youtube.com/shorts/aircAruvnKk", "https://www.youtube.com/embed/aircAruvnKk", "https://www.youtube.com/live/aircAruvnKk?feature=share"]) {
      expect(parseVideoUrl(href)?.key, href).toBe("youtube:aircAruvnKk");
    }
    expect(parseVideoUrl("https://m.bilibili.com/video/av170001")?.embed).toBe("https://player.bilibili.com/player.html?aid=170001&page=1&autoplay=0&high_quality=1");
  });

  it("refuses anything that is not one video, and never carries the link into the player address", () => {
    for (const href of [
      "https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=aircAruvnKk%22onload",
      "https://evil.example/youtube.com/watch?v=aircAruvnKk",
      "https://youtube.com.evil.example/watch?v=aircAruvnKk",
      "https://www.bilibili.com/bangumi/play/ep1",
      "https://www.bilibili.com/video/BV1bx411c7ux%2F..%2F",
      "https://b23.tv/abcdefg",
      "javascript:alert(1)",
    ]) {
      expect(parseVideoUrl(href), href).toBeNull();
    }
    expect(parseVideoUrl("https://www.youtube.com/watch?v=aircAruvnKk&t=<script>")?.embed).toBe("https://www.youtube-nocookie.com/embed/aircAruvnKk?rel=0&playsinline=1");
  });

  it("plays at most a few videos per message", () => {
    const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee", "fffffffffff"];
    expect(extractVideoLinks(ids.map((id) => `https://youtu.be/${id}`).join("\n\n"))).toHaveLength(MAX_VIDEOS);
  });
});
