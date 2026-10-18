import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { RemoteStage, type RemoteInput } from "./RemoteStage";

/** The sandbox desktop's own size (Xvnc -geometry 1280x1024 in the image). */
const DESKTOP = { width: 1280, height: 1024 };
/** A phone's screen (not a narrow panel on a desktop, which keeps noVNC's own fitted view). */
const PHONE = "(max-width: 720px)";
/** Fitted, the desktop is too small to read on a phone: it opens this many screen widths wide, on its middle. */
export const PHONE_ZOOM = 1.3;

/** Whether the desktop is shown with the phone's gestures (and the toolbar under it). */
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

type DesktopMessage =
  | { type: "bar"; on: boolean }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "click"; x: number; y: number; button: "left" | "right" }
  | { type: "pointer"; phase: "down" | "move" | "up"; x: number; y: number; button: "left" | "right" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number };

/**
 * The sandbox desktop (noVNC, which scales the remote screen to its frame). On a
 * phone the console's own gestures drive it (RemoteStage: tap, drag to scroll,
 * pinch and two-finger pan, long press to drag, double tap to zoom) and pass the
 * pointer to noVNC by postMessage; the strip under it carries the keyboard,
 * paste and a few keys, and noVNC's own control bar on the left is hidden there
 * (the patched noVNC takes these as messages from this page, see novncPatch).
 * `interactive` is off while only watching an agent work.
 */
export function DesktopFrame({ src, title, onLoad, interactive = true }: { src: string; title: string; onLoad?: () => void; interactive?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [typing, setTyping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const phone = usePhoneDesktop();

  const post = useCallback((message: DesktopMessage) => {
    frame.current?.contentWindow?.postMessage({ aio: "desktop", ...message }, "*");
  }, []);
  // The toolbar replaces noVNC's own control bar only while it is shown.
  useEffect(() => { post({ type: "bar", on: phone }); }, [post, phone, src]);

  const onInput = useCallback((msg: RemoteInput) => {
    if (msg.t === "click") post({ type: "click", x: msg.x, y: msg.y, button: msg.button });
    else if (msg.t === "pointer") post({ type: "pointer", phase: msg.phase, x: msg.x, y: msg.y, button: msg.button });
    else post({ type: "wheel", x: msg.x, y: msg.y, dx: msg.dx, dy: msg.dy });
  }, [post]);

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
      setNote(text ? null : t.browser.desktop.clipboardEmpty);
    } catch {
      setNote(t.browser.desktop.clipboardDenied);
    }
  };

  return (
    <div className={`desktop-frame${phone ? " zoomed" : ""}`}>
      <RemoteStage remote={DESKTOP} gestures={phone} initialScale={PHONE_ZOOM} onInput={interactive ? onInput : undefined} label={title}>
        {(style) => (
          <iframe
            ref={frame}
            src={src}
            title={title}
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => { post({ type: "bar", on: phone }); onLoad?.(); }}
            style={style}
          />
        )}
      </RemoteStage>
      {phone && <div className="desktop-bar" role="toolbar" aria-label={t.browser.desktop.toolbar}>
        {interactive && <>
          <button type="button" className={typing ? "active" : ""} onClick={openKeyboard} aria-pressed={typing}>{t.browser.desktop.keyboard}</button>
          <button type="button" onClick={() => void paste()}>{t.browser.desktop.paste}</button>
          <button type="button" onClick={() => post({ type: "key", key: "Enter" })}>{t.browser.desktop.enter}</button>
          <button type="button" onClick={() => post({ type: "key", key: "Tab" })}>Tab</button>
          <button type="button" onClick={() => post({ type: "key", key: "Escape" })}>Esc</button>
        </>}
        <span className="desktop-bar-hint">{note ?? (interactive ? t.browser.desktop.hint : t.browser.desktop.watchHint)}</span>
        <textarea
          ref={input}
          className="desktop-bar-input"
          aria-label={t.browser.desktop.input}
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
      </div>}
    </div>
  );
}
