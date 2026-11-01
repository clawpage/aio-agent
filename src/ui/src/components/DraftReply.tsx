import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { draftSource } from "../draftText";
import { ReadingPage } from "./MessagePreview";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A final answer while its executor writes it: what has arrived is typed out a few characters
 * at a time and catches up in about a second, so pieces fetched every half second read as
 * steady writing. Cards wait for their closing fence (draftSource).
 */
export function DraftReply({ text, onGrow, onOpenLink, onOpenFile }: { text: string; onGrow?: () => void; onOpenLink?: (url: string) => void; onOpenFile?: (path: string) => void }) {
  // The reading page shows what has arrived at once: it was already typed out in the feed.
  const reading = useContext(ReadingPage);
  const [shown, setShown] = useState(() => reading || reduced() ? text.length : 0);
  const latest = useRef(text);
  latest.current = text;
  const behind = shown !== text.length;
  // The next step waits on the last one, not on new text: pieces arriving faster than a step
  // would otherwise cancel every step and leave the answer blank.
  useEffect(() => {
    if (!behind) return;
    if (shown > latest.current.length || reading || reduced()) { setShown(latest.current.length); return; }
    const timer = window.setTimeout(() => setShown(n => {
      const all = latest.current;
      let next = Math.min(all.length, n + Math.max(2, Math.ceil((all.length - n) / 20)));
      // Never half an emoji.
      if (/[\uD800-\uDBFF]/.test(all[next - 1] ?? "")) next++;
      return next;
    }), 40);
    return () => clearTimeout(timer);
  }, [shown, behind, reading]);
  useLayoutEffect(() => { onGrow?.(); }, [shown, onGrow]);
  return <Markdown source={draftSource(text.slice(0, shown))} onOpenLink={onOpenLink} onOpenFile={onOpenFile}/>;
}
