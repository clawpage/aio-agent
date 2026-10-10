import { useEffect, useRef, useState, type RefObject } from "react";
import { cachedImage, holdImage } from "../imageCache";
import { isSandboxLink } from "../sandboxLink";
import { openNativeBrowser } from "../deviceBrowser";
import type { Product } from "../productBlocks";
import { t } from "../i18n";

/**
 * A picture a message shows: a workspace image through the authenticated document
 * endpoint, a web image through the account's sandbox (the console's CSP admits
 * no third-party image). Fetched once and shared through the image cache, so the
 * same picture in the feed, a task panel or the preview is not loaded again.
 */
export function useMessageImage(src: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ src: string | null; url: string | null; failed: boolean }>(() => ({ src, url: cachedImage(src), failed: false }));
  useEffect(() => {
    if (!src) return;
    let live = true;
    const held = holdImage(src);
    held.promise.then((url) => { if (live) setState({ src, url, failed: false }); }, () => { if (live) setState({ src, url: null, failed: true }); });
    return () => { live = false; held.release(); };
  }, [src]);
  // A different picture than the state holds: whatever the cache has for it, never the old one.
  return state.src === src ? { url: state.url, failed: state.failed } : { url: cachedImage(src), failed: false };
}

/** Whether an element has come near the viewport; it stays true once it has. */
function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver !== "function");
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: "300px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

function ProductCard({ item, onOpenLink, onOpenFile }: { item: Product; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  // A picture is fetched (through the sandbox for a web one) only once its card comes near the screen.
  const card = useRef<HTMLElement>(null);
  const picture = useMessageImage(useNearViewport(card) ? item.image : null);
  const local = item.image?.startsWith("/") ? item.image : null;
  // No picture, or one that could not be fetched: the card is laid out as text alone, never a stand-in image.
  const pictured = !!item.image && !picture.failed;
  // A product photo is a cut-out on white, shown whole; any other picture (a place, an article) fills its frame.
  const photo = !item.price && !item.was;
  const media = picture.url ? <img src={picture.url} alt={item.name} loading="lazy" /> : <span className="product-loading" aria-hidden="true" />;
  return (
    <article ref={card} className={`product-card${pictured ? "" : " text-only"}${photo ? " photo" : ""}`} role="listitem" aria-label={item.name}>
      {pictured && (local && onOpenFile && picture.url
        ? <button type="button" className="product-media" onClick={() => onOpenFile(local)} aria-label={t.cards.products.viewImage(item.name)}>{media}</button>
        : <div className="product-media">{media}</div>)}
      <div className="product-body">
        <div className="product-title">
          {item.badge && <span className="product-badge">{item.badge}</span>}
          <span className="product-name">{item.name}</span>
        </div>
        {(item.price || item.was) && (
          <div className="product-price">
            {item.price && <strong>{item.price}</strong>}
            {item.was && <s aria-label={t.cards.products.was(item.was)}>{item.was}</s>}
          </div>
        )}
        {(item.subtitle || item.rating) && (
          <div className="product-meta">
            {item.subtitle && <span>{item.subtitle}</span>}
            {item.rating && <span>★ {item.rating}</span>}
          </div>
        )}
        {item.tags.length > 0 && <div className="product-tags">{item.tags.map((tag, i) => <span key={i}>{tag}</span>)}</div>}
        {item.text && <p className="product-text">{item.text}</p>}
        {item.points.length > 0 && <ul className="product-points">{item.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        {item.note && <p className="product-note">{item.note}</p>}
        {item.url && (onOpenLink && isSandboxLink(item.url)
          ? <button type="button" className="product-link" data-browser-link={item.url} onClick={() => onOpenLink(item.url!)}>{item.action ?? t.cards.products.visit}</button>
          : <a className="product-link" href={item.url} target="_blank" rel="noopener noreferrer" onClick={event => { if (openNativeBrowser(item.url!)) event.preventDefault(); }}>{item.action ?? t.cards.products.visit}</a>)}
      </div>
    </article>
  );
}

/**
 * A ```cards (or ```products) block: one card per item, its picture (when there is
 * one) with what matters about it. Several cards sit in one row that scrolls sideways; with a
 * mouse, arrows at the ends page through it.
 */
export function ProductCards({ items, onOpenLink, onOpenFile }: { items: Product[]; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const several = items.length > 1;
  useEffect(() => {
    const el = row.current;
    if (!el || !several) return;
    const measure = () => setEnds({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => { el.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [several, items.length]);
  const page = (direction: 1 | -1) => { const el = row.current; if (el) el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" }); };
  return (
    <div className={`product-cards${several ? " product-row" : ""}`}>
      <div ref={row} className="product-track" role="list" aria-label={t.cards.products.list}>
        {items.map((item, i) => <ProductCard key={i} item={item} onOpenLink={onOpenLink} onOpenFile={onOpenFile} />)}
      </div>
      {several && !ends.start && <button type="button" className="product-page prev" aria-label={t.cards.products.prev} onClick={() => page(-1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>}
      {several && !ends.end && <button type="button" className="product-page next" aria-label={t.cards.products.next} onClick={() => page(1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>}
    </div>
  );
}
