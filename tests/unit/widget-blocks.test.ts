import { describe, expect, it } from "vitest";
import { parseWidget, splitWidgetBlocks } from "../../src/ui/src/widgetBlocks";

describe("widget blocks", () => {
  it("reads the component, its data as given and an optional title", () => {
    expect(parseWidget(JSON.stringify({ component: "flight-board", data: { flights: [{ no: "UA 857" }] }, title: "  今天的\n航班 " })))
      .toEqual({ component: "flight-board", data: { flights: [{ no: "UA 857" }] }, title: "今天的 航班" });
    expect(parseWidget(JSON.stringify({ component: "a" }))).toEqual({ component: "a", data: null, title: null });
    expect(parseWidget(JSON.stringify({ component: "x1", data: [1, 2], title: "" }))).toEqual({ component: "x1", data: [1, 2], title: null });
  });

  it("takes only a valid component name, and leaves anything else as a code block", () => {
    for (const component of ["", "-lead", "Upper", "a_b", "../x", "a/b", "a".repeat(64), 7]) expect(parseWidget(JSON.stringify({ component, data: {} }))).toBeNull();
    expect(parseWidget(JSON.stringify("flight-board"))).toBeNull();
    expect(parseWidget(JSON.stringify([{ component: "flight-board" }]))).toBeNull();
    expect(parseWidget("not json")).toBeNull();
    expect(splitWidgetBlocks("```widget\nnot json\n```")).toEqual([{ kind: "text", text: "```widget\nnot json\n```" }]);
    expect(splitWidgetBlocks('```widget\n{"component":"Bad Name"}\n```')).toEqual([{ kind: "text", text: '```widget\n{"component":"Bad Name"}\n```' }]);
  });

  it("splits a message around its widgets, in order", () => {
    const block = "```widget\n" + JSON.stringify({ component: "flight-board", data: { n: 1 } }) + "\n```";
    const parts = splitWidgetBlocks(`航班如下：\n${block}\n祝旅途顺利`);
    expect(parts.map((p) => p.kind)).toEqual(["text", "widget", "text"]);
    expect(parts[1]).toEqual({ kind: "widget", spec: { component: "flight-board", data: { n: 1 }, title: null } });
  });
});
