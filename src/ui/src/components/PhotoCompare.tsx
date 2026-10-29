import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { CompareItem } from "../compareBlocks";
import { useMessageImage, useNearViewport } from "./ProductCards";
import { t } from "../i18n";

/**
 * A retouched photo against its original (```compare blocks). The result fills the
 * frame and the original covers it up to a handle: drag or tap anywhere to move it,
 * arrow keys too; hold "看原图" to see the whole original; or put the two side by
 * side. "查看大图" opens the result in the file preview (which also downloads it).
 * Both pictures come through the image cache, loaded once they are near the screen.
 */
function Compare({ item, index, total, onOpenFile }: { item: CompareItem; index: number; total: number; onOpenFile?: (path: string) => void }) {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const near = useNearViewport(root);
  const after = useMessageImage(near ? item.after : null);
  const before = useMessageImage(near ? item.before : null);
  const [side, setSide] = useState(false);
  const [pos, setPos] = useState(50);
  const [holding, setHolding] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const dragging = useRef(false);

  const moveTo = (clientX: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (box && box.width > 0) setPos(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
  };
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moveTo(event.clientX);
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => { if (dragging.current) moveTo(event.clientX); };
  const onUp = () => { dragging.current = false; };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: pos - 5, ArrowRight: pos + 5, Home: 0, End: 100 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPos(Math.min(100, Math.max(0, next)));
  };
  const hold = (on: boolean) => () => setHolding(on);

  const name = item.title ?? (total > 1 ? t.cards.compare.numbered(index + 1) : null);
  const failed = after.failed || before.failed;
  const status = failed ? t.cards.compare.failed : !after.url || !before.url ? t.cards.compare.loading : null;

  return (
    <figure ref={root} className={`photo-compare${side ? " side" : ""}`} aria-label={name ?? t.cards.compare.label}
      // The photo's shape sizes the whole figure, so title, picture and buttons line up on its edges.
      style={ratio ? ({ "--compare-ratio": String(ratio) } as CSSProperties) : undefined}>
      {name && <figcaption className="photo-compare-title">{name}</figcaption>}
      {side ? (
        <div className="photo-compare-side">
          {([["before", before.url], ["after", after.url]] as const).map(([which, url]) => (
            <div key={which} className="photo-compare-pane">
              {url && <img src={url} alt={which === "before" ? t.cards.compare.before : t.cards.compare.after} draggable={false} />}
              <span className={`photo-compare-label ${which}`}>{which === "before" ? t.cards.compare.before : t.cards.compare.after}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={stage}
          className="photo-compare-stage"
          role="slider"
          tabIndex={0}
          aria-label={t.cards.compare.slider}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={t.cards.compare.position(Math.round(pos))}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
          // Moving the handle is this card's own action: a message preview around it must not open the message.
          onClick={(event) => event.preventDefault()}
        >
          {after.url && <img className="photo-compare-after" src={after.url} alt={t.cards.compare.after} draggable={false}
            onLoad={(event) => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); }} />}
          {before.url && <img className="photo-compare-before" src={before.url} alt={t.cards.compare.before} draggable={false}
            style={{ clipPath: holding ? "none" : `inset(0 ${100 - pos}% 0 0)` }} />}
          {status && <span className="photo-compare-status muted tiny" role="status">{status}</span>}
          {!status && (holding
            ? <span className="photo-compare-label before">{t.cards.compare.before}</span>
            : <>
                <span className="photo-compare-label before" style={{ opacity: pos > 12 ? 1 : 0 }}>{t.cards.compare.before}</span>
                <span className="photo-compare-label after" style={{ opacity: pos < 88 ? 1 : 0 }}>{t.cards.compare.after}</span>
                <span className="photo-compare-handle" style={{ left: `${pos}%` }} aria-hidden="true"><span /></span>
              </>)}
        </div>
      )}
      <div className="photo-compare-bar">
        <button type="button" className="ghost tiny" aria-pressed={side} onClick={() => { setSide((v) => !v); setHolding(false); }}>
          {side ? t.cards.compare.sliderMode : t.cards.compare.sideMode}
        </button>
        {!side && (
          <button type="button" className="ghost tiny photo-compare-hold" aria-pressed={holding}
            onPointerDown={hold(true)} onPointerUp={hold(false)} onPointerLeave={hold(false)} onPointerCancel={hold(false)}
            onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setHolding(true); } }}
            onKeyUp={hold(false)} onBlur={hold(false)} onContextMenu={(event) => event.preventDefault()}>
            {t.cards.compare.hold}
          </button>
        )}
        {onOpenFile && <button type="button" className="ghost tiny" onClick={() => onOpenFile(item.after)}>{t.cards.compare.open}</button>}
      </div>
      {item.note && <p className="photo-compare-note">{item.note}</p>}
    </figure>
  );
}

export function PhotoCompare({ items, onOpenFile }: { items: CompareItem[]; onOpenFile?: (path: string) => void }) {
  return (
    <div className="photo-compares">
      {items.map((item, i) => <Compare key={`${item.before}\n${item.after}`} item={item} index={i} total={items.length} onOpenFile={onOpenFile} />)}
    </div>
  );
}
