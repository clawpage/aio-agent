import { useEffect, useMemo, useState } from "react";

/**
 * An SVG with no absolute width (only a viewBox, or a percentage) has no size of
 * its own as an image and collapses to a thumbnail: it takes the message's width.
 */
export function svgIsFluid(code: string): boolean {
  const root = /<svg\b[^>]*>/i.exec(code)?.[0] ?? "";
  return !/\swidth\s*=\s*["']?\s*\d+(\.\d+)?(px)?\s*["'\s/>]/i.test(root);
}

/**
 * One SVG from a message, drawn by an <img> from a blob: in an image an SVG runs
 * no script, loads nothing from the network and cannot reach the page. The
 * source stays one tap away, and is shown instead when the picture cannot be drawn.
 */
export function SvgCard({ code }: { code: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [broken, setBroken] = useState(false);
  const fluid = useMemo(() => svgIsFluid(code), [code]);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([code], { type: "image/svg+xml" }));
    setUrl(next);
    setBroken(false);
    return () => URL.revokeObjectURL(next);
  }, [code]);
  const showSource = source || broken;
  return (
    <figure className={`svg-card${fluid ? " svg-fluid" : ""}`}>
      {showSource ? (
        <pre className="svg-source"><code>{code}</code></pre>
      ) : (
        url && <img className="svg-image" src={url} alt="SVG 图" onError={() => setBroken(true)} />
      )}
      <figcaption className="svg-actions">
        {broken ? <span className="muted tiny">这段 SVG 无法显示为图片，下面是源码</span> : (
          <button type="button" className="ghost tiny" onClick={() => setSource((v) => !v)}>{source ? "看图" : "看源码"}</button>
        )}
      </figcaption>
    </figure>
  );
}
