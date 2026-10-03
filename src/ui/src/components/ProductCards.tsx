import { useEffect, useState } from "react";
import { api, API_CREDENTIALS } from "../api";
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

function ProductCard({ item, onOpenLink, onOpenFile }: { item: Product; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  const picture = useMessageImage(item.image);
  const local = item.image?.startsWith("/") ? item.image : null;
  const media = picture.url
    ? <img src={picture.url} alt={item.name} loading="lazy" />
    : (
      <span className={`product-placeholder${item.image && !picture.failed ? " loading" : ""}`} aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z" />
          <path d="M9 10V6.5a3 3 0 0 1 6 0V10" />
        </svg>
      </span>
    );
  return (
    <article className="product-card" role="listitem" aria-label={item.name}>
      {local && onOpenFile && picture.url
        ? <button type="button" className="product-media" onClick={() => onOpenFile(local)} aria-label={`查看 ${item.name} 的大图`}>{media}</button>
        : <div className="product-media">{media}</div>}
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
        {item.url && (onOpenLink
          ? <button type="button" className="product-link" onClick={() => onOpenLink(item.url!)}>去看看</button>
          : <a className="product-link" href={item.url} target="_blank" rel="noopener noreferrer">去看看</a>)}
      </div>
    </article>
  );
}

/** A ```products block: one card per item, a picture beside what matters for choosing. */
export function ProductCards({ items, onOpenLink, onOpenFile }: { items: Product[]; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  return (
    <div className="product-cards" role="list" aria-label="商品">
      {items.map((item, i) => <ProductCard key={i} item={item} onOpenLink={onOpenLink} onOpenFile={onOpenFile} />)}
    </div>
  );
}
