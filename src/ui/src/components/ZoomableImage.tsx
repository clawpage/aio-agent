import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";

const MAX_SCALE = 6;
const TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
/** Pulled this far down (or flicked), letting go closes the picture. */
const DISMISS_PX = 120;
const DISMISS_SPEED = 0.6;
/** How far down the backdrop is fully gone (progress 1). */
const PULL_RANGE_PX = 360;
/** Dragged this far sideways (or flicked), letting go turns to the next picture. */
const STEP_PX = 80;
const STEP_SPEED = 0.5;

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * A picture in the preview that zooms like a photo: pinch (two fingers, or a
 * trackpad pinch / ctrl+wheel) around the fingers, drag to move once zoomed,
 * double-tap or double-click to zoom in there or back to the whole picture.
 * The page itself never zooms (touch-action: none on the picture only). At its
 * fitted size a finger pulling down drags the picture (`onPull` gets 0–1 for the
 * backdrop) and letting go far or fast enough calls `onDismiss`; a single tap
 * that is not the start of a double tap calls `onTap`. With `onStep`, a finger
 * dragging the fitted picture sideways takes it along and letting go far or fast
 * enough asks for the next (1) or previous (-1) picture; where `steps` says there
 * is none, the picture resists and springs back.
 */
export function ZoomableImage({ src, alt, testId, onError, onTap, onPull, onDismiss, onStep, steps, enter }: {
  src: string; alt: string; testId?: string; onError?: (event: SyntheticEvent<HTMLImageElement>) => void;
  onTap?: () => void; onPull?: (progress: number) => void; onDismiss?: () => void;
  onStep?: (direction: 1 | -1) => void; steps?: { prev: boolean; next: boolean };
  /** The side this picture came in from, when it replaced another. */
  enter?: "next" | "prev";
}) {
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(FIT);
  const live = useRef(view);
  live.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; start: View; mid: { x: number; y: number } } | null>(null);
  const lastTap = useRef(-Infinity);
  /** A lone finger that has not moved yet: lifting it is a tap. Lifting the fingers of a pinch is not. */
  const tap = useRef<{ id: number; x: number; y: number } | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);
  /** A finger on the fitted picture that may become a pull down or a turn sideways: `locked` is decided once it has moved. */
  const pull = useRef<{ id: number; x: number; y: number; at: number; locked: "down" | "side" | false | null } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [settling, setSettling] = useState(false);

  useEffect(() => { setView(FIT); setDrag(null); }, [src]);
  useEffect(() => () => clearTimeout(tapTimer.current), []);
  const endPull = () => { pull.current = null; setSettling(true); setDrag(null); onPull?.(0); };

  /** Scale to `next` keeping the picture point under (cx, cy) in place; panning stays inside the picture. */
  const zoomAt = (from: View, next: number, cx: number, cy: number, dx = 0, dy = 0): View => {
    const el = img.current;
    if (!el) return from;
    const scale = Math.min(MAX_SCALE, Math.max(1, next));
    if (scale <= 1.01) return FIT;
    // The untransformed box (transform-origin is its top-left corner), from the transform on screen now.
    const rect = el.getBoundingClientRect();
    const left = rect.left - live.current.x, top = rect.top - live.current.y;
    const u = (cx - left - from.x) / from.scale, v = (cy - top - from.y) / from.scale;
    return clamp({ scale, x: cx + dx - left - scale * u, y: cy + dy - top - scale * v });
  };
  const clamp = (next: View): View => {
    const el = img.current;
    if (!el) return next;
    const w = el.offsetWidth, h = el.offsetHeight;
    return { scale: next.scale, x: Math.min(0, Math.max(w - next.scale * w, next.x)), y: Math.min(0, Math.max(h - next.scale * h, next.y)) };
  };

  // Wheel needs a non-passive listener to keep the page from zooming instead.
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setView((current) => zoomAt(current, current.scale * Math.exp(-event.deltaY / 100), event.clientX, event.clientY));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const down = (event: ReactPointerEvent<HTMLImageElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Moves keep coming once the finger leaves the picture; capture can refuse a pointer it does not know.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* still tracked by id */ }
    tap.current = pointers.current.size === 1 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    if ((onDismiss || onStep) && event.pointerType !== "mouse" && pointers.current.size === 1 && live.current.scale <= 1) {
      pull.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, locked: null };
      setSettling(false);
    } else if (pull.current?.locked) endPull();
    else pull.current = null;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, start: live.current, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  };
  const move = (event: ReactPointerEvent<HTMLImageElement>) => {
    const before = pointers.current.get(event.pointerId);
    if (!before) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (tap.current && Math.hypot(event.clientX - tap.current.x, event.clientY - tap.current.y) > 10) tap.current = null;
    const start = pull.current;
    if (start?.id === event.pointerId) {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (start.locked === null && Math.hypot(dx, dy) > 10) start.locked = dy > Math.abs(dx) ? (onDismiss ? "down" : false) : onStep && Math.abs(dx) > Math.abs(dy) ? "side" : false;
      if (!start.locked) return;
      if (start.locked === "side") {
        // Towards a picture that is there it follows the finger; otherwise it resists.
        setDrag({ x: (dx < 0 ? steps?.next : steps?.prev) ? dx : dx / 3, y: 0 });
        return;
      }
      setDrag({ x: dx, y: Math.max(0, dy) });
      onPull?.(Math.min(1, Math.max(0, dy) / PULL_RANGE_PX));
      return;
    }
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const start = pinch.current;
      setView(zoomAt(start.start, start.start.scale * Math.hypot(a.x - b.x, a.y - b.y) / start.distance, start.mid.x, start.mid.y, mid.x - start.mid.x, mid.y - start.mid.y));
    } else if (pointers.current.size === 1 && live.current.scale > 1) {
      setView((current) => clamp({ ...current, x: current.x + event.clientX - before.x, y: current.y + event.clientY - before.y }));
    }
  };
  const up = (event: ReactPointerEvent<HTMLImageElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const tapped = tap.current?.id === event.pointerId;
    tap.current = null;
    const start = pull.current;
    if (start?.id === event.pointerId) {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (start.locked === "side") {
        const far = Math.abs(dx) > STEP_PX || (Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, event.timeStamp - start.at) > STEP_SPEED);
        if (event.type === "pointerup" && far && (dx < 0 ? steps?.next : steps?.prev)) {
          pull.current = null;
          onStep?.(dx < 0 ? 1 : -1); // The next picture comes in from that side.
          return;
        }
        endPull();
        return;
      }
      if (start.locked && event.type === "pointerup" && (dy > DISMISS_PX || (dy > 40 && dy / Math.max(1, event.timeStamp - start.at) > DISMISS_SPEED))) {
        pull.current = null;
        onDismiss?.(); // The picture leaves from where it was let go.
        return;
      }
      if (start.locked) { endPull(); return; }
      pull.current = null;
    }
    if (event.type !== "pointerup" || event.pointerType === "mouse" || !tapped) return;
    // A second quick tap: zoom in there, or back to the whole picture.
    const now = event.timeStamp;
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = -Infinity;
      clearTimeout(tapTimer.current);
      toggle(event.clientX, event.clientY);
    } else {
      lastTap.current = now;
      if (onTap) tapTimer.current = window.setTimeout(onTap, DOUBLE_TAP_MS);
    }
  };
  const toggle = (x: number, y: number) => setView((current) => current.scale > 1 ? FIT : zoomAt(current, TAP_ZOOM, x, y));

  const zoomed = view.scale > 1;
  // Pulled down, the picture follows the finger and shrinks a little, about its centre.
  const transform = zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    : drag ? `translate(${drag.x}px, ${drag.y}px) scale(${Math.max(0.7, 1 - drag.y / 1200)})` : undefined;
  return <img ref={img} src={src} alt={alt} data-testid={testId} data-enter={enter} data-zoom={view.scale.toFixed(2)} onError={onError} draggable={false}
    className={`zoomable-image${zoomed ? " zoomed" : ""}${drag ? " pulled" : ""}${settling ? " settling" : ""}`}
    style={{ transform }}
    onTransitionEnd={() => setSettling(false)}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    onDoubleClick={(event) => toggle(event.clientX, event.clientY)} />;
}
