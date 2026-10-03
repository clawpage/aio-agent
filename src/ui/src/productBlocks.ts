import { isWorkspaceFilePath, workspaceFileKind } from "./sandboxLink";

/**
 * Product cards in messages: comparisons and recommendations of things to buy or
 * book. An executor writes a fenced block holding a JSON array (or {items: [...]}):
 *
 *   ```products
 *   [{"name": "Roborock Saros 10R", "image": "/home/gem/workspace/tasks/t1/saros.jpg",
 *     "price": "$899", "was": "$1,199", "store": "Amazon", "url": "https://…",
 *     "rating": "4.4（1,203 条）", "badge": "最推荐", "points": ["导航好", "地毯强"], "note": "避障一般"}]
 *   ```
 *
 * An image is a workspace picture or an https URL (fetched by the account's own
 * sandbox, never by the browser); a link is https only. A block that does not
 * parse stays an ordinary code block.
 */

export interface Product {
  name: string;
  /** A workspace image path or an https URL. */
  image: string | null;
  price: string | null;
  /** The earlier or list price, shown struck through. */
  was: string | null;
  store: string | null;
  /** https only. */
  url: string | null;
  rating: string | null;
  badge: string | null;
  points: string[];
  note: string | null;
}

export type ProductPart = { kind: "products"; items: Product[] };

export const MAX_PRODUCTS = 8;
const FENCE = /^```products[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

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
  const points = (Array.isArray(r.points) ? r.points : []).map((p) => text(p, 60)).filter((p): p is string => !!p).slice(0, 4);
  return {
    name,
    image: image(r.image),
    price: text(r.price, 24),
    was: text(r.was ?? r.originalPrice, 24),
    store: text(r.store ?? r.shop, 40),
    url: https(r.url ?? r.link),
    rating: text(r.rating, 30),
    badge: text(r.badge, 12),
    points,
    note: text(r.note, 120),
  };
}

/** The products a block lists, or null when it is not a usable products block. */
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

/** Split a text part into text and product cards, in order. */
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
