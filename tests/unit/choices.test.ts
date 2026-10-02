import { describe, expect, it } from "vitest";
import { parseChoices, splitChoiceBlocks } from "../../src/ui/src/choices.js";

describe("tappable answers in messages", () => {
  it("reads a JSON list or one answer per line, dropping duplicates and list markers", () => {
    expect(parseChoices('["Similac（雅培）", "Enfamil（美赞臣）", "Similac（雅培）"]')).toEqual(["Similac（雅培）", "Enfamil（美赞臣）"]);
    expect(parseChoices("- 继续下单\n- 先不买\n\n- 换个店看看")).toEqual(["继续下单", "先不买", "换个店看看"]);
    expect(parseChoices("1. 是\n2. 否")).toEqual(["是", "否"]);
  });

  it("refuses fewer than two, more than six, too long or non-text answers", () => {
    expect(parseChoices('["只有一个"]')).toBeNull();
    expect(parseChoices(JSON.stringify(["1", "2", "3", "4", "5", "6", "7"]))).toBeNull();
    expect(parseChoices(JSON.stringify(["短", "长".repeat(61)]))).toBeNull();
    expect(parseChoices('[1, 2]')).toBeNull();
    expect(parseChoices('{"a": 1}')).toBeNull();
  });

  it("splits a reply into prose and the answer list, leaving bad blocks as code", () => {
    const parts = splitChoiceBlocks('两家都有货。你要哪种？\n\n```choices\n["大瓶", "小瓶"]\n```');
    expect(parts).toEqual([{ kind: "text", text: "两家都有货。你要哪种？\n\n" }, { kind: "choices", options: ["大瓶", "小瓶"] }]);
    const bad = "```choices\n只有一个\n```";
    expect(splitChoiceBlocks(bad)).toEqual([{ kind: "text", text: bad }]);
  });
});
