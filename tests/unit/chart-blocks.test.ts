import { describe, expect, it } from "vitest";
import { CHART_MAX_POINTS, movingAverage, parseChart, splitChartBlocks } from "../../src/ui/src/chartBlocks.js";

const rows = [
  ["2026-10-13", 1287, 1288.48, 1268.11, 1274.89, 26573],
  ["2026-10-14", 1270.1, 1286.75, 1266, 1286, 23773],
  ["2026-10-15", 1286, 1317.76, 1282, 1312.97, 57677],
];

describe("chart blocks", () => {
  it("draws a candlestick block where it stands, between the prose", () => {
    const parts = splitChartBlocks(`茅台最近三天：\n\n\`\`\`chart\n${JSON.stringify({ type: "candlestick", title: "贵州茅台 日K", data: rows, ma: [5, 5, 1, 999] })}\n\`\`\`\n\n整体走高。`);
    expect(parts.map((p) => p.kind)).toEqual(["text", "chart", "text"]);
    const spec = parts[1]!.kind === "chart" ? parts[1]!.spec : null;
    expect(spec).toMatchObject({ type: "candlestick", title: "贵州茅台 日K", x: ["2026-10-13", "2026-10-14", "2026-10-15"], volume: [26573, 23773, 57677], ma: [5] });
    expect(spec?.type === "candlestick" && spec.ohlc[0]).toEqual([1287, 1288.48, 1268.11, 1274.89]);
  });

  it("takes the rows aio-market history prints, volume under any of its names", () => {
    const spec = parseChart(JSON.stringify({ type: "kline", data: [
      { date: "2026-10-15", open: 1286, high: 1317.76, low: 1282, close: 1312.97, volume_lots: 57677, change_pct: 2.1 },
      { date: "2026-10-16", open: "1311.57", high: 1321.97, low: 1301.68, close: 1313.05 },
      { date: "bad", open: null, high: 1, low: 1, close: 1 },
    ] }));
    expect(spec).toMatchObject({ type: "candlestick", x: ["2026-10-15", "2026-10-16"], volume: [57677, null] });
  });

  it("keeps line, bar and area series aligned to the x axis, with a right axis and stacking", () => {
    const spec = parseChart(JSON.stringify({ type: "bar", x: ["2023", "2024", "2025"], unit: "亿元", unitRight: "%", stack: true, series: [
      { name: "营收", data: [1505, 1741, "1801"] },
      { name: "增速", type: "line", axis: "right", data: [16.5, 15.7] },
    ] }));
    expect(spec).toMatchObject({ type: "cartesian", stack: true, unit: "亿元", unitRight: "%", series: [
      { name: "营收", type: "bar", data: [1505, 1741, 1801], axis: "left", area: false },
      { name: "增速", type: "line", data: [16.5, 15.7, null], axis: "right", area: false },
    ] });
    expect(parseChart(JSON.stringify({ type: "area", x: ["a"], series: [{ name: "s", data: [1] }] }))).toMatchObject({ series: [{ type: "line", area: true }] });
  });

  it("keeps only positive pie slices", () => {
    expect(parseChart(JSON.stringify({ type: "pie", data: [{ name: "A", value: 3 }, { name: "B", value: 0 }, { name: "C", value: "x" }] }))).toMatchObject({ type: "pie", items: [{ name: "A", value: 3 }] });
  });

  it("leaves anything that is not a chart as an ordinary code block", () => {
    for (const code of ["not json", "[1,2]", '{"type":"radar","data":[]}', '{"type":"line","x":["a"],"series":[{"data":[null]}]}', '{"type":"candlestick","data":[]}']) {
      expect(splitChartBlocks(`\`\`\`chart\n${code}\n\`\`\``)).toEqual([{ kind: "text", text: `\`\`\`chart\n${code}\n\`\`\`` }]);
    }
  });

  it("caps the points it keeps (the most recent bars) and the text lengths", () => {
    const many = Array.from({ length: CHART_MAX_POINTS + 50 }, (_, i) => [`d${i}`, 1, 2, 0.5, 1.5]);
    const spec = parseChart(JSON.stringify({ type: "candlestick", title: "x".repeat(500), data: many }));
    expect(spec?.type === "candlestick" && spec.x.length).toBe(CHART_MAX_POINTS);
    expect(spec?.type === "candlestick" && spec.x[0]).toBe("d50");
    expect(spec?.title?.length).toBe(80);
  });

  it("computes a simple moving average of the close", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
});
