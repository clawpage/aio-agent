import type { MouseEvent, PointerEvent } from "react";

let touchedAt = 0;

/**
 * Handlers for a control that must act without taking focus from the input bar
 * (so the phone keyboard stays up). Preventing the press keeps focus, but in
 * WebKit it also swallows the click of a touch tap, so a touch acts on release;
 * a mouse or keyboard acts on click, and the click a touch may still produce
 * (Chromium) is ignored.
 */
export function keepFocusTap<E extends Element>(act: (point: { clientX: number; clientY: number; target: E }) => void) {
  return {
    onPointerDown: (e: PointerEvent<E>) => e.preventDefault(),
    onPointerUp: (e: PointerEvent<E>) => {
      if (e.pointerType === "mouse") return;
      touchedAt = Date.now();
      act({ clientX: e.clientX, clientY: e.clientY, target: e.currentTarget });
    },
    onClick: (e: MouseEvent<E>) => {
      if (Date.now() - touchedAt < 800) return;
      act({ clientX: e.clientX, clientY: e.clientY, target: e.currentTarget });
    },
  };
}
