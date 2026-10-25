import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../clipboard";
import { replyPlainText } from "../replyText";
import { t } from "../i18n";

type CopyState = "idle" | "copied" | "failed";

/**
 * 复制 on a finished reply: one tap puts the reply on the clipboard as plain text,
 * then the button says 已复制 (or that copying failed) for a moment. The text is
 * worked out on the tap, not while rendering: the feed re-renders every second
 * while a task runs.
 */
export function CopyReply({ source, title }: { source: string; title: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    // No await before the write: the fallback's execCommand must run inside the tap.
    const text = replyPlainText(source) || source.trim();
    void writeClipboard(text).then((ok) => {
      window.clearTimeout(timer.current);
      setState(ok ? "copied" : "failed");
      timer.current = window.setTimeout(() => setState("idle"), ok ? 1500 : 3000);
    });
  };
  return (
    <button
      type="button"
      className="ghost tiny copy-reply"
      data-state={state}
      aria-live="polite"
      aria-label={state === "idle" ? t.feed.actions.copyLabel(title) : undefined}
      onClick={copy}
    >
      {state === "copied" ? t.feed.actions.copied : state === "failed" ? t.feed.actions.copyFailed : t.feed.actions.copy}
    </button>
  );
}
