import { useLayoutEffect, type RefObject } from "react";
import { LoadingMark } from "./Brand";

export function ComposerIcon({ kind }: { kind: "attach" | "send" | "stop" | "close" | "busy" }) {
  // Busy is the console's one loading animation, at the icon's size.
  if (kind === "busy") return <LoadingMark size={20} />;
  return <svg className="composer-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "attach" ? <path d="M12 5v14M5 12h14" />
      : kind === "send" ? <path d="m6 10 6-6 6 6M12 4v16" />
      : kind === "stop" ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
      : <path d="m7 7 10 10M17 7 7 17" />}
  </svg>;
}

/** Grow with the draft, then scroll within the CSS viewport cap. Empty fields
 * leave height to CSS, which switches between idle and keyboard focus sizes. */
export function useComposerHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const fit = () => {
      input.style.height = "";
      if (!value) return;
      input.style.height = "0px";
      const border = parseFloat(getComputedStyle(input).borderTopWidth) + parseFloat(getComputedStyle(input).borderBottomWidth);
      input.style.height = `${input.scrollHeight + border}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, value]);
}
