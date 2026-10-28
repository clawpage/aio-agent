import { isWorkspaceFilePath, workspaceFileKind } from "./sandboxLink";

/**
 * Before/after comparisons in messages: a retouched photo next to its original.
 * An executor (the aio-photo skill) writes a fenced block holding {items: [...]},
 * a JSON array, or one item:
 *
 *   ```compare
 *   {"items": [{"before": "/home/gem/workspace/uploads/IMG_1.jpg",
 *               "after": "/home/gem/workspace/tasks/t1/IMG_1-修图.jpg",
 *               "title": "海边夕阳", "note": "提亮人物，压回天空"}]}
 *   ```
 *
 * Both pictures are workspace images, loaded through the authenticated document
 * endpoint like any picture in a message. A block that does not parse stays an
 * ordinary code block.
 */

export interface CompareItem {
  before: string;
  after: string;
  title: string | null;
  note: string | null;
}

export type ComparePart = { kind: "compare"; items: CompareItem[] };

const FENCE = /^```(?:compare|before-after)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const MAX_ITEMS = 60;

const image = (value: unknown): string | null =>
  typeof value === "string" && isWorkspaceFilePath(value.trim()) && workspaceFileKind(value.trim()) === "image" ? value.trim() : null;

const line = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? [...value.trim().replace(/\s+/g, " ")].slice(0, max).join("") : null;

export function parseCompare(raw: string): CompareItem[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data
    : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items
      : data && typeof data === "object" ? [data] : [];
  const items: CompareItem[] = [];
  for (const entry of list.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const before = image(r.before ?? r.original), after = image(r.after ?? r.result ?? r.edited);
    if (!before || !after) continue;
    items.push({ before, after, title: line(r.title, 40), note: line(r.note, 120) });
  }
  return items.length ? items : null;
}

/** Split a text part into text and comparisons, in order. */
export function splitCompareBlocks(source: string): Array<{ kind: "text"; text: string } | ComparePart> {
  const parts: Array<{ kind: "text"; text: string } | ComparePart> = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const items = parseCompare(match[1]!);
    if (!items) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "compare", items });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "compare" || p.text.trim() !== "");
}
