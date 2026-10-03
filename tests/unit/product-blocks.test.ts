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
  expect(items![0]).toEqual({ name: "Roborock Saros 10R", image: "/home/gem/workspace/tasks/t1/saros.jpg", price: "$899", was: "$1,199", store: "Amazon", url: "https://www.amazon.com/dp/B0X", rating: "4.4（1,203 条）", badge: "最推荐", points: ["导航好", "地毯强", "a", "b"], note: "避障一般" });
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
