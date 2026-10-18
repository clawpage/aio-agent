import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../api";
import { t } from "../i18n";
import { PHONE_ZOOM, usePhoneDesktop } from "./DesktopFrame";
import { RemoteStage, type RemoteInput } from "./RemoteStage";

/**
 * One task's page on the AI's Chrome on the account's Mac, live: JPEG pictures
 * as Chrome paints them, from the Mac's bridge (bin/user-browser.mjs). Watching,
 * the picture zooms and pans; once the person holds the page, taps, drags, the
 * wheel, keys and text go back to it (RemoteStage has the gestures). With a
 * keyboard (the Mac app), a click on the page lets typing go straight into it.
 */
interface Props {
  /** The task's key (its execution conversation), or a page of the Chrome by its id (the workspace's Mac browser). */
  target: { taskKey: string } | { pageId: number };
  /** The person holds the page: input goes through (the control plane drops it otherwise). */
  canAct: boolean;
  /** What the strip says while the person only watches (by default: take over to use it). */
  watchHint?: string;
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
/** Keys typed on a keyboard that go to the page as keys (everything else arrives as text). */
const PAGE_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
/** Shortcuts passed on as editing commands; paste arrives as text from the clipboard. */
const SHORTCUTS = new Set(["a", "z", "x", "c"]);

function screenUrl(target: Props["target"]): string {
  const query = "taskKey" in target ? `key=${encodeURIComponent(target.taskKey)}` : `page=${target.pageId}`;
  const url = new URL(apiUrl(`/api/user-browser/screen?${query}`), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const modsOf = (e: React.KeyboardEvent) => [e.altKey && "alt", e.ctrlKey && "ctrl", e.metaKey && "meta", e.shiftKey && "shift"].filter(Boolean) as string[];

export function UserBrowserScreen({ target, canAct, watchHint }: Props) {
  const targetId = "taskKey" in target ? `key:${target.taskKey}` : `page:${target.pageId}`;
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keysRef = useRef<HTMLTextAreaElement | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [state, setState] = useState<State>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const [retry, setRetry] = useState(0);
  const phone = usePhoneDesktop();

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (canAct && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, [canAct]);

  useEffect(() => {
    let disposed = false;
    let reconnect: number | undefined;
    // Pictures are drawn in order, one at a time; one that arrives while another decodes replaces the waiting one.
    let drawing = false;
    let waiting: Blob | null = null;
    const draw = async (blob: Blob) => {
      if (drawing) { waiting = blob; return; }
      drawing = true;
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = canvasRef.current;
        if (canvas && !disposed) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      } catch {
        // A picture that does not decode is skipped; the next one follows.
      } finally {
        drawing = false;
        const next = waiting;
        waiting = null;
        if (next && !disposed) void draw(next);
      }
    };
    setState("connecting");
    setError(null);
    const ws = new WebSocket(screenUrl(target));
    ws.binaryType = "blob";
    wsRef.current = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data) as { type: string; width?: number; height?: number; message?: string };
        if (msg.type === "size" && msg.width! > 0 && msg.height! > 0) setSize({ width: msg.width!, height: msg.height! });
        else if (msg.type === "error") setError(msg.message ?? t.userBrowser.screen.unavailable);
        return;
      }
      void draw(event.data as Blob);
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
    };
  }, [targetId, retry]);

  const onInput = useCallback((msg: RemoteInput) => send(msg), [send]);

  // A keyboard types into the page through this hidden box (IME composition included).
  const flushTyped = () => {
    const el = keysRef.current;
    if (!el || !el.value) return;
    send({ t: "text", s: el.value });
    el.value = "";
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    const mods = modsOf(e);
    if ((e.metaKey || e.ctrlKey) && SHORTCUTS.has(e.key.toLowerCase())) {
      e.preventDefault();
      send({ t: "key", k: e.key, mods });
    } else if (PAGE_KEYS.has(e.key)) {
      e.preventDefault();
      send({ t: "key", k: e.key, mods });
    }
  };

  const sendText = () => {
    if (!text.trim()) return;
    send({ t: "text", s: text });
    setText("");
  };

  return (
    <div className="user-browser-screen">
      <div className="phone-bar">
        <span className={`phone-dot ${state === "live" ? "live" : ""}`} aria-hidden="true" />
        <span className="phone-name">{state === "closed" ? t.userBrowser.screen.reconnecting : state === "connecting" ? t.userBrowser.screen.connecting : canAct ? (typing ? t.userBrowser.screen.typingHint : t.userBrowser.screen.actHint) : (watchHint ?? t.userBrowser.screen.watchHint)}</span>
      </div>
      <RemoteStage
        className={`user-browser-stage${canAct ? " acting" : ""}`}
        remote={size}
        mouse
        initialScale={phone ? PHONE_ZOOM : 1}
        onInput={canAct ? onInput : undefined}
        onMousePress={() => keysRef.current?.focus({ preventScroll: true })}
        label={t.userBrowser.screen.page}
      >
        {(style) => <canvas ref={canvasRef} className="user-browser-picture" style={style} aria-hidden="true" />}
      </RemoteStage>
      {error && <div className="frame-hint error">{error}</div>}
      {canAct && <>
        <textarea
          ref={keysRef}
          className="user-browser-keys"
          aria-label={t.userBrowser.screen.keyboardLabel}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onKeyDown={onKeyDown}
          onInput={(e) => { if (!(e.nativeEvent as InputEvent).isComposing) flushTyped(); }}
          onCompositionEnd={flushTyped}
          onPaste={(e) => { e.preventDefault(); const s = e.clipboardData.getData("text"); if (s) send({ t: "text", s }); }}
        />
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
