import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";

const MAX_SCALE = 6;
const TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * A picture in the preview that zooms like a photo: pinch (two fingers, or a
 * trackpad pinch / ctrl+wheel) around the fingers, drag to move once zoomed,
 * double-tap or double-click to zoom in there or back to the whole picture.
 * The page itself never zooms (touch-action: none on the picture only), and a
 * picture at its fitted size passes single-finger touches through untouched.
 */
export function ZoomableImage({ src, alt, testId, onError }: { src: string; alt: string; testId?: string; onError?: (event: SyntheticEvent<HTMLImageElement>) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(FIT);
  const live = useRef(view);
  live.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; start: View; mid: { x: number; y: number } } | null>(null);
  const lastTap = useRef(0);
  /** A lone finger that has not moved yet: lifting it is a tap. Lifting the fingers of a pinch is not. */
  const tap = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => { setView(FIT); }, [src]);

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
    if (event.type !== "pointerup" || event.pointerType === "mouse" || !tapped) return;
    // A second quick tap: zoom in there, or back to the whole picture.
    const now = event.timeStamp;
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      toggle(event.clientX, event.clientY);
    } else lastTap.current = now;
  };
  const toggle = (x: number, y: number) => setView((current) => current.scale > 1 ? FIT : zoomAt(current, TAP_ZOOM, x, y));

  const zoomed = view.scale > 1;
  return <img ref={img} src={src} alt={alt} data-testid={testId} data-zoom={view.scale.toFixed(2)} onError={onError} draggable={false}
    className={`zoomable-image${zoomed ? " zoomed" : ""}`}
    style={{ transform: zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined }}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    onDoubleClick={(event) => toggle(event.clientX, event.clientY)} />;
}
