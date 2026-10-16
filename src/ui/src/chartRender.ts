import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, LineChart, PieChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { locale, t } from "./i18n";
import { themeColor } from "./themeColor";
import { CHART_WINDOW as WINDOW, movingAverage, type ChartSpec } from "./chartBlocks";

/**
 * Draws a ```chart block with ECharts on a canvas (loaded only when a message
 * holds a chart). Every label is canvas text and the tooltip is rich text, not
 * HTML, so nothing an executor wrote can become markup on the console's origin.
 */
echarts.use([CandlestickChart, LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, TitleComponent, CanvasRenderer]);


const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
const fine = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });

function fmt(value: number | null | undefined, unit?: string | null): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  const s = abs >= 100_000 ? compact.format(value) : abs >= 1 || abs === 0 ? plain.format(value) : fine.format(value);
  return unit ? (unit === "%" ? `${s}%` : `${s} ${unit}`) : s;
}

function palette(): string[] {
  return (["--chart-1", "--chart-2", "--chart-3", "--chart-5", "--chart-6", "--chart-4"] as const).map((name) => themeColor(name));
}

/** The header (title, note) and legend share the top; returns where the plot starts. */
function header(spec: ChartSpec, legend: string[] | boolean) {
  const text = themeColor("--text");
  const dim = themeColor("--text-dim");
  const titleH = (spec.title ? 22 : 0) + (spec.note ? 16 : 0);
  const legendTop = titleH ? titleH + 10 : 6;
  return {
    title: spec.title || spec.note
      ? { text: spec.title ?? "", subtext: spec.note ?? "", left: 4, top: 2, itemGap: 4, textStyle: { color: text, fontSize: 14, fontWeight: 600 }, subtextStyle: { color: dim, fontSize: 11 } }
      : undefined,
    legend: legend
      ? { ...(Array.isArray(legend) ? { data: legend } : {}), type: "scroll", top: legendTop, left: 4, right: 4, itemWidth: 14, itemHeight: 8, itemGap: 12, textStyle: { color: dim, fontSize: 11 }, pageTextStyle: { color: dim } }
      : undefined,
    top: legendTop + (legend ? 26 : 4) + (spec.unit ? 14 : 0),
  };
}

function axisStyle() {
  const dim = themeColor("--text-dim");
  return {
    axisLine: { lineStyle: { color: themeColor("--border-strong") } },
    axisTick: { show: false },
    axisLabel: { color: dim, fontSize: 10, hideOverlap: true },
    splitLine: { lineStyle: { color: themeColor("--chart-grid") } },
  };
}

function tooltip() {
  return {
    trigger: "axis" as const,
    renderMode: "richText" as const,
    confine: true,
    backgroundColor: themeColor("--bg-raised"),
    borderColor: themeColor("--border"),
    textStyle: { color: themeColor("--text"), fontSize: 12 },
    axisPointer: { type: "cross" as const, label: { show: false }, lineStyle: { color: themeColor("--text-dim") } },
  };
}

type Param = { dataIndex: number; seriesName: string; value: unknown };

