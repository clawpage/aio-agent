import { isWorkspaceFilePath, workspaceFileKind } from "./sandboxLink";

/**
 * Picture-and-text cards in messages: a few concrete things worth seeing side by
 * side, each with its picture: products to buy, places to go, hotels, restaurants,
 * events, articles, videos, posts, recipes, apps. (They began as product cards,
 * hence the module's name and the ```products alias.) An executor writes a fenced
 * block holding a JSON array (or {items: [...]}):
 *
 *   ```cards
 *   [{"title": "计算机历史博物馆", "image": "/home/gem/workspace/tasks/t1/chm.jpg",
 *     "subtitle": "Mountain View · 博物馆", "tags": ["周六 10:00–17:00", "免费停车"],
 *     "text": "从算盘到 AI 的计算机史，适合半天", "points": ["展区不让推车"],
 *     "url": "https://computerhistory.org", "action": "官网"}]
 *   ```
 *
 * A product also takes price, was (struck through) and rating. An image is a
 * workspace picture or an https URL (fetched by the account's own sandbox, never by
 * the browser); a link is https only. A block that does not parse stays an
 * ordinary code block.
 */

export interface Product {
  name: string;
  /** A workspace image path or an https URL. */
  image: string | null;
  /** Where it is from or what it is: a store, a place and kind, a source and author. */
  subtitle: string | null;
  /** Short facts shown as small labels: opening hours, distance, length, date. */
  tags: string[];
  /** A sentence or two about it. */
  text: string | null;
  price: string | null;
  /** The earlier or list price, shown struck through. */
  was: string | null;
  /** https only. */
  url: string | null;
  /** The link's label, when "去看看" does not fit (官网, 阅读原文, 预订). */
  action: string | null;
  rating: string | null;
  badge: string | null;
  points: string[];
  note: string | null;
}

export type ProductPart = { kind: "products"; items: Product[] };

export const MAX_PRODUCTS = 8;
const FENCE = /^```(?:cards|products)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

function text(value: unknown, max: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? [...value.trim().replace(/\s+/g, " ")].slice(0, max).join("") : null;
}

function https(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function image(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (path.startsWith("/")) return isWorkspaceFilePath(path) && workspaceFileKind(path) === "image" ? path : null;
  return https(path);
}

function product(raw: unknown): Product | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name ?? r.title, 80);
  if (!name) return null;
  const list = (value: unknown, max: number, count: number) => (Array.isArray(value) ? value : []).map((p) => text(p, max)).filter((p): p is string => !!p).slice(0, count);
  const points = list(r.points, 60, 4);
  return {
    name,
    image: image(r.image),
    subtitle: text(r.subtitle ?? r.store ?? r.shop ?? r.source, 60),
    tags: list(r.tags, 24, 4),
    text: text(r.text ?? r.description ?? r.summary, 200),
    price: text(r.price, 24),
    was: text(r.was ?? r.originalPrice, 24),
    url: https(r.url ?? r.link),
    action: text(r.action, 8),
    rating: text(r.rating, 30),
    badge: text(r.badge, 12),
    points,
    note: text(r.note, 120),
  };
}

/** The cards a block lists, or null when it is not a usable cards block. */
export function parseProducts(raw: string): Product[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : null;
  if (!list) return null;
  const items = list.map(product).filter((p): p is Product => !!p).slice(0, MAX_PRODUCTS);
  return items.length ? items : null;
}

/** Split a text part into text and picture-and-text cards, in order. */
export function splitProductBlocks(source: string): Array<{ kind: "text"; text: string } | ProductPart> {
  const parts: Array<{ kind: "text"; text: string } | ProductPart> = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const items = parseProducts(match[1]!);
    if (!items) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "products", items });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "products" || p.text.trim() !== "");
}
