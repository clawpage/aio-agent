import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampView, fit, fitted, panBy, TAP_ZOOM, toRemote, zoomAt, type Size, type View } from "../remoteView";

/** What the person does to the remote screen; positions are fractions of it, wheel deltas its own pixels. */
export type RemoteInput =
  | { t: "click"; x: number; y: number; button: "left" | "right" }
  | { t: "pointer"; phase: "down" | "move" | "up"; x: number; y: number; button: "left" | "right" }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number };

/** A finger that moved less than this is a tap (screen pixels). */
const SLOP = 10;
/** A finger held this long without moving holds the mouse button down: dragging, "press and hold" checks. */
const LONG_PRESS_MS = 450;
/** A second tap this soon (and this near) zooms instead of clicking; a single tap clicks after it. */
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SLOP = 30;
/** Two fingers down and up this fast without moving: a right click. */
const TWO_TAP_MS = 300;
/** Hover moves of a mouse reach the page at most this often. */
const HOVER_MS = 80;

interface Props {
  /** The remote screen's size in its own pixels (the page's viewport, the desktop's framebuffer). */
  remote: Size;
  /** Input for the remote screen; without it gestures only zoom and pan the picture. */
  onInput?: (msg: RemoteInput) => void;
  /** A mouse drives the remote screen too (an image); off for a picture that takes the mouse itself. */
  mouse?: boolean;
  /** The view a picture opens at (scale over the fitted picture, centred). */
  initialScale?: number;
  /** A mouse press on the picture (the page then wants the keyboard). */
  onMousePress?: () => void;
  /** Off: the picture just fills the stage and takes its own input (the same element stays mounted). */
  gestures?: boolean;
  className?: string;
  label?: string;
  /** The picture, placed and scaled by the style given. */
  children: (style: React.CSSProperties) => React.ReactNode;
}

type Finger = { x: number; y: number; startX: number; startY: number; at: number; samples: Array<{ x: number; y: number; t: number }> };
type Mode =
  | { kind: "idle" }
  | { kind: "pending"; at: { x: number; y: number } }
  | { kind: "drag"; at: { x: number; y: number } }
  | { kind: "press"; at: { x: number; y: number } }
  | { kind: "two"; startDist: number; startMid: { x: number; y: number }; startView: View; at: number; moved: boolean }
  | { kind: "rest" }
  | { kind: "mouse"; button: "left" | "right" };

/**
 * A remote screen's picture with phone gestures, the same for the sandbox desktop
 * and the AI's Chrome: a tap clicks, one finger drags the zoomed picture and then
 * scrolls the page (with a flick's momentum), two fingers pinch and pan the
 * picture, a long press holds the mouse button for dragging, a double tap zooms
 * in or back out, and a two-finger tap is a right click. A mouse clicks, drags
 * and hovers as itself; its wheel scrolls (pinch on a trackpad zooms).
 */