function candlestickOption(spec: Extract<ChartSpec, { type: "candlestick" }>): EChartsCoreOption {
  const upRed = (spec.up ?? (locale.startsWith("zh") ? "red" : "green")) === "red";
  const rise = themeColor(upRed ? "--chart-red" : "--chart-green");
  const fall = themeColor(upRed ? "--chart-green" : "--chart-red");
  const colors = palette();
  const close = spec.ohlc.map((b) => b[3]);
  const mas = spec.ma.map((n, i) => ({ name: t.cards.chart.ma(n), data: movingAverage(close, n), color: colors[(i + 2) % colors.length]! }));
  const long = spec.x.length > WINDOW;
  // The legend names only the moving averages: the candles are the title, the volume its own strip.
  const head = header(spec, mas.length > 0 && mas.map((m) => m.name));
  const slider = long ? 34 : 0;
  const volH = spec.volume ? 56 : 0;
  const axis = axisStyle();
  // Both strips share one fixed width (room for the price labels on the right), so a day sits at the same x in each.
  const gridBase = { left: 6, right: 54, outerBoundsMode: "none" };
  // Price on top; volume (when given) in a short strip under it, sharing the dates.
  const grids: Array<Record<string, unknown>> = [{ ...gridBase, top: head.top, bottom: 8 + slider + (volH ? volH + 30 : 22) }];
  if (volH) grids.push({ ...gridBase, bottom: 8 + slider + 22, height: volH });
  const xAxes = grids.map((_, i) => ({
    type: "category", data: spec.x, gridIndex: i, boundaryGap: true, ...axis,
    axisLabel: { ...axis.axisLabel, show: i === grids.length - 1 }, splitLine: { show: false },
  }));
  const yAxes = grids.map((_, i) => ({
    type: "value", gridIndex: i, scale: true, position: "right", splitNumber: i === 0 ? 4 : 1, ...axis,
    axisLabel: { ...axis.axisLabel, show: i === 0, formatter: (v: number) => fmt(v) }, splitLine: { show: i === 0, ...axis.splitLine },
  }));
  const dir = (i: number) => (spec.ohlc[i]![3] >= (i > 0 ? spec.ohlc[i - 1]![3] : spec.ohlc[i]![0]) ? 1 : -1);
  return {
    animation: false,
    title: head.title,
    legend: head.legend,
    tooltip: {
      ...tooltip(),
      formatter: (params: Param[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const [o, h, l, c] = spec.ohlc[i]!;
        const prev = i > 0 ? spec.ohlc[i - 1]![3] : null;
        const lines = [
          spec.x[i]!,
          `${t.cards.chart.open} ${fmt(o)}  ${t.cards.chart.high} ${fmt(h)}`,
          `${t.cards.chart.low} ${fmt(l)}  ${t.cards.chart.close} ${fmt(c)}`,
        ];
        if (prev) lines.push(`${t.cards.chart.change} ${c >= prev ? "+" : ""}${((c / prev - 1) * 100).toFixed(2)}%`);
        if (spec.volume) lines.push(`${t.cards.chart.volume} ${fmt(spec.volume[i])}`);
        for (const m of mas) if (m.data[i] != null) lines.push(`${m.name} ${fmt(m.data[i])}`);
        return lines.join("\n");
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: long ? [{ type: "slider", xAxisIndex: xAxes.map((_, i) => i), bottom: 6, height: 20, startValue: spec.x.length - WINDOW, endValue: spec.x.length - 1, brushSelect: false, showDetail: false, borderColor: themeColor("--border"), fillerColor: themeColor("--hover"), dataBackground: { lineStyle: { color: themeColor("--text-dim") }, areaStyle: { color: themeColor("--hover") } } }] : [],
    series: [
      {
        type: "candlestick", name: spec.title ?? "", xAxisIndex: 0, yAxisIndex: 0,
        // ECharts takes [open, close, low, high].
        data: spec.ohlc.map(([o, h, l, c]) => [o, c, l, h]),
        itemStyle: { color: rise, color0: fall, borderColor: rise, borderColor0: fall },
        barMaxWidth: 12,
      },
      ...mas.map((m) => ({ type: "line", name: m.name, data: m.data, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, smooth: false, lineStyle: { width: 1, color: m.color }, itemStyle: { color: m.color } })),
      ...(spec.volume
        ? [{ type: "bar", name: t.cards.chart.volume, xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 12, data: spec.volume.map((v, i) => ({ value: v, itemStyle: { color: dir(i) > 0 ? rise : fall, opacity: 0.7 } })) }]
        : []),
    ],
  };
}

function cartesianOption(spec: Extract<ChartSpec, { type: "cartesian" }>): EChartsCoreOption {
  const colors = palette();
  const axis = axisStyle();
  const right = spec.series.some((s) => s.axis === "right");
  const head = header(spec, spec.series.length > 1);
  const long = spec.x.length > WINDOW && spec.series.some((s) => s.type === "bar");
  // The unit is named once above its axis; the ticks stay plain numbers.
  const value = (unit: string | null, position: "left" | "right", show: boolean) => ({
    type: "value", position, scale: !spec.series.some((s) => s.type === "bar"), ...axis,
    name: unit ?? "", nameGap: 8, nameTextStyle: { color: themeColor("--text-dim"), fontSize: 10, align: position },
    axisLabel: { ...axis.axisLabel, formatter: (v: number) => fmt(v) }, splitLine: { show, ...axis.splitLine },
  });
  return {
    animation: false,
    color: colors,
    title: head.title,
    legend: head.legend,
    tooltip: {
      ...tooltip(),
      formatter: (params: Param[]) => [spec.x[params[0]?.dataIndex ?? 0] ?? "", ...params.map((p) => {
        const s = spec.series.find((x) => x.name === p.seriesName);
        return `${p.seriesName ? `${p.seriesName} ` : ""}${fmt(p.value as number, s?.axis === "right" ? spec.unitRight : spec.unit)}`;
      })].join("\n"),
    },
    grid: { left: 4, right: 4, top: head.top, bottom: long ? 38 : 8, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    xAxis: { type: "category", data: spec.x, boundaryGap: spec.series.some((s) => s.type === "bar"), ...axis, splitLine: { show: false } },
    yAxis: right ? [value(spec.unit, "left", true), value(spec.unitRight, "right", false)] : value(spec.unit, "left", true),
    dataZoom: long ? [{ type: "slider", bottom: 6, height: 20, startValue: spec.x.length - WINDOW, endValue: spec.x.length - 1, brushSelect: false, showDetail: false, borderColor: themeColor("--border"), fillerColor: themeColor("--hover") }] : [],
    series: spec.series.map((s) => ({
      type: s.type, name: s.name, data: s.data, yAxisIndex: s.axis === "right" ? 1 : 0,
      ...(s.type === "bar" ? { barMaxWidth: 28, ...(spec.stack ? { stack: "total" } : {}) } : { showSymbol: spec.x.length <= 24, symbolSize: 5, connectNulls: true, lineStyle: { width: 2 } }),
      ...(s.area ? { areaStyle: { opacity: 0.15 } } : {}),
    })),
  };
}

function pieOption(spec: Extract<ChartSpec, { type: "pie" }>): EChartsCoreOption {
  const head = header(spec, false);
  const total = spec.items.reduce((sum, d) => sum + d.value, 0);
  const pct = (value: number) => `${((value / total) * 100).toFixed(1)}%`;
  const share = new Map(spec.items.map((d) => [d.name, pct(d.value)]));
  // Labels outside the ring do not fit a phone: percentages sit on the slices, names in the legend below.
  return {
    animation: false,
    color: palette(),
    title: head.title,
    tooltip: { ...tooltip(), trigger: "item", formatter: (p: { name: string; value: number }) => `${p.name}\n${fmt(p.value, spec.unit)} (${pct(p.value)})` },
    legend: {
      type: "scroll", bottom: 4, left: 4, right: 4, itemWidth: 10, itemHeight: 10, itemGap: 14,
      textStyle: { color: themeColor("--text-dim"), fontSize: 11 }, pageTextStyle: { color: themeColor("--text-dim") },
      formatter: (name: string) => `${name} ${share.get(name) ?? ""}`,
    },
    series: [{
      type: "pie", radius: ["36%", "66%"], center: ["50%", head.title ? "52%" : "46%"],
      itemStyle: { borderColor: themeColor("--bg-soft"), borderWidth: 2 },
      label: { position: "inside", color: themeColor("--on-media"), fontSize: 11, fontWeight: 600, formatter: (p: { percent: number }) => (p.percent >= 6 ? `${Math.round(p.percent)}%` : "") },
      labelLine: { show: false },
      data: spec.items,
    }],
  };
}

function optionOf(spec: ChartSpec): EChartsCoreOption {
  return spec.type === "candlestick" ? candlestickOption(spec) : spec.type === "pie" ? pieOption(spec) : cartesianOption(spec);
}

export type MountedChart = { dispose: () => void; png: () => Promise<Blob> };

/** Draws the chart into `el`, following its width and the console theme until disposed. */
export function mountChart(el: HTMLElement, spec: ChartSpec): MountedChart {
  const chart = echarts.init(el, undefined, { renderer: "canvas" });
  const draw = () => chart.setOption(optionOf(spec), { notMerge: true });
  draw();
  const resize = new ResizeObserver(() => chart.resize());
  resize.observe(el);
  // The theme switch rewrites <html data-theme>; the canvas has to be painted again in the new colors.
  const theme = new MutationObserver(draw);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return {
    dispose: () => {
      resize.disconnect();
      theme.disconnect();
      chart.dispose();
    },
    // Decoded here: the console's CSP does not let fetch() read a data: URL.
    png: async () => {
      const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: themeColor("--bg-soft") });
      const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (ch) => ch.charCodeAt(0));
      return new Blob([bytes], { type: "image/png" });
    },
  };
}
