import { describe, expect, it } from "vitest";
import { replyPlainText } from "../../src/ui/src/replyText.js";
import { splitMessageParts } from "../../src/ui/src/messageParts.js";

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

describe("replyPlainText: a reply copied as plain text", () => {
  it("drops bold marks, including CJK bold that ends on full-width punctuation", () => {
    expect(replyPlainText("**明天晴，适合出游。**最高 24°C")).toBe("明天晴，适合出游。最高 24°C");
    expect(replyPlainText("*斜体* 和 ~~删掉~~ 和 `npm test`")).toBe("斜体 和 删掉 和 npm test");
  });

  it("writes a web link as label (url), keeps a bare url, and keeps only the words of a workspace file link", () => {
    expect(replyPlainText("[官网](https://www.sony.com/xm6)")).toBe("官网 (https://www.sony.com/xm6)");
    expect(replyPlainText("https://a.com/x")).toBe("https://a.com/x");
    expect(replyPlainText("[对比表](/home/gem/workspace/tasks/d2/对比.xlsx)")).toBe("对比表");
    expect(replyPlainText("[](/home/gem/workspace/tasks/d2/对比.xlsx)")).toBe("对比.xlsx");
    expect(replyPlainText("![](/home/gem/workspace/tasks/d2/图.png)")).toBe("图.png");
  });

  it("keeps a <br> as a line break, and as a space inside a table cell", () => {
    expect(replyPlainText("第一行<br>第二行")).toBe("第一行\n第二行");
    expect(replyPlainText("| 名称 | 说明 |\n| --- | --- |\n| A | 早<br/>晚 |")).toBe("名称\t说明\nA\t早 晚");
  });

  it("turns a table into tab-separated rows", () => {
    expect(replyPlainText("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |")).toBe("a\tb\n1\t2\n3\t4");
  });

  it("numbers ordered lists and indents nested bullets by two spaces", () => {
    expect(replyPlainText("1. x\n2. y")).toBe("1. x\n2. y");
    expect(replyPlainText("- 水果\n  - 苹果\n- 蔬菜")).toBe("- 水果\n  - 苹果\n- 蔬菜");
    expect(replyPlainText("- [x] 订票\n- [ ] 订酒店")).toBe("- [x] 订票\n- [ ] 订酒店");
  });

  it("keeps the code of a plain fence without the fence or language", () => {
    expect(replyPlainText("运行：\n\n" + fence("bash", "npm run build"))).toBe("运行：\n\nnpm run build");
    expect(replyPlainText(fence("python", "print('hi')"))).toBe("print('hi')");
  });

  it("keeps a card's name, source, price, text, points and link", () => {
    const cards = fence("cards", JSON.stringify([
      { title: "Sony XM6", subtitle: "Best Buy", text: "降噪最好", price: "$399", points: ["续航 30 小时"], url: "https://www.sony.com/xm6", image: "https://img.example/x.jpg", tags: ["新品"] },
      { title: "Bose QC Ultra", price: "$429" },
    ]));
    expect(replyPlainText("推荐：\n\n" + cards)).toBe("推荐：\n\nSony XM6\nBest Buy\n$399\n降噪最好\n- 续航 30 小时\nhttps://www.sony.com/xm6\n\nBose QC Ultra\n$429");
  });

  it("keeps a map's name and address, and an ask block's question", () => {
    expect(replyPlainText(fence("map", JSON.stringify({ name: "金门大桥", address: "Golden Gate Bridge, San Francisco", lat: 37.8199, lng: -122.4783 })))).toBe("金门大桥\nGolden Gate Bridge, San Francisco");
    expect(replyPlainText("还差一件事。\n\n" + fence("ask_user", JSON.stringify({ question: "几点出发？", options: ["9 点", "10 点"] })))).toBe("还差一件事。\n\n几点出发？");
  });

  it("leaves out answers to tap, forms, charts, svg, mermaid and camera cards", () => {
    const blocks = [
      fence("choices", JSON.stringify(["下单", "再看看"])),
      fence("form", JSON.stringify({ title: "订位", fields: [{ name: "date", label: "日期", type: "date" }] })),
      fence("chart", JSON.stringify({ type: "line", x: ["一", "二"], series: [{ name: "温度", data: [20, 22] }] })),
      fence("svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'),
      fence("mermaid", "flowchart TD\n  A-->B"),
      fence("camera", JSON.stringify({ camera: "camera.c201_go2rtc" })),
    ];
    const source = ["开头", ...blocks, "结尾"].join("\n\n");
    // Each block really is one of the drawn kinds, so leaving it out is not an accident of parsing.
    expect(splitMessageParts(source).map((p) => p.kind).filter((kind) => kind !== "text")).toEqual(["choices", "form", "chart", "svg", "mermaid", "camera"]);
    const text = replyPlainText(source);
    expect(text).toBe("开头\n\n结尾");
    for (const raw of ["```", "[{", '{"', "下单", "flowchart", "<svg"]) expect(text).not.toContain(raw);
  });

  it("keeps entities as the characters they stand for", () => {
    expect(replyPlainText("AT&T")).toBe("AT&T");
    expect(replyPlainText("a < b")).toBe("a < b");
    expect(replyPlainText("`x<y` & \"quoted\" 'single'")).toBe("x<y & \"quoted\" 'single'");
  });

  it("keeps a single newline inside a paragraph and separates paragraphs with a blank line", () => {
    expect(replyPlainText("第一行\n第二行\n\n\n\n下一段  ")).toBe("第一行\n第二行\n\n下一段");
    expect(replyPlainText("## 标题\n\n> 引用\n\n---\n\n正文")).toBe("标题\n\n引用\n\n正文");
  });
});
