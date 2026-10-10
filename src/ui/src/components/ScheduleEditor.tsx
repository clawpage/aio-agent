import { useState } from "react";
import type { Schedule, ScheduleSpec } from "../types";
import { t } from "../i18n";

const KINDS: Array<{ id: ScheduleSpec["kind"]; label: string }> = [
  { id: "daily", label: t.schedules.editor.kinds.daily },
  { id: "weekly", label: t.schedules.editor.kinds.weekly },
  { id: "monthly", label: t.schedules.editor.kinds.monthly },
  { id: "once", label: t.schedules.editor.kinds.once },
  { id: "dates", label: t.schedules.editor.kinds.dates },
  { id: "interval", label: t.schedules.editor.kinds.interval },
];
const WEEKDAYS = t.schedules.editor.weekdays;

interface Draft {
  title: string;
  instruction: string;
  kind: ScheduleSpec["kind"];
  /** "08:00, 18:00" */
  times: string;
  date: string;
  weekdays: number[];
  monthDay: string;
  everyMinutes: string;
  /** One "YYYY-MM-DD HH:MM" a line. */
  dates: string;
  maxRuns: string;
  until: string;
  needsBrowser: boolean;
}

function draftOf(s: Schedule): Draft {
  const spec = s.spec;
  return {
    title: s.title, instruction: s.instruction, kind: spec.kind,
    times: (spec.times?.length ? spec.times : spec.at ? [spec.at] : ["09:00"]).join(", "),
    date: spec.date ?? "", weekdays: spec.weekdays ?? [1], monthDay: String(spec.monthDay ?? 1),
    everyMinutes: String(spec.everyMinutes ?? 60), dates: (spec.dates ?? []).join("\n"),
    maxRuns: spec.maxRuns ? String(spec.maxRuns) : "", until: spec.until ?? "", needsBrowser: s.needsBrowser,
  };
}

const list = (text: string) => text.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean); // i18n-exempt: separators accepted in typed times

/** The rule the draft describes; the control plane checks it and says what is wrong. */
function specOf(d: Draft): ScheduleSpec {
  const repeat = { maxRuns: d.maxRuns.trim() ? Number(d.maxRuns) : null, until: d.until || null };
  const times = list(d.times);
  switch (d.kind) {
    case "once": return { kind: "once", date: d.date, at: times[0] ?? "" };
    case "dates": return { kind: "dates", dates: d.dates.split("\n").map((l) => l.trim()).filter(Boolean) };
    case "interval": return { kind: "interval", everyMinutes: Number(d.everyMinutes), ...repeat };
    case "weekly": return { kind: "weekly", times, weekdays: d.weekdays, ...repeat };
    case "monthly": return { kind: "monthly", times, monthDay: Number(d.monthDay), ...repeat };
    default: return { kind: "daily", times, ...repeat };
  }
}

/** Edit one schedule: its name, what each run does, and when it runs (several times a day or irregular dates too). */
export function ScheduleEditor({ schedule, busy, onSave, onCancel }: { schedule: Schedule; busy: boolean; onSave: (changes: { title: string; instruction: string; schedule: ScheduleSpec; needsBrowser: boolean }) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(schedule));
  const set = (patch: Partial<Draft>) => setD((old) => ({ ...old, ...patch }));
  const daily = d.kind === "daily" || d.kind === "weekly" || d.kind === "monthly";
  return <form className="vault-form vault-edit schedule-edit" aria-label={t.schedules.editor.label(schedule.title)} onSubmit={(e) => { e.preventDefault(); onSave({ title: d.title, instruction: d.instruction, schedule: specOf(d), needsBrowser: d.needsBrowser }); }}>
    <label className="field schedule-edit-wide"><span>{t.schedules.editor.name}</span><input value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} /></label>
    <label className="field schedule-edit-wide"><span>{t.schedules.editor.instruction}</span><textarea rows={3} value={d.instruction} onChange={(e) => set({ instruction: e.target.value })} /></label>
    <label className="field"><span>{t.schedules.editor.rule}</span><select value={d.kind} onChange={(e) => set({ kind: e.target.value as Draft["kind"] })}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
    {d.kind === "weekly" && <fieldset className="field schedule-weekdays"><legend>{t.schedules.editor.weekdaysLegend}</legend>{WEEKDAYS.map((w, i) => <label key={w}><input type="checkbox" checked={d.weekdays.includes(i + 1)} onChange={(e) => set({ weekdays: e.target.checked ? [...d.weekdays, i + 1].sort() : d.weekdays.filter((x) => x !== i + 1) })} />{w}</label>)}</fieldset>}
    {d.kind === "monthly" && <label className="field"><span>{t.schedules.editor.monthDay}</span><input type="number" min={1} max={31} value={d.monthDay} onChange={(e) => set({ monthDay: e.target.value })} /></label>}
    {d.kind === "once" && <label className="field"><span>{t.schedules.editor.date}</span><input type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} /></label>}
    {(daily || d.kind === "once") && <label className="field"><span>{daily ? t.schedules.editor.timesMulti : t.schedules.editor.time}</span><input value={d.times} inputMode="numeric" placeholder={daily ? t.schedules.editor.timesMultiPlaceholder : t.schedules.editor.timePlaceholder} onChange={(e) => set({ times: e.target.value })} /></label>}
    {d.kind === "interval" && <label className="field"><span>{t.schedules.editor.everyMinutes}</span><input type="number" min={15} value={d.everyMinutes} onChange={(e) => set({ everyMinutes: e.target.value })} /></label>}
    {d.kind === "dates" && <label className="field schedule-edit-wide"><span>{t.schedules.editor.dates}</span><textarea rows={4} value={d.dates} placeholder={"2026-10-08 09:00\n2026-10-15 14:30"} onChange={(e) => set({ dates: e.target.value })} /></label>}
    {d.kind !== "once" && d.kind !== "dates" && <>
      <label className="field"><span>{t.schedules.editor.maxRuns}</span><input type="number" min={1} value={d.maxRuns} onChange={(e) => set({ maxRuns: e.target.value })} /></label>
      <label className="field"><span>{t.schedules.editor.until}</span><input type="date" value={d.until} onChange={(e) => set({ until: e.target.value })} /></label>
    </>}
    <label className="vault-save"><input type="checkbox" checked={d.needsBrowser} onChange={(e) => set({ needsBrowser: e.target.checked })} />{t.schedules.editor.needsBrowser}</label>
    <div className="schedule-actions">
      <button type="submit" className="primary tiny" disabled={busy || !d.title.trim() || !d.instruction.trim()}>{t.schedules.editor.save}</button>
      <button type="button" className="ghost tiny" onClick={onCancel}>{t.schedules.editor.cancel}</button>
    </div>
  </form>;
}
