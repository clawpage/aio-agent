import { useEffect, useLayoutEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { draftSource } from "../draftText";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A final answer while its executor writes it: what has arrived is typed out a few characters
 * at a time and catches up in about a second, so pieces fetched every half second read as
 * steady writing. Cards wait for their closing fence (draftSource).
 */
export function DraftReply({ text, onGrow, onOpenLink, onOpenFile }: { text: string; onGrow?: () => void; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  const [shown, setShown] = useState(() => reduced() ? text.length : 0);
  useEffect(() => {
    if (shown === text.length) return;
    if (shown > text.length || reduced()) { setShown(text.length); return; }
    const timer = window.setTimeout(() => setShown(n => {
      let next = Math.min(text.length, n + Math.max(2, Math.ceil((text.length - n) / 20)));
      // Never half an emoji.
      if (/[\uD800-\uDBFF]/.test(text[next - 1] ?? "")) next++;
      return next;
    }), 40);
    return () => clearTimeout(timer);
  }, [text, shown]);
  useLayoutEffect(() => { onGrow?.(); }, [shown, onGrow]);
  return <Markdown source={draftSource(text.slice(0, shown))} onOpenLink={onOpenLink} onOpenFile={onOpenFile}/>;
}
