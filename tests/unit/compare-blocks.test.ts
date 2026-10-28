import { describe, expect, it } from "vitest";
import { parseCompare, splitCompareBlocks } from "../../src/ui/src/compareBlocks";

const before = "/home/gem/workspace/uploads/IMG_1.jpg";
const after = "/home/gem/workspace/tasks/task_1/IMG_1-修图.jpg";

describe("compare blocks", () => {
  it("reads items, an array or a single pair, with an optional title and note", () => {
    expect(parseCompare(JSON.stringify({ items: [{ before, after, title: "海边夕阳", note: "  提亮人物，\n压回天空 " }] }))).toEqual([{ before, after, title: "海边夕阳", note: "提亮人物， 压回天空" }]);
    expect(parseCompare(JSON.stringify([{ before, after }]))).toEqual([{ before, after, title: null, note: null }]);
    expect(parseCompare(JSON.stringify({ original: before, result: after }))).toEqual([{ before, after, title: null, note: null }]);
  });

  it("takes only workspace pictures, and leaves anything else as a code block", () => {
    expect(parseCompare(JSON.stringify({ before: "https://evil.example/a.jpg", after }))).toBeNull();
    expect(parseCompare(JSON.stringify({ before: "/home/gem/workspace/../../etc/passwd.jpg", after }))).toBeNull();
    expect(parseCompare(JSON.stringify({ before: "/home/gem/workspace/a.pdf", after }))).toBeNull();
    expect(parseCompare(JSON.stringify({ before }))).toBeNull();
    // One bad pair does not take the good ones with it.
    expect(parseCompare(JSON.stringify({ items: [{ before, after: "/etc/x.jpg" }, { before, after }] }))).toHaveLength(1);
    expect(splitCompareBlocks("```compare\nnot json\n```")).toEqual([{ kind: "text", text: "```compare\nnot json\n```" }]);
  });

  it("splits a message around its comparisons, in order", () => {
    const block = "```compare\n" + JSON.stringify({ items: [{ before, after }] }) + "\n```";
    const parts = splitCompareBlocks(`修好了：\n${block}\n[全部照片](/home/gem/workspace/tasks/task_1/photos.zip)`);
    expect(parts.map((p) => p.kind)).toEqual(["text", "compare", "text"]);
    expect(parts[1]).toEqual({ kind: "compare", items: [{ before, after, title: null, note: null }] });
  });
});
