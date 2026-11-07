import type { MouseEvent, PointerEvent } from "react";

/** How long after a touch acted the click that follows it is the same tap. */
const SAME_TAP_MS = 800;

/**
 * For a button that must take every tap, also while the page changes many times a second (a reply
 * streaming in): iOS WebKit drops the click of a tap when content appears while it recognises the tap
 * (it takes the tap for a hover). So a touch acts as the finger lifts on the button, and the click that
 * may follow is not acted on again; mouse, pen and keyboard keep the click.
 */
export function tapProps(action: () => void) {
  return {
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      const button = e.currentTarget;
      if (e.pointerType !== "touch" || button.disabled || !button.contains(document.elementFromPoint(e.clientX, e.clientY))) return;
      button.dataset.tappedAt = String(Date.now());
      action();
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (Date.now() - Number(e.currentTarget.dataset.tappedAt || 0) < SAME_TAP_MS) return;
      action();
    },
  };
}
