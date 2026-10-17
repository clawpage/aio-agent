import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../api";
import { t } from "../i18n";

/**
 * One task's page on the account's own Chrome, live: JPEG pictures from the
 * Mac's bridge (bin/user-browser.mjs), and, once the person holds the page,
 * clicks, scrolling, keys and text sent back. Positions go out as fractions of
 * the picture, so the bridge maps them onto the page whatever its size.
 */
interface Props {
  /** The task's key (its execution conversation). */
  taskKey: string;
  /** The person holds the page: input goes through (the control plane drops it otherwise). */
  canAct: boolean;
}

type State = "connecting" | "live" | "closed";

const KEYS: Array<{ msg: Record<string, string>; label: string; title: string }> = [
  { msg: { t: "nav", to: "back" }, label: "←", title: t.userBrowser.screen.back },
  { msg: { t: "nav", to: "forward" }, label: "→", title: t.userBrowser.screen.forward },
  { msg: { t: "nav", to: "reload" }, label: "↻", title: t.userBrowser.screen.reload },
  { msg: { t: "key", k: "Enter" }, label: "⏎", title: t.userBrowser.screen.enter },
  { msg: { t: "key", k: "Backspace" }, label: "⌫", title: t.userBrowser.screen.backspace },
  { msg: { t: "key", k: "Tab" }, label: t.userBrowser.screen.tab, title: t.userBrowser.screen.tab },
  { msg: { t: "key", k: "Escape" }, label: t.userBrowser.screen.escape, title: t.userBrowser.screen.escape },
];

function screenUrl(key: string): string {
  const url = new URL(apiUrl(`/api/user-browser/screen?key=${encodeURIComponent(key)}`), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function UserBrowserScreen({ taskKey, canAct }: Props) {
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [retry, setRetry] = useState(0);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (canAct && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, [canAct]);

  useEffect(() => {
    let disposed = false;
    let reconnect: number | undefined;
    let shown: string | null = null;
    setState("connecting");
    setError(null);
    const ws = new WebSocket(screenUrl(taskKey));
    ws.binaryType = "blob";
    wsRef.current = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data) as { type: string; width?: number; height?: number; message?: string };
        if (msg.type === "size") size.current = { width: msg.width!, height: msg.height! };
        else if (msg.type === "error") setError(msg.message ?? t.userBrowser.screen.unavailable);
        return;
      }
      const next = URL.createObjectURL(event.data as Blob);
      if (shown) URL.revokeObjectURL(shown);
      shown = next;
      setFrame(next);
      setState("live");
      setError(null);
    };
    ws.onclose = (event) => {
      if (disposed) return;
      setState("closed");
      if (event.code !== 1008) reconnect = window.setTimeout(() => setRetry((n) => n + 1), 3000);
    };
    return () => {
      disposed = true;
      window.clearTimeout(reconnect);
      wsRef.current = null;
      ws.close();
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [taskKey, retry]);

  // A tap clicks; a drag scrolls (touch screens have no wheel).
  const down = useRef<{ x: number; y: number } | null>(null);
  const fraction = (clientX: number, clientY: number) => {
    const rect = imgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  };
  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    event.preventDefault();
    down.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: React.PointerEvent<HTMLImageElement>) => {
    const start = down.current;
    down.current = null;
    if (!start || !imgRef.current) return;
    const moved = event.clientY - start.y;
    if (Math.abs(moved) < 8 && Math.abs(event.clientX - start.x) < 8) {
      send({ t: "click", ...fraction(event.clientX, event.clientY) });
      return;
    }
    const scale = (size.current?.height ?? imgRef.current.naturalHeight) / imgRef.current.getBoundingClientRect().height;
    send({ t: "scroll", ...fraction(start.x, start.y), dy: Math.round(-moved * scale) });
  };

  useEffect(() => {
    // React's onWheel is passive, so the console would scroll too; listen directly.
    const img = imgRef.current;
    if (!img) return;
    let pending = 0;
    let timer: number | undefined;
    let at = { x: 0.5, y: 0.5 };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      at = fraction(event.clientX, event.clientY);
      pending += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      // One scroll per burst of wheel events: each is a round trip to the Mac.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { send({ t: "scroll", ...at, dy: Math.round(pending) }); pending = 0; }, 120);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => { img.removeEventListener("wheel", onWheel); window.clearTimeout(timer); };
  }, [send, frame !== null]);

  const sendText = () => {
    if (!text.trim()) return;
    send({ t: "text", s: text });
    setText("");
  };

  return (
    <div className="user-browser-screen">
      <div className="phone-bar">
        <span className={`phone-dot ${state === "live" ? "live" : ""}`} aria-hidden="true" />
        <span className="phone-name">{state === "closed" ? t.userBrowser.screen.reconnecting : state === "connecting" ? t.userBrowser.screen.connecting : canAct ? t.userBrowser.task.states.human : t.userBrowser.screen.watchHint}</span>
      </div>
      <div className={`user-browser-stage ${canAct ? "acting" : ""}`}>
        {frame && (
          <img
            ref={imgRef}
            src={frame}
            alt={t.userBrowser.screen.page}
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
        {error && <div className="frame-hint error">{error}</div>}
      </div>
      {canAct && <>
        <div className="phone-keys" role="toolbar" aria-label={t.userBrowser.screen.toolbar}>
          {KEYS.map((key) => (
            <button key={key.title} type="button" className="ghost" title={key.title} aria-label={key.title} onClick={() => send(key.msg)}>{key.label}</button>
          ))}
        </div>
        <form className="phone-text row" onSubmit={(e) => { e.preventDefault(); sendText(); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.userBrowser.screen.textPlaceholder} aria-label={t.userBrowser.screen.textLabel} />
          <button type="submit" className="primary" disabled={!text.trim() || state !== "live"}>{t.userBrowser.screen.send}</button>
        </form>
      </>}
    </div>
  );
}
