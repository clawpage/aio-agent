import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The sandbox desktop's own size (Xvnc -geometry 1280x1024 in the image): noVNC draws it at this aspect. */
const DESKTOP_ASPECT = 1024 / 1280;
/** A phone's screen (not a narrow panel on a desktop, which keeps the fitted view): fitted, the desktop is too small to read… */
const PHONE = "(max-width: 720px)";
/** …so it is drawn this many screen widths wide, and the black around it pans the view. */
const PHONE_ZOOM = 1.6;
/** The toolbar's height in the bottom strip (padding included, safe area aside). */
const BAR_HEIGHT = 52;

/** Whether the desktop is shown zoomed in on a phone (with the toolbar under it). */
export function usePhoneDesktop(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(PHONE);
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return phone;
}

type DesktopMessage = { type: "bar"; on: boolean } | { type: "key"; key: string } | { type: "text"; text: string } | { type: "paste"; text: string };

/**
 * The sandbox desktop (noVNC, which scales the remote screen to its frame). On a
 * phone the frame is wider than the screen, at the desktop's own aspect, and the
 * black strip under it pans the view and carries the desktop's controls: the
 * keyboard, paste and a few keys. noVNC's own control bar on the left is hidden
 * there (the patched noVNC takes these as messages from this page, see
 * novncPatch). `interactive` is off while only watching an agent work.
 */
export function DesktopFrame({ src, title, onLoad, interactive = true }: { src: string; title: string; onLoad?: () => void; interactive?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [typing, setTyping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const phone = usePhoneDesktop();
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
  // Zoomed, the view opens on the middle of the desktop; it is centred again only when the width changes
  // (a turned phone), never when a keyboard changes the height, so a pan the person made stays.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && zoomed) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [zoomed, size.width]);

  const post = useCallback((message: DesktopMessage) => {
    frame.current?.contentWindow?.postMessage({ aio: "desktop", ...message }, "*");
  }, []);
  // The toolbar replaces noVNC's own control bar only while it is shown.
  useEffect(() => { post({ type: "bar", on: zoomed }); }, [post, zoomed, src]);

  // The phone keyboard types into this hidden box; what it adds or removes goes to the desktop.
  const sent = useRef("");
  const composing = useRef(false);
  const flush = () => {
    const el = input.current;
    if (!el || composing.current) return;
    const before = sent.current, now = el.value;
    let same = 0;
    while (same < before.length && same < now.length && before[same] === now[same]) same += 1;
    for (let i = same; i < before.length; i += 1) post({ type: "key", key: "Backspace" });
    if (now.length > same) post({ type: "text", text: now.slice(same) });
    sent.current = now;
    if (now.length > 200) { el.value = ""; sent.current = ""; }
  };
  const openKeyboard = () => {
    const el = input.current;
    if (!el) return;
    el.value = "";
    sent.current = "";
    el.focus();
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) post({ type: "paste", text });
      setNote(text ? null : "剪贴板是空的");
    } catch {
      setNote("浏览器没有允许读取剪贴板");
    }
  };

  // It only pans sideways: where the room above the toolbar is too short for the zoomed picture (a short
  // panel, an open keyboard) the picture shrinks to that height, centred if it ends up narrower than the screen.
  const width = Math.max(0, Math.floor(Math.min(size.width * PHONE_ZOOM, (size.height - BAR_HEIGHT) / DESKTOP_ASPECT)));
  const height = Math.round(width * DESKTOP_ASPECT);
  const left = Math.max(0, Math.floor((size.width - width) / 2));
  // The picture centred in the room above the bottom strip; the toolbar at the very bottom of that strip.
  const room = Math.max(0, size.height - height - BAR_HEIGHT);
  const above = Math.floor(room / 2);
  return (
    <div ref={box} className={`desktop-frame${zoomed ? " zoomed" : ""}`}>
      <iframe
        ref={frame}
        src={src}
        title={title}
        allow="clipboard-read; clipboard-write; fullscreen"
        onLoad={() => { post({ type: "bar", on: zoomed }); onLoad?.(); }}
        style={zoomed ? { width, height, marginTop: above, marginLeft: left } : undefined}
      />
      {zoomed && (
        <div className="desktop-bar" style={{ width: size.width, marginTop: room - above }} role="toolbar" aria-label="桌面操作">
          {interactive && <>
            <button type="button" className={typing ? "active" : ""} onClick={openKeyboard} aria-pressed={typing}>键盘</button>
            <button type="button" onClick={() => void paste()}>粘贴</button>
            <button type="button" onClick={() => post({ type: "key", key: "Enter" })}>回车</button>
            <button type="button" onClick={() => post({ type: "key", key: "Tab" })}>Tab</button>
            <button type="button" onClick={() => post({ type: "key", key: "Escape" })}>Esc</button>
          </>}
          <span className="desktop-bar-hint">{note ?? "左右滑动看全部"}</span>
          <textarea
            ref={input}
            className="desktop-bar-input"
            aria-label="输入到桌面"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; flush(); }}
            onInput={flush}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); post({ type: "key", key: "Enter" }); }
              else if (e.key === "Backspace" && !input.current?.value) { e.preventDefault(); post({ type: "key", key: "Backspace" }); }
              else if (["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); post({ type: "key", key: e.key }); }
            }}
          />
        </div>
      )}
    </div>
  );
}
