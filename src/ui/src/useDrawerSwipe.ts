import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Touches this close to the left edge (past the safe area) pull the closed drawer out. */
const EDGE = 20;
/** Movement before a touch picks a direction; a vertical one is left to the page. */
export const SLOP = 8;
/** Share of the drawer past which a release settles on the other side, and a flick's speed (px/ms) that decides alone. */
export const PAST = 0.4, FLING = 0.3;
/** The drawer's own entrance curve, so a release ends the way the ☰ button's opening does. */
export const SETTLE_MS = 280, EASE = "cubic-bezier(.16, 1, .3, 1)";
/** Sheets and previews over the page: the edge belongs to them. */
const OVERLAYS = "[aria-modal='true'], .task-console-overlay, .file-preview-overlay, .modal-backdrop, .map-sheet-backdrop, .full-message-backdrop, .onboarding";
/** Surfaces with gestures of their own (the sandbox desktop, a remote screen, a picture being zoomed). */
const OWN_GESTURES = ".workspace, .remote-touch, .phone-canvas, .zoomable-image";

type Gesture = { id: number; x: number; y: number; from: 0 | 1; locked: boolean; width: number; progress: number; moves: { x: number; t: number }[] };

/** The edge zone's width, the safe area included (a phone on its side has its notch there). */
export function edgeWidth(): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;left:0;top:0;height:0;visibility:hidden;width:calc(${EDGE}px + env(safe-area-inset-left, 0px))`;
  document.body.append(probe);
  const width = probe.offsetWidth || EDGE;
  probe.remove();
  return width;
}

/** A touch at the edge that something else under it should keep. */
function claimed(target: Element | null): boolean {
  return Boolean(document.querySelector(OVERLAYS)) || ownsTouch(target);
}

/** A touch that what is under it handles itself: a selection, a surface with its own gestures, a strip scrolled sideways. */
export function ownsTouch(target: Element | null): boolean {
  const selection = getSelection();
  if (selection && !selection.isCollapsed) return true;
  if (target?.closest(OWN_GESTURES)) return true;
  for (let node = target; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    // Anything that tunes touch-action handles its own drags; a strip scrolled sideways scrolls back first.
    if (style.touchAction !== "auto") return true;
    if (/auto|scroll/.test(style.overflowX) && node.scrollLeft > 0) return true;
  }
  return false;
}

/** A drag is not a tap: whatever was under the finger at the start must not be clicked by it. */
export function swallowClick() {
  const stop = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

function paint(drawer: HTMLElement | null, scrim: HTMLElement | null, progress: number, animate: boolean) {
  const timing = `${SETTLE_MS}ms ${EASE}`;
  if (drawer) { drawer.style.transition = animate ? `transform ${timing}` : "none"; drawer.style.transform = `translateX(${(progress - 1) * 102}%)`; }
  if (scrim) { scrim.style.transition = animate ? `opacity ${timing}` : "none"; scrim.style.opacity = String(progress); }
}

function unpaint(...nodes: (HTMLElement | null)[]) {
  for (const node of nodes) node?.style.removeProperty("transition"), node?.style.removeProperty("transform"), node?.style.removeProperty("opacity");
}

/** The phone layout's drawer follows a finger: pulled out from the left edge, or pushed back from the drawer or its scrim.
 * Past 40% or flicked, it settles on the other side; otherwise it springs back. While a finger (or its settling) owns the
 * drawer, `swiping` turns off its keyframe motion; `pulling` keeps a still-closed drawer on screen under the finger.
 * `exited` is for the drawer's PopupPresence and says whether focus goes back to the ☰ button (not after a pull let go). */
export function useDrawerSwipe({ enabled, open, setOpen, drawer, scrim }: { enabled: boolean; open: boolean; setOpen: (open: boolean) => void; drawer: RefObject<HTMLElement | null>; scrim: RefObject<HTMLElement | null> }) {
  const [pulling, setPulling] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  /** How the gesture let the drawer go, until its exit is over: a pull let go of, or pushed shut. */
  const leaving = useRef<"pull" | "close" | null>(null);
  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };

  useEffect(() => {
    if (!enabled) return;
    let edge = edgeWidth(), frame = 0, unpaintTimer = 0;
    const measure = () => { edge = edgeWidth(); };
    const settle = (g: Gesture, opened: boolean) => {
      cancelAnimationFrame(frame);
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      paint(drawer.current, scrim.current, opened ? 1 : 0, !still);
      setPulling(false);
      if (opened) {
        latest.current.setOpen(true);
        // Settled open, the stylesheet holds it there again.
        unpaintTimer = window.setTimeout(() => { if (!gesture.current?.locked) unpaint(drawer.current, scrim.current); }, still ? 0 : SETTLE_MS + 20);
      } else {
        leaving.current = g.from ? "close" : "pull";
        if (g.from) latest.current.setOpen(false);
      }
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const current = gesture.current;
      if (current) {
        // A second finger means a pinch or the like, never a pull.
        if (current.locked) settle(current, current.from === 1);
        gesture.current = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const { open } = latest.current;
      if (open ? !(target && (drawer.current?.contains(target) || scrim.current?.contains(target))) : event.clientX > edge || claimed(target)) return;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: open ? 1 : 0, locked: false, width: 0, progress: open ? 1 : 0, moves: [] };
    };
    const move = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.id) return;
      const dx = event.clientX - g.x, dy = event.clientY - g.y;
      if (!g.locked) {
        if (Math.hypot(dx, dy) < SLOP) return;
        // Only sideways and toward the way the drawer can go; anything else stays the page's.
        if (Math.abs(dx) <= Math.abs(dy) || (g.from ? dx > 0 : dx < 0)) { gesture.current = null; return; }
        g.locked = true;
        g.width = drawer.current?.offsetWidth || Math.min(300, innerWidth * 0.85);
        clearTimeout(unpaintTimer);
        setSwiping(true);
        if (!g.from) setPulling(true);
      }
      g.progress = Math.min(1, Math.max(0, g.from + dx / g.width));
      g.moves.push({ x: event.clientX, t: event.timeStamp });
      while (g.moves.length > 2 && event.timeStamp - g.moves[0].t > 100) g.moves.shift();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(drawer.current, scrim.current, g.progress, false); });
    };
    const up = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.id) return;
      gesture.current = null;
      if (!g.locked) return;
      swallowClick();
      // The browser took the touch over: back to where it started.
      if (event.type === "pointercancel") { settle(g, g.from === 1); return; }
      g.moves.push({ x: event.clientX, t: event.timeStamp });
      const first = g.moves.find(m => event.timeStamp - m.t <= 100) ?? g.moves[0];
      const speed = event.timeStamp > first.t ? (event.clientX - first.x) / (event.timeStamp - first.t) : 0;
      const past = g.from ? g.progress > 1 - PAST : g.progress >= PAST;
      settle(g, speed > FLING || (speed >= -FLING && past));
    };
    // Pointer events alone lose a sideways drag to the browser's own panning; holding the moves keeps it ours.
    const hold = (event: TouchEvent) => { if (gesture.current?.locked && event.cancelable) event.preventDefault(); };
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
      gesture.current = null;
      setPulling(false);
    };
  }, [enabled, drawer, scrim]);

  // The drawer a pull just put on screen starts under the finger, not fully open.
  useLayoutEffect(() => {
    const g = gesture.current;
    if (pulling && g?.locked) paint(drawer.current, scrim.current, g.progress, false);
  }, [pulling, drawer, scrim]);

  useLayoutEffect(() => {
    if (open && leaving.current) {
      // Opened again (the ☰ button) while a pushed-shut drawer was still leaving: its own motion again.
      leaving.current = null;
      unpaint(drawer.current, scrim.current);
      setSwiping(false);
    } else if (!open && !leaving.current) {
      // Closed by a row, the close button or Escape: it leaves with its own motion, not the finger's.
      unpaint(drawer.current, scrim.current);
      setSwiping(false);
    }
  }, [open, drawer, scrim]);

  const exited = useCallback(() => {
    const was = leaving.current;
    leaving.current = null;
    setSwiping(false);
    return was !== "pull";
  }, []);

  return { pulling, swiping, exited };
}
