import { useEffect, useRef, useState } from "react";

/** The sandbox desktop's own size (Xvnc -geometry 1280x1024 in the image): noVNC draws it at this aspect. */
const DESKTOP_ASPECT = 1024 / 1280;
/** A phone's screen (not a narrow panel on a desktop, which keeps the fitted view): fitted, the desktop is too small to read… */
const PHONE = "(max-width: 720px)";
/** …so it is drawn this many screen widths wide, and the black around it pans the view. */
const PHONE_ZOOM = 2;

/**
 * The sandbox desktop (noVNC, which scales the remote screen to its frame). On a
 * phone the frame is twice the screen's width and exactly the desktop's aspect,
 * so the picture fills it; the black area around it belongs to this scroller, and
 * a swipe there moves the view while taps on the picture still reach the page.
 */
export function DesktopFrame({ src, title, onLoad }: { src: string; title: string; onLoad?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(PHONE);
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const zoomed = phone && size.width > 0;
  const width = Math.round(size.width * PHONE_ZOOM);
  const height = Math.round(width * DESKTOP_ASPECT);
  const room = size.height - height;
  return (
    <div ref={box} className={`desktop-frame${zoomed ? " zoomed" : ""}`}>
      <iframe
        src={src}
        title={title}
        allow="clipboard-read; clipboard-write; fullscreen"
        onLoad={onLoad}
        style={zoomed ? { width, height, marginTop: Math.max(0, Math.floor(room / 2) - 14) } : undefined}
      />
      {zoomed && room >= 40 && <p className="desktop-frame-hint" style={{ width: size.width }}>在黑色区域左右滑动，查看整个页面</p>}
    </div>
  );
}
