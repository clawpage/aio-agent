import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Task } from "../types";
import { t } from "../i18n";

export interface PillGroup {
  key: string;
  /** "you": the person's move (amber); "ai": the AI is on it (indigo). */
  tone: "you" | "ai";
  label: string;
  tasks: Task[];
  /** The short state each task shows in the list. */
  state: (task: Task) => string;
}

/**
 * The header's "N 件…" pills as a way to the work itself: one task scrolls to its
 * card; several open a small list under the pill to pick from, which closes once
 * one is picked, on a tap elsewhere or on Escape.
 */
export function TurnPills({ groups, onJump }: { groups: PillGroup[]; onJump: (taskId: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const pills = useRef(new Map<string, HTMLButtonElement>());
  const menu = useRef<HTMLDivElement>(null);
  const shown = groups.find((g) => g.key === open && g.tasks.length > 1);
  // The list keeps what it last showed while it fades out.
  const last = useRef<PillGroup | null>(null);
  if (shown) last.current = shown;
  const list = shown ?? last.current;

  useLayoutEffect(() => {
    if (!shown) return;
    const pill = pills.current.get(shown.key), head = pill?.closest(".chat-head");
    if (!pill || !head) return;
    const p = pill.getBoundingClientRect(), h = head.getBoundingClientRect();
    const width = Math.min(320, h.width - 16);
    setPos({ top: p.bottom - h.top + 6, left: Math.max(8, Math.min(p.left - h.left, h.width - width - 8)), width });
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || pills.current.get(shown.key)?.contains(target)) return;
      setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(null);
      pills.current.get(shown.key)?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [shown]);

  const pick = (group: PillGroup) => {
    if (group.tasks.length === 1) { setOpen(null); onJump(group.tasks[0]!.id); return; }
    setOpen((now) => (now === group.key ? null : group.key));
  };

  return <>
    {groups.filter((g) => g.tasks.length).map((g) => {
      const many = g.tasks.length > 1;
      return (
        <button key={g.key} type="button" ref={(n) => { if (n) pills.current.set(g.key, n); else pills.current.delete(g.key); }}
          className={`turn-pill ${g.tone}${open === g.key && many ? " open" : ""}`}
          aria-haspopup={many ? "menu" : undefined} aria-expanded={many ? open === g.key : undefined}
          title={many ? t.feed.pills.pickTask : t.feed.pills.viewTask} onClick={() => pick(g)}>
          {g.label}
          {many && <svg className="turn-pill-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
        </button>
      );
    })}
    <div ref={menu} className={`turn-menu${shown ? " open" : ""}`} role="menu" aria-label={list?.label} aria-hidden={!shown} style={pos} inert={!shown}>
      {list?.tasks.map((t) => (
        <button key={t.id} type="button" role="menuitem" className={`turn-menu-item ${list.tone}`} tabIndex={shown ? 0 : -1}
          onClick={() => { setOpen(null); onJump(t.id); }}>
          <span className="turn-menu-dot" aria-hidden="true" />
          <span className="turn-menu-title">{t.title}</span>
          <span className="turn-menu-state">{list.state(t)}</span>
        </button>
      ))}
    </div>
  </>;
}
