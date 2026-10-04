import { createElement, createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type AnimationEventHandler, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

const Motion = createContext<{ exiting: boolean; finish: () => void } | null>(null);

/** Keep the last popup alive until its exit animation ends, including portals.
 * Reopening cancels the old exit; nested popups have independent lifetimes. */
export function PopupPresence({ children, onExited, animate = true }: { children: ReactNode; onExited?: () => void; animate?: boolean }) {
  const parent = useContext(Motion);
  const visible = Boolean(children) && !parent?.exiting;
  const latest = useRef(children);
  if (visible) latest.current = children;
  const [present, setPresent] = useState(visible);
  if (visible && !present) setPresent(true);
  const active = useRef(visible);
  active.current = visible;
  const complete = useRef(onExited);
  complete.current = onExited;
  const finish = useCallback(() => {
    if (active.current || latest.current === null) return;
    latest.current = null;
    setPresent(false);
    complete.current?.();
  }, []);

  useLayoutEffect(() => {
    if (visible || !present) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    if (!animate || preference.matches) { finish(); return; }
    // Animation events normally finish the exit. The fallback also handles a
    // hidden tab, interrupted animation, or popup without a motion surface.
    const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--popup-exit-ms")) || 220;
    const timer = window.setTimeout(finish, duration + 80);
    const changed = () => { if (preference.matches) finish(); };
    preference.addEventListener("change", changed);
    return () => { clearTimeout(timer); preference.removeEventListener("change", changed); };
  }, [visible, present, animate, finish]);

  return <Motion.Provider value={animate ? { exiting: !visible, finish } : null}>
    {visible ? children : present ? latest.current : null}
  </Motion.Provider>;
}

/** The fixed backdrop (or standalone popup) owns motion, never a portal's parent. */
export function PopupSurface({ as = "div", onAnimationEnd, ...props }: Omit<ComponentPropsWithRef<"div">, "ref" | "onAnimationEnd"> & { as?: "div" | "aside" | "section"; ref?: Ref<HTMLElement>; onAnimationEnd?: AnimationEventHandler<HTMLElement> }) {
  const motion = useContext(Motion);
  return createElement(as, { ...props, "data-popup-motion": motion ? motion.exiting ? "exit" : "enter" : undefined, inert: motion?.exiting || props.inert, onAnimationEnd: event => {
    onAnimationEnd?.(event);
    if (event.target === event.currentTarget && motion?.exiting) motion.finish();
  } });
}
