import { useState } from "react";
import type { Schedule, ScheduleSpec } from "../types";

const KINDS: Array<{ id: ScheduleSpec["kind"]; label: string }> = [
  { id: "daily", label: "每天" },
  { id: "weekly", label: "每周" },
  { id: "monthly", label: "每月" },
  { id: "once", label: "一次" },
  { id: "dates", label: "几个日期" },
  { id: "interval", label: "每隔一段时间" },
];
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

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

const list = (text: string) => text.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean);

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
  return <form className="vault-form vault-edit schedule-edit" aria-label={`修改定时任务：${schedule.title}`} onSubmit={(e) => { e.preventDefault(); onSave({ title: d.title, instruction: d.instruction, schedule: specOf(d), needsBrowser: d.needsBrowser }); }}>
    <label className="field schedule-edit-wide"><span>名称</span><input value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} /></label>
    <label className="field schedule-edit-wide"><span>每次要做的事</span><textarea rows={3} value={d.instruction} onChange={(e) => set({ instruction: e.target.value })} /></label>
    <label className="field"><span>运行规则</span><select value={d.kind} onChange={(e) => set({ kind: e.target.value as Draft["kind"] })}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
    {d.kind === "weekly" && <fieldset className="field schedule-weekdays"><legend>周几</legend>{WEEKDAYS.map((w, i) => <label key={w}><input type="checkbox" checked={d.weekdays.includes(i + 1)} onChange={(e) => set({ weekdays: e.target.checked ? [...d.weekdays, i + 1].sort() : d.weekdays.filter((x) => x !== i + 1) })} />{w}</label>)}</fieldset>}
    {d.kind === "monthly" && <label className="field"><span>每月几号</span><input type="number" min={1} max={31} value={d.monthDay} onChange={(e) => set({ monthDay: e.target.value })} /></label>}
    {d.kind === "once" && <label className="field"><span>日期</span><input type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} /></label>}
    {(daily || d.kind === "once") && <label className="field"><span>{daily ? "时间（一天多次用逗号隔开）" : "时间"}</span><input value={d.times} inputMode="numeric" placeholder={daily ? "例如 08:00, 18:00" : "例如 09:00"} onChange={(e) => set({ times: e.target.value })} /></label>}
    {d.kind === "interval" && <label className="field"><span>每隔几分钟（至少 15）</span><input type="number" min={15} value={d.everyMinutes} onChange={(e) => set({ everyMinutes: e.target.value })} /></label>}
    {d.kind === "dates" && <label className="field schedule-edit-wide"><span>运行时间（一行一个）</span><textarea rows={4} value={d.dates} placeholder={"2026-10-08 09:00\n2026-10-15 14:30"} onChange={(e) => set({ dates: e.target.value })} /></label>}
    {d.kind !== "once" && d.kind !== "dates" && <>
      <label className="field"><span>最多运行几次（可不填）</span><input type="number" min={1} value={d.maxRuns} onChange={(e) => set({ maxRuns: e.target.value })} /></label>
      <label className="field"><span>到哪天为止（可不填）</span><input type="date" value={d.until} onChange={(e) => set({ until: e.target.value })} /></label>
    </>}
    <label className="vault-save"><input type="checkbox" checked={d.needsBrowser} onChange={(e) => set({ needsBrowser: e.target.checked })} />运行时用浏览器查网页</label>
    <div className="schedule-actions">
      <button type="submit" className="primary tiny" disabled={busy || !d.title.trim() || !d.instruction.trim()}>保存</button>
      <button type="button" className="ghost tiny" onClick={onCancel}>取消</button>
    </div>
  </form>;
}
