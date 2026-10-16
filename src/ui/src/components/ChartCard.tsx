import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { saveFile } from "../saveFile";
import { chartHeight, type ChartSpec } from "../chartBlocks";
import type { MountedChart } from "../chartRender";

/** ECharts is large: it loads the first time a message holds a chart. */
let loading: Promise<typeof import("../chartRender")> | null = null;
function renderer() {
  loading ??= import("../chartRender");
  return loading;
}

async function save(chart: MountedChart, title: string | null): Promise<void> {
  const blob = await chart.png();
  const name = `${(title || t.cards.chart.defaultFileName).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60)}.png`;
  if (saveFile(blob, name)) return;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/**
 * A ```chart block from a message: a live chart (tap for values, a slider for
 * long histories) drawn from the numbers in the block, in the console's theme.
 */
export function ChartCard({ spec }: { spec: ChartSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedChart | null>(null);
  const [state, setState] = useState<"drawing" | "ready" | "failed">("drawing");
  useEffect(() => {
    let live = true;
    setState("drawing");
    renderer().then(({ mountChart }) => {
      if (!live || !host.current) return;
      mounted.current = mountChart(host.current, spec);
      setState("ready");
    }).catch(() => { if (live) setState("failed"); });
    return () => {
      live = false;
      mounted.current?.dispose();
      mounted.current = null;
    };
  }, [spec]);
  return (
    <figure className="chart-card" aria-label={t.cards.chart.label(spec.title ?? t.cards.chart.untitled)}>
      <div ref={host} className="chart-canvas" style={{ height: chartHeight(spec) }} />
      {state !== "ready" && <div className="chart-status muted tiny">{state === "drawing" ? t.cards.chart.drawing : t.cards.chart.failed}</div>}
      {state === "ready" && (
        <figcaption className="svg-actions">
          <button type="button" className="ghost tiny" onClick={() => mounted.current && void save(mounted.current, spec.title)}>{t.cards.chart.save}</button>
        </figcaption>
      )}
    </figure>
  );
}
