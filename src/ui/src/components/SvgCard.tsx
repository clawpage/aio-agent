import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * An SVG with no absolute width (only a viewBox, or a percentage) has no size of
 * its own as an image and collapses to a thumbnail: it takes the message's width.
 */
export function svgIsFluid(code: string): boolean {
  const root = /<svg\b[^>]*>/i.exec(code)?.[0] ?? "";
  return !/\swidth\s*=\s*["']?\s*\d+(\.\d+)?(px)?\s*["'\s/>]/i.test(root);
}

/** The drawing size an SVG declares: its absolute width and height, else its viewBox, else a 4:3 page. */
export function svgSize(code: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(code)?.[0] ?? "";
  const attr = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']?\\s*(\\d+(?:\\.\\d+)?)(?:px)?\\s*["'\\s/>]`, "i").exec(root);
    return m ? Number(m[1]) : null;
  };
  const width = attr("width");
  const height = attr("height");
  if (width && height) return { width, height };
  const box = /\sviewBox\s*=\s*["']\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(root);
  const vw = box ? Number(box[1]) : 0;
  const vh = box ? Number(box[2]) : 0;
  if (vw > 0 && vh > 0) return width ? { width, height: (width * vh) / vw } : { width: vw, height: vh };
  return { width: 800, height: 600 };
}

/** A file name from the drawing's <title>, or a plain one. */
function fileStem(code: string): string {
  const title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim();
  return (title || "图片").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}

/**
 * A PNG of the drawing on a white page, about 2000 px on its long side: a picture
 * people can keep in their photos. The SVG is re-sized before it is drawn so the
 * vectors render sharp; when the browser refuses (a tainted canvas, say) the SVG
 * itself is offered instead.
 */
async function pngOf(code: string): Promise<{ blob: Blob; ext: "png" | "svg" }> {
  const { width, height } = svgSize(code);
  const scale = Math.min(4, Math.max(1, 2000 / Math.max(width, height)));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const sized = code.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    const rest = attrs.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const box = /\sviewBox\s*=/i.test(rest) ? "" : ` viewBox="0 0 ${width} ${height}"`;
    return `<svg${rest}${box} width="${w}" height="${h}">`;
  });
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob) return { blob, ext: "png" };
    }
  } catch {
    // Fall through to the SVG itself.
  } finally {
    URL.revokeObjectURL(url);
  }
  return { blob: new Blob([code], { type: "image/svg+xml" }), ext: "svg" };
}

async function download(code: string): Promise<void> {
  const { blob, ext } = await pngOf(code);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `${fileStem(code)}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/** The drawing full screen: tap it to zoom in and pan, tap again to fit. */
function SvgViewer({ url, code, onClose }: { url: string; code: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { width, height } = useMemo(() => svgSize(code), [code]);
  // Zoomed in, the view starts at the middle of the drawing, not its corner.
  useEffect(() => {
    const el = stage.current;
    if (zoom && el) el.scrollTo({ left: (el.scrollWidth - el.clientWidth) / 2, top: (el.scrollHeight - el.clientHeight) / 2 });
  }, [zoom]);
  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  const ratio = width / height;
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label="查看大图">
      <div className="image-viewer-bar">
        <span className="image-viewer-hint">{zoom ? "拖动查看，点图缩回" : "点图放大"}</span>
        <button type="button" className="ghost" onClick={() => void download(code)}>下载</button>
        <button type="button" className="ghost" onClick={onClose} ref={close}>关闭</button>
      </div>
      <div ref={stage} className={`image-viewer-stage${zoom ? " zoomed" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className="image-viewer-page" style={{ aspectRatio: `${width} / ${height}`, width: zoom ? `max(200%, ${Math.round(width)}px)` : `min(100%, calc((100dvh - 72px) * ${ratio}))` }}>
          <img src={url} alt="大图" onClick={() => setZoom((z) => !z)} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One SVG from a message, drawn by an <img> from a blob: in an image an SVG runs
 * no script, loads nothing from the network and cannot reach the page. It opens
 * full screen and downloads as a PNG; its source is shown only when it cannot be drawn.
 */
export function SvgCard({ code }: { code: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [viewing, setViewing] = useState(false);
  const fluid = useMemo(() => svgIsFluid(code), [code]);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([code], { type: "image/svg+xml" }));
    setUrl(next);
    setBroken(false);
    return () => URL.revokeObjectURL(next);
  }, [code]);
  return (
    <figure className={`svg-card${fluid ? " svg-fluid" : ""}`}>
      {broken ? (
        <pre className="svg-source"><code>{code}</code></pre>
      ) : (
        url && (
          <button type="button" className="svg-open" onClick={() => setViewing(true)} aria-label="查看大图">
            <img className="svg-image" src={url} alt="SVG 图" onError={() => setBroken(true)} />
          </button>
        )
      )}
      <figcaption className="svg-actions">
        {broken ? <span className="muted tiny">这段 SVG 无法显示为图片，下面是源码</span> : (
          <>
            <button type="button" className="ghost tiny" onClick={() => setViewing(true)}>看大图</button>
            <button type="button" className="ghost tiny" onClick={() => void download(code)}>下载</button>
          </>
        )}
      </figcaption>
      {viewing && url && !broken && <SvgViewer url={url} code={code} onClose={() => setViewing(false)} />}
    </figure>
  );
}