export function RemoteStage({ remote, onInput, mouse = false, initialScale = 1, onMousePress, gestures = true, className, label, children }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  // The picture's scale follows the stage's width: a phone keyboard taking height away clips the picture instead of shrinking it.
  const tallest = useRef({ width: 0, height: 0 });
  if (stage.width !== tallest.current.width || stage.height > tallest.current.height) tallest.current = { ...stage };
  const base = fit(tallest.current, remote);
  const [view, setViewState] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  /** The scale the picture is laid out at; between gestures the rest is a transform, so a pinch stays smooth. */
  const [laidOut, setLaidOut] = useState(1);
  const ready = useRef(false);
  const geometry = useRef({ stage, base, remote });
  geometry.current = { stage, base, remote };
  const input = useRef(onInput);
  input.current = onInput;

  const setView = useCallback((next: View) => { viewRef.current = next; setViewState(next); }, []);
  const settle = useCallback(() => setLaidOut(viewRef.current.scale), []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The first time there is something to show, open at the initial scale; afterwards keep the scale through resizes.
  useLayoutEffect(() => {
    if (base.width <= 0) return;
    if (!ready.current) {
      ready.current = true;
      const start = zoomAt(fitted(stage, base), initialScale, stage.width / 2, stage.height / 2, stage, base);
      setView(start);
      setLaidOut(start.scale);
      return;
    }
    setView(clampView(viewRef.current, stage, base));
  }, [stage.width, stage.height, base.width, base.height]);

  const point = (clientX: number, clientY: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const remoteAt = (p: { x: number; y: number }) => toRemote(viewRef.current, geometry.current.base, p.x, p.y);
  /** Stage pixels to the remote screen's own pixels at the current zoom. */
  const remotePerPixel = () => geometry.current.remote.width / (geometry.current.base.width * viewRef.current.scale || 1);

  // Wheel deltas for the remote screen, sent once per frame.
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number; frame: number } | null>(null);
  const scrollRemote = useCallback((at: { x: number; y: number }, dx: number, dy: number) => {
    const send = input.current;
    if (!send || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) return;
    const where = toRemote(viewRef.current, geometry.current.base, at.x, at.y) ?? { x: 0.5, y: 0.5 };
    if (wheel.current) { wheel.current.dx += dx; wheel.current.dy += dy; return; }
    wheel.current = { ...where, dx, dy, frame: requestAnimationFrame(() => {
      const w = wheel.current!;
      wheel.current = null;
      const rx = Math.round(w.dx), ry = Math.round(w.dy);
      if (rx || ry) input.current?.({ t: "wheel", x: w.x, y: w.y, dx: rx, dy: ry });
    }) };
  }, []);
  useEffect(() => () => { if (wheel.current) cancelAnimationFrame(wheel.current.frame); }, []);

  /** A drag by (dx, dy) stage pixels: the zoomed picture moves first, then the page scrolls. */
  const dragBy = (at: { x: number; y: number }, dx: number, dy: number) => {
    const { stage: s, base: b } = geometry.current;
    const { view: next, rest } = panBy(viewRef.current, dx, dy, s, b);
    if (next.x !== viewRef.current.x || next.y !== viewRef.current.y) setView(next);
    const k = remotePerPixel();
    scrollRemote(at, -rest.x * k, -rest.y * k);
  };

  // A flick keeps going and slows down.
  const glide = useRef<number | null>(null);
  const stopGlide = () => { if (glide.current !== null) cancelAnimationFrame(glide.current); glide.current = null; };
  const startGlide = (at: { x: number; y: number }, vx: number, vy: number) => {
    stopGlide();
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      dragBy(at, vx * dt, vy * dt);
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay;
      vy *= decay;
      glide.current = Math.hypot(vx, vy) > 0.04 ? requestAnimationFrame(step) : null;
    };
    glide.current = requestAnimationFrame(step);
  };
  useEffect(() => stopGlide, []);

  const fingers = useRef(new Map<number, Finger>());
  const mode = useRef<Mode>({ kind: "idle" });
  const longPress = useRef<number | undefined>(undefined);
  const lastTap = useRef<{ x: number; y: number; t: number; click?: number } | null>(null);
  const hoverAt = useRef(0);

  const toggleZoom = (p: { x: number; y: number }) => {
    const { stage: s, base: b } = geometry.current;
    const v = viewRef.current;
    setView(v.scale > 1.2 ? fitted(s, b) : zoomAt(v, TAP_ZOOM, p.x, p.y, s, b));
    settle();
  };
  const tap = (p: { x: number; y: number }) => {
    const now = performance.now();
    const before = lastTap.current;
    if (before && now - before.t < DOUBLE_TAP_MS && Math.hypot(p.x - before.x, p.y - before.y) < DOUBLE_TAP_SLOP) {
      window.clearTimeout(before.click);
      lastTap.current = null;
      toggleZoom(p);
      return;
    }
    const at = remoteAt(p);
    const click = at && input.current ? window.setTimeout(() => input.current?.({ t: "click", ...at, button: "left" }), DOUBLE_TAP_MS) : undefined;
    lastTap.current = { ...p, t: now, click };
  };

  const midpoint = () => {
    const [a, b] = [...fingers.current.values()];
    return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === "mouse") {
      if (!mouse) return;
      event.preventDefault();
      onMousePress?.();
      const at = remoteAt(p);
      if (!at || !input.current) return;
      const button = event.button === 2 ? "right" : "left";
      event.currentTarget.setPointerCapture(event.pointerId);
      mode.current = { kind: "mouse", button };
      input.current({ t: "pointer", phase: "down", ...at, button });
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stopGlide();
    fingers.current.set(event.pointerId, { ...p, startX: p.x, startY: p.y, at: performance.now(), samples: [{ ...p, t: performance.now() }] });
    window.clearTimeout(longPress.current);
    if (fingers.current.size === 1) {
      mode.current = { kind: "pending", at: p };
      if (input.current) {
        longPress.current = window.setTimeout(() => {
          if (mode.current.kind !== "pending") return;
          const at = remoteAt(p);
          if (!at) return;
          mode.current = { kind: "press", at: p };
          navigator.vibrate?.(10);
          input.current?.({ t: "pointer", phase: "down", ...at, button: "left" });
        }, LONG_PRESS_MS);
      }
    } else if (fingers.current.size === 2) {
      if (mode.current.kind === "press") {
        const at = remoteAt(mode.current.at);
        if (at) input.current?.({ t: "pointer", phase: "up", ...at, button: "left" });
      }
      const m = midpoint();
      mode.current = { kind: "two", startDist: Math.max(1, m.dist), startMid: { x: m.x, y: m.y }, startView: viewRef.current, at: performance.now(), moved: false };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === "mouse") {
      if (!mouse || !input.current) return;
      const at = remoteAt(p);
      if (!at) return;
      if (mode.current.kind === "mouse") input.current({ t: "pointer", phase: "move", ...at, button: mode.current.button });
      else if (performance.now() - hoverAt.current > HOVER_MS) {
        hoverAt.current = performance.now();
        input.current({ t: "pointer", phase: "move", ...at, button: "left" });
      }
      return;
    }
    const finger = fingers.current.get(event.pointerId);
    if (!finger) return;
    const dx = p.x - finger.x, dy = p.y - finger.y;
    finger.x = p.x;
    finger.y = p.y;
    const now = performance.now();
    finger.samples.push({ ...p, t: now });
    while (finger.samples.length > 2 && now - finger.samples[0]!.t > 100) finger.samples.shift();
    const m = mode.current;
    if (m.kind === "pending" && Math.hypot(p.x - finger.startX, p.y - finger.startY) > SLOP) {
      window.clearTimeout(longPress.current);
      mode.current = { kind: "drag", at: { x: finger.startX, y: finger.startY } };
      dragBy(mode.current.at, p.x - finger.startX, p.y - finger.startY);
    } else if (m.kind === "drag") {
      dragBy(m.at, dx, dy);
    } else if (m.kind === "press") {
      const at = remoteAt(p);
      if (at) input.current?.({ t: "pointer", phase: "move", ...at, button: "left" });
    } else if (m.kind === "two" && fingers.current.size === 2) {
      const mid = midpoint();
      if (!m.moved && (Math.abs(mid.dist - m.startDist) > SLOP || Math.hypot(mid.x - m.startMid.x, mid.y - m.startMid.y) > SLOP)) m.moved = true;
      const { stage: s, base: b } = geometry.current;
      const zoomed = zoomAt(m.startView, m.startView.scale * (mid.dist / m.startDist), m.startMid.x, m.startMid.y, s, b);
      setView(clampView({ ...zoomed, x: zoomed.x + mid.x - m.startMid.x, y: zoomed.y + mid.y - m.startMid.y }, s, b));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === "mouse") {
      if (mode.current.kind !== "mouse") return;
      const at = remoteAt(p) ?? { x: Math.min(1, Math.max(0, (p.x - viewRef.current.x) / (geometry.current.base.width * viewRef.current.scale))), y: Math.min(1, Math.max(0, (p.y - viewRef.current.y) / (geometry.current.base.height * viewRef.current.scale))) };
      input.current?.({ t: "pointer", phase: "up", ...at, button: mode.current.button });
      mode.current = { kind: "idle" };
      return;
    }
    const finger = fingers.current.get(event.pointerId);
    if (!finger) return;
    fingers.current.delete(event.pointerId);
    window.clearTimeout(longPress.current);
    const m = mode.current;
    if (m.kind === "two") {
      if (!m.moved && performance.now() - m.at < TWO_TAP_MS && input.current) {
        const at = remoteAt(m.startMid);
        if (at) input.current({ t: "click", ...at, button: "right" });
      }
      // The finger left on the glass does nothing until it is lifted too.
      mode.current = { kind: "rest" };
      settle();
    } else if (m.kind === "pending" && event.type === "pointerup") {
      tap(p);
    } else if (m.kind === "press") {
      const at = remoteAt(p) ?? remoteAt(m.at);
      if (at) input.current?.({ t: "pointer", phase: "up", ...at, button: "left" });
    } else if (m.kind === "drag" && event.type === "pointerup") {
      const first = finger.samples[0]!, last = finger.samples.at(-1)!;
      const dt = last.t - first.t;
      if (dt > 0 && dt < 150) {
        const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
        if (Math.hypot(vx, vy) > 0.3) startGlide(m.at, vx, vy);
      }
    }
    if (fingers.current.size === 0) mode.current = { kind: "idle" };
  };

  useEffect(() => {
    // React's wheel listener is passive: the console would scroll too. A trackpad pinch arrives as a wheel with Ctrl.
    const el = stageRef.current;
    if (!el || !gestures) return;
    let settleTimer: number | undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const p = point(event.clientX, event.clientY);
      const { stage: s, base: b } = geometry.current;
      if (event.ctrlKey) {
        setView(zoomAt(viewRef.current, viewRef.current.scale * Math.exp(-event.deltaY * 0.01), p.x, p.y, s, b));
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(settle, 150);
        return;
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? s.height : 1;
      const { view: next, rest } = panBy(viewRef.current, -event.deltaX * unit, -event.deltaY * unit, s, b);
      if (next.x !== viewRef.current.x || next.y !== viewRef.current.y) setView(next);
      // A wheel turn is in the remote page's own pixels, as on the Mac it comes from.
      scrollRemote(p, -rest.x, -rest.y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); window.clearTimeout(settleTimer); };
  }, [scrollRemote, settle, gestures]);

  useEffect(() => () => { window.clearTimeout(longPress.current); window.clearTimeout(lastTap.current?.click); }, []);

  const shown = base.width * laidOut;
  const style: React.CSSProperties = !gestures ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : {
    position: "absolute",
    left: 0,
    top: 0,
    width: Math.round(shown),
    height: Math.round(base.height * laidOut),
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale / laidOut})`,
    transformOrigin: "0 0",
  };
  return (
    <div ref={stageRef} className={`remote-stage${className ? ` ${className}` : ""}`}>
      {(base.width > 0 || !gestures) && children(style)}
      {gestures && <div
        className="remote-touch"
        role="application"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />}
    </div>
  );
}
