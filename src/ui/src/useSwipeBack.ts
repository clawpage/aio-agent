import { useEffect, useRef, type RefObject } from "react";
import { EASE, FLING, PAST, SETTLE_MS, SLOP, edgeWidth, ownsTouch, swallowClick } from "./useDrawerSwipe";

type Gesture = { id: number; x: number; y: number; locked: boolean; width: number; dx: number; moves: { x: number; t: number }[] };

/** A full-screen page on a phone goes back the way an app's page does: dragged right from the left edge it follows the finger,
 * and past 40% or flicked it slides away and `onBack` runs; otherwise it springs back. The iOS app and a home-screen web app
 * have no back swipe of their own; where the browser has one, it takes the touch over and goes back through history.
 * While moved, the page carries `data-swiping` so its edge can stand out from what it uncovers. */
export function useSwipeBack({ enabled, page, onBack }: { enabled: boolean; page: RefObject<HTMLElement | null>; onBack: () => void }) {
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    let edge = edgeWidth(), frame = 0, unpaintTimer = 0, gesture: Gesture | null = null;
    const paint = (x: number, animate: boolean) => {
      const node = page.current;
      if (!node) return;
      node.style.transition = animate ? `transform ${SETTLE_MS}ms ${EASE}` : "none";
      node.style.transform = `translateX(${x}px)`;
      node.dataset.swiping = "";
    };
    const unpaint = () => {
      for (const name of ["transition", "transform", "animation"]) page.current?.style.removeProperty(name);
      delete page.current?.dataset.swiping;
    };
    // A page opened again before the last one finished leaving starts where it belongs.
    unpaint();
    const measure = () => { edge = edgeWidth(); };
    const settle = (g: Gesture, back: boolean) => {
      cancelAnimationFrame(frame);
      const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      paint(back ? g.width : 0, animate);
      if (back) {
        // Already off screen to the right: its own exit (sliding down) would only show it again.
        if (page.current) page.current.style.animation = "none";
        latest.current();
      } else {
        unpaintTimer = window.setTimeout(unpaint, animate ? SETTLE_MS + 20 : 0);
      }
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      if (gesture) {
        // A second finger means a pinch or the like, never a swipe.
        if (gesture.locked) settle(gesture, false);
        gesture = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      // A viewer opened over the page (a picture, a file) is not inside it and keeps its own touches.
      if (event.clientX > edge || !target || !page.current?.contains(target) || ownsTouch(target)) return;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, locked: false, width: 0, dx: 0, moves: [] };
    };
    const move = (event: PointerEvent) => {
      const g = gesture;
      if (!g || event.pointerId !== g.id) return;
      const dx = event.clientX - g.x, dy = event.clientY - g.y;
      if (!g.locked) {
        if (Math.hypot(dx, dy) < SLOP) return;
        // Only sideways and to the right; anything else stays the page's.
        if (Math.abs(dx) <= Math.abs(dy) || dx < 0) { gesture = null; return; }
        g.locked = true;
        g.width = page.current?.offsetWidth || innerWidth;
        clearTimeout(unpaintTimer);
      }
      g.dx = Math.min(g.width, Math.max(0, dx));
      g.moves.push({ x: event.clientX, t: event.timeStamp });
      while (g.moves.length > 2 && event.timeStamp - g.moves[0].t > 100) g.moves.shift();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(g.dx, false); });
    };
    const up = (event: PointerEvent) => {
      const g = gesture;
      if (!g || event.pointerId !== g.id) return;
      gesture = null;
      if (!g.locked) return;
      swallowClick();
      // The browser took the touch over: back to where it started.
      if (event.type === "pointercancel") { settle(g, false); return; }
      g.moves.push({ x: event.clientX, t: event.timeStamp });
      const first = g.moves.find(m => event.timeStamp - m.t <= 100) ?? g.moves[0];
      const speed = event.timeStamp > first.t ? (event.clientX - first.x) / (event.timeStamp - first.t) : 0;
      settle(g, speed > FLING || (speed >= -FLING && g.dx >= g.width * PAST));
    };
    // Pointer events alone lose a sideways drag to the browser's own panning; holding the moves keeps it ours.
    const hold = (event: TouchEvent) => { if (gesture?.locked && event.cancelable) event.preventDefault(); };
    const options = { passive: true, capture: true };
    window.addEventListener("pointerdown", down, options);
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", up, options);
    window.addEventListener("pointercancel", up, options);
    window.addEventListener("touchmove", hold, { passive: false, capture: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("pointerdown", down, options);
      window.removeEventListener("pointermove", move, options);
      window.removeEventListener("pointerup", up, options);
      window.removeEventListener("pointercancel", up, options);
      window.removeEventListener("touchmove", hold, { capture: true });
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(frame);
      clearTimeout(unpaintTimer);
    };
  }, [enabled, page]);
}
