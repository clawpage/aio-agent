import type { EChartsCoreOption } from "echarts/core";
import { axisStyle, mountOption, tooltip, type MountedChart } from "./chartRender";
import { themeColor } from "./themeColor";

/**
 * The owner dashboard's daily charts, drawn with the same ECharts build as the
 * charts in messages (chartRender.ts) and loaded only when the dashboard opens.
 * One value axis per chart; bars are capped at 24px with a rounded top, lines
 * are 2px; touching stacked segments are parted by a hairline in the surface color.
 */
export type DashSeries = {
  name: string;
  values: number[];
  type: "bar" | "line";
  /** A color token from theme.css, e.g. `--dash-series`. */
  color: `--${string}`;
  stack?: boolean;
};
export type DashChartSpec = { x: string[]; series: DashSeries[]; format: (n: number) => string };

type Param = { dataIndex: number; seriesName: string; value: unknown };

function option(spec: DashChartSpec): EChartsCoreOption {
  const axis = axisStyle();
  const surface = themeColor("--bg-soft");
  const stacked = spec.series.filter((s) => s.stack);
  const top = stacked.at(-1)?.name;
  return {
    animation: false,
    tooltip: {
      ...tooltip(),
      axisPointer: { type: "shadow", shadowStyle: { color: themeColor("--hover") } },
      // Values first, then the series: the reader already knows which line they are on.
      formatter: (params: Param[]) => [spec.x[params[0]?.dataIndex ?? 0] ?? "", ...params.map((p) => `${spec.format(Number(p.value) || 0)}  ${p.seriesName}`)].join("\n"),
    },
    grid: { left: 4, right: 8, top: 10, bottom: 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    xAxis: { type: "category", data: spec.x.map((d) => d.slice(5)), boundaryGap: true, ...axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, splitNumber: 3, ...axis, axisLine: { show: false }, axisLabel: { ...axis.axisLabel, formatter: (v: number) => spec.format(v) } },
    series: spec.series.map((s) => {
      const color = themeColor(s.color);
      return s.type === "bar"
        ? {
            type: "bar", name: s.name, data: s.values, barMaxWidth: 24, ...(s.stack ? { stack: "total" } : {}),
            itemStyle: { color, borderRadius: !s.stack || s.name === top ? [4, 4, 0, 0] : 0, borderColor: surface, borderWidth: s.stack ? 1 : 0 },
            emphasis: { itemStyle: { opacity: 0.85 } },
          }
        : {
            type: "line", name: s.name, data: s.values, z: 3, showSymbol: false, symbol: "circle", symbolSize: 8,
            lineStyle: { width: 2, color, cap: "round", join: "round" }, itemStyle: { color, borderColor: surface, borderWidth: 2 },
          };
    }),
  };
}

export function mountDashChart(el: HTMLElement, spec: DashChartSpec): MountedChart {
  return mountOption(el, () => option(spec));
}
