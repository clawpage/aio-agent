/**
 * Flowcharts and other diagrams in messages. A fenced block in Mermaid syntax
 *
 *   ```mermaid
 *   flowchart TD
 *     A["开始"] --> B{"有票吗？"}
 *   ```
 *
 * is drawn as the diagram it describes. A block that is empty or too large stays
 * an ordinary code block.
 */
export const MERMAID_MAX_CHARS = 20_000;

export type MermaidPart = { kind: "text"; text: string } | { kind: "mermaid"; code: string };

const FENCE = /^```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Split text into prose and diagrams, in order. */
export function splitMermaidBlocks(source: string): MermaidPart[] {
  const parts: MermaidPart[] = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const code = match[1]!;
    if (!code.trim() || code.length > MERMAID_MAX_CHARS) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "mermaid", code });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "mermaid" || p.text.trim() !== "");
}
