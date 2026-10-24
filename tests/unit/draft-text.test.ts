import { describe, expect, it } from "vitest";
import { draftSource, nextDraft, type Draft } from "../../src/ui/src/draftText";

describe("draftSource", () => {
  it("keeps plain text and closed blocks as they are", () => {
    const text = "结论先说。\n\n```cards\n[{\"title\":\"A\"}]\n```\n\n后面一段";
    expect(draftSource(text)).toBe(text);
  });
  it("leaves out a block that has not closed yet", () => {
    expect(draftSource("先看这几家：\n\n```cards\n[{\"title\":\"A\",")).toBe("先看这几家：");
  });
  it("does not take a longer or different fence inside for the close", () => {
    expect(draftSource("a\n````md\n```\nstill inside")).toBe("a");
    expect(draftSource("a\n~~~\n```\n")).toBe("a");
    expect(draftSource("a\n```js\nx\n```js")).toBe("a");
  });
  it("drops a fence arriving a backtick at a time", () => {
    expect(draftSource("段落\n``")).toBe("段落");
    expect(draftSource("段落\n```")).toBe("段落");
  });
});

describe("draftSource feed lines", () => {
  it("cuts a daily feed's machine lines as they begin", () => {
    expect(draftSource("今天三件事。\n\n<!-- feed-topics: [\"a\"")).toBe("今天三件事。");
  });
});

describe("nextDraft", () => {
  const started = (id: string, phase: string) => ({ type: "item/started", payload: { item: { type: "agentMessage", id, text: "", phase } } });
  const delta = (itemId: string, d: string) => ({ type: "stream.delta", payload: { itemId, kind: "item/agentMessage/delta", delta: d } });
  const run = (events: Array<{ type: string; payload: unknown }>) => events.reduce(nextDraft, null as Draft);

  it("follows the final answer as its pieces arrive, and its completed text", () => {
    expect(run([started("c", "commentary"), delta("c", "我查一下"), started("f", "final_answer"), delta("f", "结论"), delta("f", "先说")])).toEqual({ item: "f", text: "结论先说" });
    expect(run([started("f", "final_answer"), delta("f", "结论"), { type: "item/completed", payload: { item: { type: "agentMessage", id: "f", text: "结论先说。" } } }, { type: "turn.finished", payload: {} }])).toEqual({ item: "f", text: "结论先说。" });
  });
  it("is nothing while the executor is still working out loud", () => {
    expect(run([started("c", "commentary"), delta("c", "我查一下")])).toBeNull();
  });
  it("drops the answer once anything starts after it, or a new turn begins", () => {
    expect(run([started("f", "final_answer"), delta("f", "旧答案"), { type: "turn.input_appended", payload: { text: "改成明天" } }])).toBeNull();
    expect(run([started("f", "final_answer"), delta("f", "旧答案"), { type: "item/started", payload: { item: { type: "commandExecution", id: "x" } } }])).toBeNull();
    expect(run([started("f", "final_answer"), delta("f", "上一轮"), { type: "turn.started", payload: {} }])).toBeNull();
  });
  it("starts each answer from empty, so a replay from the beginning is not doubled", () => {
    const events = [started("f", "final_answer"), delta("f", "结论")];
    expect(run([...events, ...events])).toEqual({ item: "f", text: "结论" });
  });
});
