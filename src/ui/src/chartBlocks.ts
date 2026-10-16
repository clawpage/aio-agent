/**
 * Data charts in messages, drawn by the console from numbers (never a picture
 * the executor made). An executor writes a fenced block holding JSON:
 *
 *   ```chart
 *   {"type": "candlestick", "title": "贵州茅台 日K（前复权）", "note": "东方财富 · 截至 2026-10-16",
 *    "data": [["2026-10-14", 1270.1, 1286.75, 1266, 1286, 23773], ...], "ma": [5, 20]}
 *   ```
 *
 * - candlestick: `data` rows are [date, open, high, low, close, volume?] or
 *   objects {date, open, high, low, close, volume | volume_lots | volume_shares}
 *   (the rows `aio-market history` prints); `ma` adds moving averages of the close;
 *   `up` says which color is a rise ("red" as on Chinese markets, or "green").
 * - line / bar / area: `x` is the category axis, `series` is
 *   [{name, data, type?: "line" | "bar", axis?: "right"}]; `stack` stacks bars.
 * - pie: `data` is [{name, value}].
 *
 * `title`, `note` (source and as-of time) and `unit` (shown on the value axis)
 * are optional. Everything is checked and capped here; a block that does not
 * parse stays an ordinary code block.
 */

export type CartesianSeries = { name: string; data: Array<number | null>; type: "line" | "bar"; area: boolean; axis: "left" | "right" };

type Common = { title: string | null; note: string | null; unit: string | null };

export type ChartSpec =
  | (Common & {
      type: "candlestick";
      x: string[];
      /** [open, high, low, close] per bar. */
      ohlc: Array<[number, number, number, number]>;
      volume: Array<number | null> | null;
      ma: number[];
      up: "red" | "green" | null;
    })
  | (Common & { type: "cartesian"; x: string[]; series: CartesianSeries[]; stack: boolean; unitRight: string | null })
  | (Common & { type: "pie"; items: Array<{ name: string; value: number }> });

export type ChartPart = { kind: "text"; text: string } | { kind: "chart"; spec: ChartSpec };

export const CHART_MAX_CHARS = 300_000;
export const CHART_MAX_POINTS = 2_000;
export const CHART_MAX_SERIES = 8;
export const CHART_MAX_SLICES = 12;
/** Bars shown at once before the rest scroll behind a slider. */
export const CHART_WINDOW = 60;

const FENCE = /^```chart[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

function text(value: unknown, max: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? [...value.trim().replace(/\s+/g, " ")].slice(0, max).join("") : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function common(raw: Record<string, unknown>): Common {
  return { title: text(raw.title, 80), note: text(raw.note, 200), unit: text(raw.unit, 12) };
}

function candlestick(raw: Record<string, unknown>): ChartSpec | null {
  if (!Array.isArray(raw.data)) return null;
  const x: string[] = [];
  const ohlc: Array<[number, number, number, number]> = [];
  const volume: Array<number | null> = [];
  for (const row of raw.data.slice(-CHART_MAX_POINTS)) {
    const r = row as Record<string, unknown>;
    const cells = Array.isArray(row) ? row : [r?.date, r?.open, r?.high, r?.low, r?.close, r?.volume ?? r?.volume_lots ?? r?.volume_shares];
    const date = text(cells[0], 32);
    const [o, h, l, c] = cells.slice(1, 5).map(num);
    if (date === null || o == null || h == null || l == null || c == null) continue;
    x.push(date);
    ohlc.push([o, h, l, c]);
    volume.push(num(cells[5]));
  }
  if (ohlc.length === 0) return null;
  const ma = Array.isArray(raw.ma) ? [...new Set(raw.ma.map(num).filter((n): n is number => n !== null && Number.isInteger(n) && n >= 2 && n <= 250))].slice(0, 4) : [];
  const up = raw.up === "red" || raw.up === "green" ? raw.up : null;
  return { type: "candlestick", ...common(raw), x, ohlc, volume: volume.some((v) => v !== null) ? volume : null, ma, up };
}

function cartesian(raw: Record<string, unknown>, kind: "line" | "bar" | "area"): ChartSpec | null {
  if (!Array.isArray(raw.x) || !Array.isArray(raw.series)) return null;
  const x = raw.x.slice(0, CHART_MAX_POINTS).map((v) => text(v, 32) ?? "");
  if (x.length === 0) return null;
  const series: CartesianSeries[] = [];
  for (const s of raw.series.slice(0, CHART_MAX_SERIES)) {
    const r = (s ?? {}) as Record<string, unknown>;
    if (!Array.isArray(r.data)) continue;
    const type = r.type === "bar" || r.type === "line" ? r.type : kind === "bar" ? "bar" : "line";
    series.push({
      name: text(r.name, 40) ?? "",
      data: x.map((_, i) => num((r.data as unknown[])[i])),
      type,
      area: type === "line" && (r.type === "area" || (kind === "area" && r.type === undefined)),
      axis: r.axis === "right" ? "right" : "left",
    });
  }
  if (!series.some((s) => s.data.some((v) => v !== null))) return null;
  return { type: "cartesian", ...common(raw), x, series, stack: raw.stack === true, unitRight: text(raw.unitRight, 12) };
}

function pie(raw: Record<string, unknown>): ChartSpec | null {
  if (!Array.isArray(raw.data)) return null;
  const items = raw.data
    .map((d) => ({ name: text((d as Record<string, unknown>)?.name, 40) ?? "", value: num((d as Record<string, unknown>)?.value) }))
    .filter((d): d is { name: string; value: number } => d.value !== null && d.value > 0)
    .slice(0, CHART_MAX_SLICES);
  return items.length ? { type: "pie", ...common(raw), items } : null;
}

/** The chart a block describes, or null when it is not one. */
export function parseChart(code: string): ChartSpec | null {
  if (code.length > CHART_MAX_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "candlestick":
    case "kline":
      return candlestick(r);
    case "line":
    case "bar":
    case "area":
      return cartesian(r, r.type);
    case "pie":
      return pie(r);
    default:
      return null;
  }
}

/** Split text into prose and charts, in order. */
export function splitChartBlocks(source: string): ChartPart[] {
  const parts: ChartPart[] = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const spec = parseChart(match[1]!);
    if (!spec) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "chart", spec });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "chart" || p.text.trim() !== "");
}

/** Simple moving average of the close; null until a full window exists. */
export function movingAverage(close: number[], n: number): Array<number | null> {
  let sum = 0;
  return close.map((c, i) => {
    sum += c;
    if (i >= n) sum -= close[i - n]!;
    return i >= n - 1 ? Math.round((sum / n) * 1e4) / 1e4 : null;
  });
}

/** The room a chart takes in the message, known before the chart library loads so the feed does not jump. */
export function chartHeight(spec: ChartSpec): number {
  const extra = (spec.title ? 22 : 0) + (spec.note ? 16 : 0);
  if (spec.type === "candlestick") return 300 + extra + (spec.volume ? 40 : 0) + (spec.x.length > CHART_WINDOW ? 30 : 0) + (spec.ma.length ? 26 : 0);
  if (spec.type === "pie") return 260 + extra;
  return 240 + extra + (spec.series.length > 1 ? 26 : 0) + (spec.x.length > CHART_WINDOW ? 30 : 0);
}
