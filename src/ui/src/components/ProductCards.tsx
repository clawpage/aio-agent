import { useEffect, useRef, useState, type RefObject } from "react";
import { api, API_CREDENTIALS } from "../api";
import { isSandboxLink } from "../sandboxLink";
import { openNativeBrowser } from "../deviceBrowser";
import type { Product } from "../productBlocks";

/**
 * A picture a message shows: a workspace image through the authenticated document
 * endpoint, a web image through the account's sandbox (the console's CSP admits
 * no third-party image). Only an image response becomes the blob the <img> shows.
 */
export function useMessageImage(src: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    setState({ url: null, failed: false });
    if (!src) return;
    const controller = new AbortController();
    let url: string | null = null;
    void (async () => {
      try {
        const res = await fetch(src.startsWith("/") ? api.documentImageUrl(src) : api.webImageUrl(src), { credentials: API_CREDENTIALS, signal: controller.signal });
        if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("unavailable");
        const blob = await res.blob();
        if (!blob.size) throw new Error("empty");
        url = URL.createObjectURL(blob);
        setState({ url, failed: false });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) setState({ url: null, failed: true });
      }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [src]);
  return state;
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
  const media = picture.url ? <img src={picture.url} alt={item.name} loading="lazy" /> : <span className="product-loading" aria-hidden="true" />;
  return (
    <article ref={card} className={`product-card${pictured ? "" : " text-only"}`} role="listitem" aria-label={item.name}>
      {pictured && (local && onOpenFile && picture.url
        ? <button type="button" className="product-media" onClick={() => onOpenFile(local)} aria-label={`查看 ${item.name} 的大图`}>{media}</button>
        : <div className="product-media">{media}</div>)}
      <div className="product-body">
        <div className="product-title">
          {item.badge && <span className="product-badge">{item.badge}</span>}
          <span className="product-name">{item.name}</span>
        </div>
        {(item.price || item.was) && (
          <div className="product-price">
            {item.price && <strong>{item.price}</strong>}
            {item.was && <s aria-label={`原价 ${item.was}`}>{item.was}</s>}
          </div>
        )}
        {(item.store || item.rating) && (
          <div className="product-meta">
            {item.store && <span>{item.store}</span>}
            {item.rating && <span>★ {item.rating}</span>}
          </div>
        )}
        {item.points.length > 0 && <ul className="product-points">{item.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        {item.note && <p className="product-note">{item.note}</p>}
        {item.url && (onOpenLink && isSandboxLink(item.url)
          ? <button type="button" className="product-link" data-browser-link={item.url} onClick={() => onOpenLink(item.url!)}>去看看</button>
          : <a className="product-link" href={item.url} target="_blank" rel="noopener noreferrer" onClick={event => { if (openNativeBrowser(item.url!)) event.preventDefault(); }}>去看看</a>)}
      </div>
    </article>
  );
}

/** A ```products block: one card per item, its picture (when there is one) beside what matters for choosing. */
export function ProductCards({ items, onOpenLink, onOpenFile }: { items: Product[]; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  return (
    <div className="product-cards" role="list" aria-label="商品">
      {items.map((item, i) => <ProductCard key={i} item={item} onOpenLink={onOpenLink} onOpenFile={onOpenFile} />)}
    </div>
  );
}
