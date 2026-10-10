import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PopupPresence, PopupSurface } from "./PopupMotion";
import { api } from "../api";
import { t } from "../i18n";
import type { Task } from "../types";
import { PhoneScreen } from "./PhoneScreen";

const SHOT_MS = 10_000;

/**
 * The owner's phone inside the card of a task that used it, like the task
 * browser: a recent picture of the screen, and a tap opens the live phone to
 * operate. A task waiting for the person (a code to type, a step to confirm)
 * gets "done, continue", which answers it for them.
 */
export function TaskPhone({ task, onDone }: { task: Task; onDone: () => void }) {
  const waiting = task.status === "needs_input";
  const [shotAt, setShotAt] = useState(() => Date.now());
  const [shotFailed, setShotFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);

  // A fresh picture every few seconds while the card is on a visible page and the live view is closed.
  useEffect(() => {
    if (open) return;
    setShotAt(Date.now());
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setShotAt(Date.now());
    }, SHOT_MS);
    return () => window.clearInterval(timer);
  }, [open, task.status]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, close]);

  const done = () => { setOpen(false); onDone(); };
  const label = waiting ? t.phone.task.waiting : t.phone.task.working;

  return (
    <div className={`task-browser task-phone ${waiting ? "request" : "ai"}`} role="group" aria-label={t.phone.task.group(label)}>
      <div className="task-browser-head">
        <span className={`task-browser-state ${waiting ? "request" : "ai"}`}>{label}</span>
        <span className="task-browser-site">{t.phone.task.site}</span>
      </div>
      {waiting && <p className="task-browser-hint">{t.phone.task.waitingHint}</p>}
      {shotFailed
        ? <p className="task-browser-hint">{t.phone.task.disconnected}</p>
        : (
          <button type="button" className="task-browser-shot task-phone-shot" onClick={() => setOpen(true)} aria-label={t.phone.task.openLabel}>
            <img src={api.phoneScreenshotUrl(shotAt)} alt={t.phone.task.shotAlt} onLoad={() => setShotFailed(false)} onError={() => setShotFailed(true)} />
          </button>
        )}
      <div className="task-actions">
        <button type="button" className={waiting ? "primary tiny" : "ghost tiny"} onClick={() => setOpen(true)}>{waiting ? t.phone.task.goOperate : t.phone.task.view}</button>
        {waiting && <button type="button" className="ghost tiny" onClick={done}>{t.phone.task.done}</button>}
      </div>
      {/* On the body: a card inside the feed sits under transformed ancestors, which would trap a fixed overlay. */}
      <PopupPresence>{open && createPortal(
        <PopupSurface ref={overlay} className="task-console-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="task-console task-phone-console" role="dialog" aria-modal="true" aria-label={t.phone.task.dialog}>
            <header className="task-console-head">
              <span className="task-console-title">{waiting ? t.phone.task.finishTitle : t.phone.task.title}</span>
              {waiting && <button type="button" className="primary tiny" onClick={done}>{t.phone.task.done}</button>}
              <button type="button" className="ghost tiny" onClick={close}>{t.phone.task.close}</button>
            </header>
            <PhoneScreen active />
          </div>
        </PopupSurface>,
        document.body,
      )}</PopupPresence>
    </div>
  );
}
