import { looksLikeSvg } from "../../common/svg";

/**
 * SVG pictures in messages. A fenced block holding an SVG document
 *
 *   ```svg
 *   <svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>
 *   ```
 *
 * is shown as the picture it draws. A block that is not an SVG, or is too large,
 * stays an ordinary code block.
 */
export const SVG_MAX_CHARS = 1_000_000;

export type SvgPart = { kind: "text"; text: string } | { kind: "svg"; code: string };

const FENCE = /^```svg[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Split text into prose and SVG pictures, in order. */
export function splitSvgBlocks(source: string): SvgPart[] {
  const parts: SvgPart[] = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const code = match[1]!;
    if (code.length > SVG_MAX_CHARS || !looksLikeSvg(code)) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "svg", code });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "svg" || p.text.trim() !== "");
}
