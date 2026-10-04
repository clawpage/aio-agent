import { useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isSandboxLink } from "../sandboxLink";

/** Keep long main-inbox messages compact, with the complete interactive message at hand. */
export function MessagePreview({ children, title, user = false }: { children: ReactNode; title: string; user?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const view = viewport.current!, body = content.current!;
    // Image loads, feed updates, rotation and keyboard resizing can all change overflow.
    const measure = () => {
      const bottom = view.getBoundingClientRect().bottom;
      const overflow = body.getBoundingClientRect().bottom > bottom - parseFloat(getComputedStyle(view).paddingBottom) + 1;
      setClipped(overflow);
      // Controls beyond the excerpt must not steal keyboard focus into hidden text.
      for (const control of body.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [tabindex]")) {
        const hidden = overflow && control.getBoundingClientRect().bottom > bottom - 44;
        if (hidden && control.dataset.previewTabindex === undefined) {
          control.dataset.previewTabindex = control.getAttribute("tabindex") ?? "absent";
          control.tabIndex = -1;
        } else if (!hidden && control.dataset.previewTabindex !== undefined) {
          const previous = control.dataset.previewTabindex;
          if (previous === "absent") control.removeAttribute("tabindex"); else control.setAttribute("tabindex", previous);
          delete control.dataset.previewTabindex;
        }
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(view); observer.observe(body);
    measure();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (viewport.current) viewport.current.inert = open;
    if (open) close.current?.focus();
    else if (wasOpen.current) more.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  const dismiss = () => setOpen(false);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    // React portal events bubble through the reading page too. A nested image,
    // map or file viewer must handle its own Escape and keyboard focus.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, textarea, select, [tabindex='0']")].filter(n => n.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <>
    <div ref={viewport} className={`bubble message-preview${clipped ? " clipped" : ""}`} data-testid="message-preview" aria-hidden={open || undefined} onClick={event => {
      // Visible links/cards keep their own actions. Tapping the message text opens it.
      if (!event.defaultPrevented && clipped && !window.getSelection()?.toString() && !(event.target as HTMLElement).closest("a, button, input, textarea, select, video, audio")) setOpen(true);
    }}>
      <div ref={content} className="message-preview-content">{children}</div>
      {clipped && <button ref={more} type="button" className="message-more" onClick={() => setOpen(true)} aria-label={`点击看更多：${title}`}>点击看更多</button>}
    </div>
    {open && createPortal(<div className="full-message" role="dialog" aria-modal="true" aria-label={`完整消息：${title}`} onKeyDown={keys} onClick={event => {
      if (!event.currentTarget.contains(event.target as Node)) return;
      const link = (event.target as HTMLElement).closest("a[href], [data-browser-link]");
      const url = link?.getAttribute("href") ?? link?.getAttribute("data-browser-link") ?? "";
      // The sandbox may open its workspace fallback underneath the reading page.
      if (isSandboxLink(url)) dismiss();
    }}>
      <header className="full-message-head"><strong>{title}</strong><button ref={close} type="button" className="ghost" onClick={dismiss} aria-label="关闭消息">关闭</button></header>
      <div className={`full-message-body${user ? " user" : ""}`}><article className="full-message-content">{children}</article></div>
    </div>, document.body)}
  </>;
}
