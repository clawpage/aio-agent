import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CompareItem } from "../compareBlocks";
import { useMessageImage, useNearViewport } from "./ProductCards";
import { t } from "../i18n";
import { imageSampler, locateCrop, type CropBox } from "../cropAlign";

/**
 * A retouched photo against its original (```compare blocks). The result shows; press and
 * hold the picture (mouse, finger, or Space/Enter) to see the original, let go for the result.
 * "查看大图" opens the result in the file preview (which also downloads it). Both pictures come
 * through the image cache, loaded once they are near the screen, so the original is already
 * there when the picture is pressed.
 *
 * When the edit was cropped (the two differ in shape), the frame keeps the edit's shape and the
 * original is shown whole inside it, with the part the edit kept outlined and the rest dimmed.
 * Pressing zooms out from the edit to that view and letting go zooms back in, so the kept part
 * stays put on screen. Where the edit sits is found by comparing the two pictures once, when the
 * page is idle after both load (or on the first press); if it cannot be told, the original just
 * shows whole.
 */
function Compare({ item, index, total, onOpenFile }: { item: CompareItem; index: number; total: number; onOpenFile?: (path: string) => void }) {
  const root = useRef<HTMLElement>(null);
  const near = useNearViewport(root);
  const after = useMessageImage(near ? item.after : null);
  const before = useMessageImage(near ? item.before : null);
  const [holding, setHolding] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const [beforeRatio, setBeforeRatio] = useState<number | null>(null);
  const afterImg = useRef<HTMLImageElement>(null);
  const beforeImg = useRef<HTMLImageElement>(null);
  // undefined until the two have been compared; null when the edit is not a crop that can be placed.
  const [crop, setCrop] = useState<CropBox | null | undefined>(undefined);
  const cropped = ratio !== null && beforeRatio !== null && Math.abs(ratio / beforeRatio - 1) > 0.01;
  const align = () => {
    if (crop !== undefined || !cropped || !afterImg.current || !beforeImg.current) return;
    setCrop(locateCrop(imageSampler(beforeImg.current), beforeRatio, imageSampler(afterImg.current), ratio));
  };
  const alignLater = useRef(align);
  alignLater.current = align;
  useEffect(() => {
    if (!cropped) return;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => alignLater.current());
    return () => cancel(id);
  }, [cropped]);
  const press = () => { align(); setHolding(true); };
  const hold = (on: boolean) => () => setHolding(on);

  const name = item.title ?? (total > 1 ? t.cards.compare.numbered(index + 1) : null);
  const failed = after.failed || before.failed;
  const status = failed ? t.cards.compare.failed : !after.url || !before.url ? t.cards.compare.loading : null;
  const view = cropped && crop ? cropView(crop, beforeRatio!, ratio!) : null;

  return (
    <figure ref={root} className={view ? "photo-compare cropped" : "photo-compare"} aria-label={name ?? t.cards.compare.label}
      // The photo's shape sizes the whole figure, so title, picture and buttons line up on its edges.
      style={ratio ? ({ "--compare-ratio": String(ratio) } as CSSProperties) : undefined}>
      {name && <figcaption className="photo-compare-title">{name}</figcaption>}
      <div
        className="photo-compare-stage"
        role="button"
        tabIndex={0}
        aria-label={t.cards.compare.hold}
        aria-pressed={holding}
        onPointerDown={(event) => { if (event.button === 0) press(); }}
        onPointerUp={hold(false)}
        onPointerLeave={hold(false)}
        onPointerCancel={hold(false)}
        onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); press(); } }}
        onKeyUp={hold(false)}
        onBlur={hold(false)}
        // A long press is this card's own action: no system menu, and a message preview around it must not open the message.
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => event.preventDefault()}
      >
        {after.url && <img ref={afterImg} className="photo-compare-after" src={after.url} alt={t.cards.compare.after} draggable={false}
          style={view && holding ? { transform: view.toKept } : undefined}
          onLoad={(event) => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); }} />}
        {/* Always in the page, only hidden, so pressing shows it without a blank frame. */}
        {before.url && (
          <div className="photo-compare-original" style={{ opacity: holding ? 1 : 0, transform: view && !holding ? view.fromKept : undefined }}>
            <img ref={beforeImg} className="photo-compare-before" src={before.url} alt={t.cards.compare.before} draggable={false}
              onLoad={(event) => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setBeforeRatio(img.naturalWidth / img.naturalHeight); }} />
            {view && (
              <div className="photo-compare-fit" style={view.fit}>
                <div className="photo-compare-kept" style={view.kept} />
              </div>
            )}
          </div>
        )}
        {status
          ? <span className="photo-compare-status muted tiny" role="status">{status}</span>
          : <span className="photo-compare-hint" aria-hidden="true">{holding ? t.cards.compare.before : t.cards.compare.hold}</span>}
      </div>
      {onOpenFile && (
        <div className="photo-compare-bar">
          <button type="button" className="ghost tiny" onClick={() => onOpenFile(item.after)}>{t.cards.compare.open}</button>
        </div>
      )}
      {item.note && <p className="photo-compare-note">{item.note}</p>}
    </figure>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/**
 * Where things go for a cropped pair, in fractions of the frame (which has the edit's shape):
 * the original fitted whole inside it, the kept part on the original, and the transforms that
 * move the edit onto the kept part (while held) and the original so its kept part fills the
 * frame (while not), which is what makes the press a zoom.
 */
function cropView(crop: CropBox, beforeRatio: number, afterRatio: number) {
  const fw = Math.min(1, beforeRatio / afterRatio), fh = Math.min(1, afterRatio / beforeRatio);
  const fx = (1 - fw) / 2, fy = (1 - fh) / 2;
  // The kept part has the edit's shape, so its height follows from its width.
  const w = crop.w, h = (crop.w * beforeRatio) / afterRatio;
  const kx = fx + crop.x * fw, ky = fy + crop.y * fh, s = w * fw;
  return {
    fit: { left: pct(fx), top: pct(fy), width: pct(fw), height: pct(fh) } as CSSProperties,
    kept: { left: pct(crop.x), top: pct(crop.y), width: pct(w), height: pct(h) } as CSSProperties,
    toKept: `translate(${pct(kx)}, ${pct(ky)}) scale(${s})`,
    fromKept: `translate(${pct(-kx / s)}, ${pct(-ky / s)}) scale(${1 / s})`,
  };
}

export function PhotoCompare({ items, onOpenFile }: { items: CompareItem[]; onOpenFile?: (path: string) => void }) {
  return (
    <div className="photo-compares">
      {items.map((item, i) => <Compare key={`${item.before}\n${item.after}`} item={item} index={i} total={items.length} onOpenFile={onOpenFile} />)}
    </div>
  );
}
