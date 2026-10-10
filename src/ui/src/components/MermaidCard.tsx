import { useEffect, useState } from "react";
import { SvgCard } from "./SvgCard";
import { t } from "../i18n";
import { themeColor } from "../themeColor";

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
/** Mermaid is large: it loads the first time a message holds a diagram. */
function mermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      // Labels are sanitised and links/clicks stay off.
      securityLevel: "strict",
      // A syntax error is ours to show (the source); Mermaid must not add its own error picture to the page.
      suppressErrorRendering: true,
      // Drawn for a phone: the console's indigo for steps, its amber for decisions, tight spacing and
      // rounded boxes, so a flow reads at a glance instead of as a tall grey strip. The picture keeps
      // a white page in both themes (see .svg-image), so its colours are the theme's fixed --diagram-* set.
      theme: "base",
      themeVariables: {
        fontSize: "14px",
        primaryColor: themeColor("--diagram-node"), primaryBorderColor: themeColor("--diagram-node-border"), primaryTextColor: themeColor("--diagram-text"),
        lineColor: themeColor("--diagram-line"), textColor: themeColor("--diagram-text"), edgeLabelBackground: themeColor("--paper"),
        clusterBkg: themeColor("--diagram-cluster"), clusterBorder: themeColor("--diagram-cluster-border"), titleColor: themeColor("--diagram-text"),
      },
      themeCSS: [
        ".node rect { rx: 10px; ry: 10px; }",
        `.node polygon { fill: ${themeColor("--diagram-decision")}; stroke: ${themeColor("--diagram-decision-border")}; }`,
        ".node .label, .nodeLabel { font-weight: 500; }",
        `.edgeLabel, .edgeLabel text { font-size: 12px; fill: ${themeColor("--diagram-text-dim")}; }`,
        `.cluster-label text { font-size: 12px; fill: ${themeColor("--diagram-text-dim")}; }`,
      ].join(" "),
      flowchart: { nodeSpacing: 22, rankSpacing: 30, padding: 10, diagramPadding: 6, curve: "basis" },
      // Plain SVG text, no <foreignObject>: the result is shown as an image and saved as a PNG.
      htmlLabels: false,
      fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif",
    });
    return m;
  });
  return loading;
}

/**
 * Mermaid sizes its drawing for a page (`width="100%"`, a max-width style), which
 * leaves an image with no size of its own: give it the size of its viewBox.
 */
export function sizedSvg(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/i, (root) => {
    const box = /\sviewBox\s*=\s*["']\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(root);
    if (!box) return root;
    const rest = root.slice(4).replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/\sstyle\s*=\s*"max-width:[^"]*"/i, "");
    return `<svg width="${Math.ceil(Number(box[1]))}" height="${Math.ceil(Number(box[2]))}"${rest}`;
  });
}

let queue: Promise<unknown> = Promise.resolve();
let seq = 0;
/** One diagram at a time: Mermaid renders through shared state. */
function draw(code: string): Promise<string> {
  const run = queue.then(async () => {
    const m = await mermaid();
    const { svg } = await m.render(`aio-mermaid-${++seq}`, code);
    return sizedSvg(svg);
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * A ```mermaid block from a message, drawn as a picture through the same card as
 * an ```svg block (an <img>, full screen, PNG download). When the syntax cannot
 * be drawn, its source is shown instead.
 */
export function MermaidCard({ code }: { code: string }) {
  const [state, setState] = useState<{ svg: string } | { error: true } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    draw(code).then((svg) => { if (live) setState({ svg }); }, () => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, [code]);
  if (state && "svg" in state) return <SvgCard code={state.svg} />;
  return (
    <figure className="svg-card mermaid-card">
      {state ? <pre className="svg-source"><code>{code}</code></pre> : <div className="mermaid-pending muted tiny">{t.cards.mermaid.drawing}</div>}
      {state && <figcaption className="svg-actions"><span className="muted tiny">{t.cards.mermaid.failed}</span></figcaption>}
    </figure>
  );
}
