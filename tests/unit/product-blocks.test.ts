import { expect, it } from "vitest";
import { MAX_PRODUCTS, parseProducts, splitProductBlocks } from "../../src/ui/src/productBlocks.js";

const block = (json: unknown) => "```products\n" + JSON.stringify(json) + "\n```";

it("reads a products block into cards, keeping only safe pictures and links", () => {
  const items = parseProducts(JSON.stringify([
    { name: "  Roborock  Saros 10R ", image: "/home/gem/workspace/tasks/t1/saros.jpg", price: "$899", was: "$1,199", store: "Amazon", url: "https://www.amazon.com/dp/B0X", rating: "4.4（1,203 条）", badge: "最推荐", points: ["导航好", "", "地毯强", "a", "b", "c"], note: "避障一般" },
    { title: "Qrevo Curv 2 Flow", image: "https://m.media-amazon.com/images/I/x.jpg", price: 850, url: "javascript:alert(1)" },
    { name: "偷看系统", image: "/etc/passwd.jpg", url: "http://example.com/plain" },
    { image: "https://example.com/no-name.jpg" },
  ]));
  expect(items).toHaveLength(3);
  expect(items![0]).toEqual({ name: "Roborock Saros 10R", image: "/home/gem/workspace/tasks/t1/saros.jpg", subtitle: "Amazon", tags: [], text: null, price: "$899", was: "$1,199", url: "https://www.amazon.com/dp/B0X", action: null, rating: "4.4（1,203 条）", badge: "最推荐", points: ["导航好", "地毯强", "a", "b"], note: "避障一般" });
  // A web picture is fine (the sandbox fetches it); a script link never becomes a link.
  expect(items![1]).toMatchObject({ name: "Qrevo Curv 2 Flow", image: "https://m.media-amazon.com/images/I/x.jpg", price: "850", url: null });
  // Outside the workspace is no picture, and plain http is no link.
  expect(items![2]).toMatchObject({ image: null, url: null });
});

it("accepts {items: [...]}, caps the cards, and leaves anything unusable as code", () => {
  expect(parseProducts(JSON.stringify({ items: [{ name: "A" }] }))).toEqual([expect.objectContaining({ name: "A", image: null, points: [] })]);
  expect(parseProducts(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ name: `P${i}` }))))).toHaveLength(MAX_PRODUCTS);
  expect(parseProducts("not json")).toBeNull();
  expect(parseProducts(JSON.stringify([{ price: "$1" }]))).toBeNull();
  expect(parseProducts(JSON.stringify({ name: "单个对象不是列表" }))).toBeNull();
});

it("splits a message around its products blocks, in order", () => {
  const text = `先说结论：选 A。\n\n${block([{ name: "A", price: "$1" }, { name: "B" }])}\n\n怎么选：看预算。\n\n\`\`\`products\nbroken\n\`\`\``;
  const parts = splitProductBlocks(text);
  expect(parts.map((p) => p.kind)).toEqual(["text", "products", "text"]);
  expect(parts[1]).toMatchObject({ kind: "products", items: [{ name: "A" }, { name: "B" }] });
  // The broken block stays in the text as an ordinary code block.
  expect((parts[2] as { text: string }).text).toContain("```products\nbroken");
  expect(splitProductBlocks("没有卡片")).toEqual([{ kind: "text", text: "没有卡片" }]);
});

it("reads a cards block for anything worth a picture, not only things to buy", () => {
  const text = "下午去哪：\n\n```cards\n" + JSON.stringify([
    { title: "计算机历史博物馆", image: "/home/gem/workspace/tasks/t1/chm.jpg", subtitle: "Mountain View · 博物馆", tags: ["周六 10:00–17:00", "", "免费停车", "a", "b", "c"], text: "从算盘到 AI 的计算机史，适合半天。", points: ["展区不让推车"], url: "https://computerhistory.org/", action: "官网" },
    { title: "一篇文章", source: "Stratechery · Ben Thompson", description: "关于 AI 芯片的长文", url: "https://stratechery.com/x", action: "阅读原文，这个标签太长了" },
  ]) + "\n```";
  const parts = splitProductBlocks(text);
  expect(parts.map((p) => p.kind)).toEqual(["text", "products"]);
  const [place, article] = (parts[1] as { items: ReturnType<typeof parseProducts> & object }).items;
  expect(place).toEqual({ name: "计算机历史博物馆", image: "/home/gem/workspace/tasks/t1/chm.jpg", subtitle: "Mountain View · 博物馆", tags: ["周六 10:00–17:00", "免费停车", "a", "b"], text: "从算盘到 AI 的计算机史，适合半天。", price: null, was: null, url: "https://computerhistory.org/", action: "官网", rating: null, badge: null, points: ["展区不让推车"], note: null });
  // The usual other names are understood, and a link label stays short.
  expect(article).toMatchObject({ subtitle: "Stratechery · Ben Thompson", text: "关于 AI 芯片的长文", action: "阅读原文，这个标" });
});
