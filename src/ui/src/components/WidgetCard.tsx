import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { openDeviceBrowser } from "../deviceBrowser";
import { locale, t } from "../i18n";
import { pathUser } from "../userPath";
import type { WidgetSpec } from "../widgetBlocks";

/**
 * Where a widget's `send` puts its text: the main session's composer, filled but
 * not sent, so the person confirms it. Without a provider `send` does nothing.
 */
export const WidgetComposer = createContext<((text: string) => void) | null>(null);

const MIN_HEIGHT = 60;
const MAX_HEIGHT = 1600;
const START_HEIGHT = 160;
/** A frame that has not said `ready` by then is shown as failed. */
const READY_TIMEOUT_MS = 12_000;
const MAX_CALLS = 4;
const MAX_SEND = 4000;

const clamp = (h: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)));

/** The console theme as concrete values, for a frame that cannot read our CSS. */
function widgetTheme() {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();
  return {
    mode: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    vars: {
      "--aio-bg": token("--bg"),
      "--aio-surface": token("--bg-soft"),
      "--aio-text": token("--text"),
      "--aio-muted": token("--text-dim"),
      "--aio-border": token("--border"),
      "--aio-accent": token("--ai"),
      "--aio-attention": token("--you"),
      "--aio-success": token("--done"),
      "--aio-danger": token("--error"),
      "--aio-font": getComputedStyle(document.body).fontFamily,
      "--aio-radius": token("--radius-card"),
    },
  };
}

type Message = { aio: string; [key: string]: unknown };

/**
 * A ```widget block from a message: a component an executor published for this
 * account, running in a sandboxed frame on the workspace origin (an opaque
 * origin to us). It is loaded only when it nears the screen. The frame talks to
 * the console by postMessage: it gets the block's data and the theme, sizes
 * itself, asks the account's model or fetches a page through the server, fills
 * the composer and opens web links. Nothing else from the frame is acted on.
 */
export function WidgetCard({ spec }: { spec: WidgetSpec }) {
  const box = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [height, setHeight] = useState(START_HEIGHT);
  const fill = useContext(WidgetComposer);
  // The message handler reads the latest of these without being re-attached.
  const latest = useRef({ spec, fill });
  latest.current = { spec, fill };
  const calls = useRef(0);
  const ready = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); seen.disconnect(); }
    }, { rootMargin: "300px 0px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let live = true;
    ready.current = false;
    setState("loading");
    setSrc(null);
    api.ticket(`/widgets/${spec.component}/`).then((ticket) => { if (live) setSrc(ticket.url); }).catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, [near, spec.component]);

  useEffect(() => {
    if (!src) return;
    const timer = window.setTimeout(() => { if (!ready.current) setState("failed"); }, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [src]);

  useEffect(() => {
    if (!src) return;
    // The frame's origin is opaque ("null"), so it can only be addressed with "*"; what goes out is what the message already shows.
    const post = (message: Message) => frame.current?.contentWindow?.postMessage(message, "*");
    const call = async (id: string, op: unknown, args: Record<string, unknown>) => {
      if (calls.current >= MAX_CALLS) { post({ aio: "result", id, ok: false, error: { code: "BUSY", message: t.cards.widget.busy } }); return; }
      if (op !== "ai" && op !== "fetch") { post({ aio: "result", id, ok: false, error: { code: "BAD_OP", message: t.cards.widget.callFailed } }); return; }
      calls.current++;
      try {
        const name = latest.current.spec.component;
        const value = op === "ai" ? await api.widgetAi(name, args) : await api.widgetFetch(name, args);
        post({ aio: "result", id, ok: true, value });
      } catch (err) {
        const error = err instanceof ApiError
          ? { code: err.code && err.code !== "error" ? err.code : "FAILED", message: err.message }
          : { code: "FAILED", message: t.cards.widget.callFailed };
        post({ aio: "result", id, ok: false, error });
      } finally {
        calls.current--;
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as Message | null;
      if (!data || typeof data !== "object" || typeof data.aio !== "string") return;
      switch (data.aio) {
        case "ready": {
          ready.current = true;
          setState("ready");
          const { spec: current } = latest.current;
          const username = pathUser() ?? "";
          post({ aio: "init", data: current.data, title: current.title, theme: widgetTheme(), user: { username, name: username }, locale });
          return;
        }
        case "resize":
          if (typeof data.height === "number" && Number.isFinite(data.height)) setHeight(clamp(data.height));
          return;
        case "call":
          if (typeof data.id !== "string" || !data.id) return;
          void call(data.id, data.op, data.args && typeof data.args === "object" && !Array.isArray(data.args) ? data.args as Record<string, unknown> : {});
          return;
        case "send": {
          const text = typeof data.text === "string" ? data.text.trim().slice(0, MAX_SEND) : "";
          if (text) latest.current.fill?.(text);
          return;
        }
        case "open":
          if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) openDeviceBrowser(data.url);
          return;
      }
    };
    window.addEventListener("message", onMessage);
    // The theme switch rewrites <html data-theme>; a ready frame repaints in the new colors.
    const theme = new MutationObserver(() => { if (ready.current) post({ aio: "theme", theme: widgetTheme() }); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      window.removeEventListener("message", onMessage);
      theme.disconnect();
    };
  }, [src]);

  const label = t.cards.widget.label(spec.title ?? spec.component);
  return (
    <figure ref={box} className="widget-card" aria-label={label} data-widget={spec.component}>
      {spec.title && <figcaption className="widget-title">{spec.title}</figcaption>}
      {state === "failed"
        ? <div className="widget-failed">
            <p className="muted tiny" role="status">{t.cards.widget.failed}</p>
            <details>
              <summary className="tiny">{t.cards.widget.data}</summary>
              <pre>{JSON.stringify(spec.data, null, 2)}</pre>
            </details>
          </div>
        : <div className="widget-stage" style={{ height }}>
            {src && <iframe
              ref={frame}
              src={src}
              title={label}
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
              referrerPolicy="no-referrer"
              style={{ height }}
            />}
            {state === "loading" && <div className="widget-status muted tiny">{t.cards.widget.loading}</div>}
          </div>}
    </figure>
  );
}
