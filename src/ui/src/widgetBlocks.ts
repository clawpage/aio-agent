/**
 * Components an executor published for this account, shown inside a message.
 * An executor writes a fenced block naming the component and the data it shows:
 *
 *   ```widget
 *   {"component": "flight-board", "data": {"flights": [...]}, "title": "今天的航班"}
 *   ```
 *
 * The component's own page runs in a sandboxed frame on the workspace origin
 * (WidgetCard); here only the name is checked and the data kept as given. A
 * block that does not parse, or names no valid component, stays an ordinary
 * code block.
 */

export interface WidgetSpec {
  component: string;
  data: unknown;
  title: string | null;
}

export type WidgetPart = { kind: "widget"; spec: WidgetSpec };

export const WIDGET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const WIDGET_MAX_CHARS = 200_000;

const FENCE = /^```widget[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** The widget a block describes, or null when it is not one. */
export function parseWidget(code: string): WidgetSpec | null {
  if (code.length > WIDGET_MAX_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.component !== "string" || !WIDGET_NAME.test(r.component)) return null;
  const title = typeof r.title === "string" && r.title.trim() ? [...r.title.trim().replace(/\s+/g, " ")].slice(0, 80).join("") : null;
  return { component: r.component, data: r.data ?? null, title };
}

/** Split text into prose and widgets, in order. */
export function splitWidgetBlocks(source: string): Array<{ kind: "text"; text: string } | WidgetPart> {
  const parts: Array<{ kind: "text"; text: string } | WidgetPart> = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const spec = parseWidget(match[1]!);
    if (!spec) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "widget", spec });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "widget" || p.text.trim() !== "");
}
