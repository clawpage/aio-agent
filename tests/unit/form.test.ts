import { describe, expect, it } from "vitest";
import { formAnswerText, missingFields, parseForm } from "../../src/common/form.js";
import { executorQuestion } from "../../src/control/tasks/executorQuestion.js";

const good = { title: "订位信息", fields: [
  { name: "date", label: "日期", type: "date", required: true },
  { name: "people", label: "人数", type: "number", min: 1, max: 20, default: 2 },
  { name: "area", label: "区域", type: "select", options: ["圣何塞", "旧金山"] },
  { name: "taste", label: "口味", type: "checkbox", options: ["川菜", "粤菜", "湘菜"], default: ["川菜", "日料"] },
  { label: "备注", type: "textarea" },
], submit: "去订" };

describe("forms", () => {
  it("reads a form, keeping only what is valid of each field", () => {
    const spec = parseForm(good)!;
    expect(spec.title).toBe("订位信息");
    expect(spec.submit).toBe("去订");
    expect(spec.fields.map((f) => [f.name, f.type, f.required])).toEqual([["date", "date", true], ["people", "number", false], ["area", "select", false], ["taste", "checkbox", false], ["f5", "textarea", false]]);
    expect(spec.fields[1]).toMatchObject({ min: 1, max: 20, default: "2" });
    // A default that is not one of the options is dropped.
    expect(spec.fields[3]!.default).toEqual(["川菜"]);
  });

  it("rejects a form that cannot be shown", () => {
    for (const bad of [null, [], {}, { fields: [] }, { fields: [{ type: "date" }] }, { fields: [{ label: "x", type: "color" }] },
      { fields: [{ label: "x", type: "select", options: ["只有一个"] }] }, { fields: [{ name: "a", label: "x" }, { name: "a", label: "y" }] },
      { fields: Array.from({ length: 9 }, (_, i) => ({ label: `字段${i}` })) }]) {
      expect(parseForm(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("sends the answers as one plain reply and names what is still missing", () => {
    const spec = parseForm(good)!;
    const values = { date: "2026-10-12", people: "4", area: "", taste: ["川菜", "粤菜"], f5: " 不吃辣 " };
    expect(formAnswerText(spec, values)).toBe("日期：2026-10-12\n人数：4\n口味：川菜、粤菜\n备注：不吃辣");
    expect(missingFields(spec, values)).toEqual([]);
    expect(missingFields(spec, { ...values, date: " " })).toEqual(["日期"]);
  });

  it("turns an ask_user question with fields into a form instead of choices", () => {
    const text = '先查了几家。\n```ask_user\n{"question":"请补充订位信息","options":["a","b"],"fields":[{"name":"date","label":"日期","type":"date","required":true},{"name":"people","label":"人数","type":"number"}]}\n```';
    const q = executorQuestion(text)!;
    expect(q).toMatchObject({ question: "请补充订位信息", options: null, result: "先查了几家。" });
    expect(q.form?.fields.map((f) => f.label)).toEqual(["日期", "人数"]);
    expect(executorQuestion('```ask_user\n{"question":"选哪个？","options":["a","b"]}\n```')).toMatchObject({ options: ["a", "b"], form: null });
  });
});
