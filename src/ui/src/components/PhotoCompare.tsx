import { useRef, useState, type CSSProperties } from "react";
import type { CompareItem } from "../compareBlocks";
import { useMessageImage, useNearViewport } from "./ProductCards";
import { t } from "../i18n";

/**
 * A retouched photo against its original (```compare blocks). The result shows; press and
 * hold the picture (mouse, finger, or Space/Enter) to see the original, let go for the result.
 * "查看大图" opens the result in the file preview (which also downloads it). Both pictures come
 * through the image cache, loaded once they are near the screen, so the original is already
 * there when the picture is pressed.
 */
function Compare({ item, index, total, onOpenFile }: { item: CompareItem; index: number; total: number; onOpenFile?: (path: string) => void }) {
  const root = useRef<HTMLElement>(null);
  const near = useNearViewport(root);
  const after = useMessageImage(near ? item.after : null);
  const before = useMessageImage(near ? item.before : null);
  const [holding, setHolding] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const hold = (on: boolean) => () => setHolding(on);

  const name = item.title ?? (total > 1 ? t.cards.compare.numbered(index + 1) : null);
  const failed = after.failed || before.failed;
  const status = failed ? t.cards.compare.failed : !after.url || !before.url ? t.cards.compare.loading : null;

  return (
    <figure ref={root} className="photo-compare" aria-label={name ?? t.cards.compare.label}
      // The photo's shape sizes the whole figure, so title, picture and buttons line up on its edges.
      style={ratio ? ({ "--compare-ratio": String(ratio) } as CSSProperties) : undefined}>
      {name && <figcaption className="photo-compare-title">{name}</figcaption>}
      <div
        className="photo-compare-stage"
        role="button"
        tabIndex={0}
        aria-label={t.cards.compare.hold}
        aria-pressed={holding}
        onPointerDown={(event) => { if (event.button === 0) setHolding(true); }}
        onPointerUp={hold(false)}
        onPointerLeave={hold(false)}
        onPointerCancel={hold(false)}
        onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setHolding(true); } }}
        onKeyUp={hold(false)}
        onBlur={hold(false)}
        // A long press is this card's own action: no system menu, and a message preview around it must not open the message.
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => event.preventDefault()}
      >
        {after.url && <img className="photo-compare-after" src={after.url} alt={t.cards.compare.after} draggable={false}
          onLoad={(event) => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); }} />}
        {/* Always in the page, only hidden, so pressing shows it without a blank frame. */}
        {before.url && <img className="photo-compare-before" src={before.url} alt={t.cards.compare.before} draggable={false}
          style={{ opacity: holding ? 1 : 0 }} />}
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

export function PhotoCompare({ items, onOpenFile }: { items: CompareItem[]; onOpenFile?: (path: string) => void }) {
  return (
    <div className="photo-compares">
      {items.map((item, i) => <Compare key={`${item.before}\n${item.after}`} item={item} index={i} total={items.length} onOpenFile={onOpenFile} />)}
    </div>
  );
}
