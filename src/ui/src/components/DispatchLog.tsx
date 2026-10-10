import { createPortal } from "react-dom";
import { PopupSurface } from "./PopupMotion";
import { useEffect, useState } from "react";
import { api } from "../api";
import { t as i18n } from "../i18n";
import type { DispatchLog as Log, DispatchLogEntry, DispatchStep } from "../types";

// "today" and "search" only appear in dispatch logs recorded before those sources were removed.
const SOURCES: Record<string, string> = i18n.dispatch.sources;

const clock = (ts: number) => new Date(ts).toLocaleString("sv-SE", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pct = (p: number) => `${Math.round(p * 100)}%`;

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

function decision(entry: DispatchLogEntry, name: (id: string) => string): string {
  if (entry.failed) return i18n.dispatch.decision.failed(entry.failReason ?? i18n.dispatch.decision.unknownReason);
  if (entry.chosen.appendTo) return i18n.dispatch.decision.appendTo(name(entry.chosen.appendTo));
  if (entry.chosen.resume) return i18n.dispatch.decision.resume(name(entry.chosen.resume));
  return i18n.dispatch.decision.newTask;
}

/** The model(s) the dispatcher actually ran on, from its own timing records. */
function models(entry: DispatchLogEntry): string[] {
  const seen = new Set<string>();
  for (const step of entry.steps) if (step.kind === "timing" && step.timing.model) seen.add(`${step.timing.model}${step.timing.effort ? ` · ${step.timing.effort}` : ""}`);
  return [...seen];
}

/** Labelled horizontal bars; `share` is 0–1 of the track. */
function Bars({ rows, label }: { rows: Array<{ key: string; name: string; share: number; value: string }>; label: string }) {
  return (
    <ul className="dispatch-log-bars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          <span className="dispatch-log-bar-name">{row.name}</span>
          <span className="dispatch-log-bar-track"><span style={{ width: `${Math.max(0, Math.min(1, row.share)) * 100}%` }} /></span>
          <span className="dispatch-log-bar-value">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

function StepHead({ title, offset, children }: { title: string; offset: number; children?: React.ReactNode }) {
  return <h4>{title}{children} <span className="muted tiny">+{(offset / 1000).toFixed(1)} s</span></h4>;
}

function Step({ step, name, start }: { step: DispatchStep; name: (id: string) => string; start: number }) {
  const offset = step.at - start;
  switch (step.kind) {
    case "context":
      return (
        <li>
          <StepHead title={i18n.dispatch.steps.context(step.candidates)} offset={offset} />
          <pre>{step.timeline}</pre>
        </li>
      );
    case "jev": {
      const r = step.result;
      return (
        <li>
          <StepHead title={i18n.dispatch.steps.jev} offset={offset} />
          {r?.suggestion ? (
            <p>{i18n.dispatch.steps.suggest}<strong>{r.suggestion.kind === "new" ? i18n.dispatch.steps.newTask : r.suggestion.kind === "steer" ? i18n.dispatch.steps.suggestAppend(name(r.suggestion.taskId!)) : i18n.dispatch.steps.suggestResume(name(r.suggestion.taskId!))}</strong>{i18n.dispatch.steps.suggestTail(pct(r.suggestion.probability), r.confident ? i18n.dispatch.steps.highConfidence : i18n.dispatch.steps.uncertain, r.latencyMs)}</p>
          ) : r ? (
            <p>
              {i18n.dispatch.steps.choose}<strong>{r.choice === "NEW" ? i18n.dispatch.steps.newTask : i18n.dispatch.steps.quoted(name(r.choice))}</strong>
              {i18n.dispatch.steps.chooseTail(pct(r.probabilities[r.choice] ?? 0), r.confident ? i18n.dispatch.steps.confidentHint : i18n.dispatch.steps.uncertainHint, r.latencyMs)}
            </p>
          ) : <p className="error">{i18n.dispatch.steps.unavailable(step.error ?? "")}</p>}
          {r?.scores && Object.keys(r.scores).length > 0 && (
            <>
              <p className="muted tiny">{i18n.dispatch.steps.perTask}</p>
              <Bars label={i18n.dispatch.steps.perTask} rows={Object.entries(r.scores).sort((a, b) => b[1] - a[1]).map(([id, p]) => ({ key: id, name: name(id), share: p, value: pct(p) }))} />
            </>
          )}
          {r && (
            <>
              <p className="muted tiny">{i18n.dispatch.steps.routing}</p>
              <Bars label={i18n.dispatch.steps.routing} rows={Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).map(([id, p]) => ({ key: id, name: id === "NEW" ? i18n.dispatch.steps.newTask : name(id), share: p, value: pct(p) }))} />
            </>
          )}
          <details><summary>{i18n.dispatch.steps.criteria}</summary><pre>{Object.entries(step.criteria).map(([id, text]) => `${id}\n  ${text}`).join("\n")}</pre></details>
        </li>
      );
    }
    case "ask":
      return (
        <li>
          <StepHead title={i18n.dispatch.steps.ask(step.round)} offset={offset} />
          {step.correction && <p className="error tiny">{i18n.dispatch.steps.correction(step.correction)}</p>}
          <pre>{step.answer ?? i18n.dispatch.steps.noAnswer}</pre>
          <details><summary>{i18n.dispatch.steps.fullPrompt(step.prompt.length.toLocaleString())}</summary><pre>{step.prompt}</pre></details>
        </li>
      );
    case "timing": {
      const t = step.timing;
      const stages = ([
        [i18n.dispatch.stages.queue, t.queueMs], [i18n.dispatch.stages.context, t.contextMs], [i18n.dispatch.stages.jev, t.jevMs],
        [i18n.dispatch.stages.sandbox, t.sandboxMs], [i18n.dispatch.stages.connection, t.connectionMs],
        [i18n.dispatch.stages.threadStart, t.threadStartMs], [i18n.dispatch.stages.turnStart, t.turnStartMs],
        [i18n.dispatch.stages.firstText, t.firstTextMs], [i18n.dispatch.stages.finish, t.finishMs],
      ] as Array<[string, number | undefined]>).filter((s): s is [string, number] => s[1] !== undefined);
      const whole = Math.max(t.totalMs ?? 0, ...stages.map(([, v]) => v), 1);
      return (
        <li>
          <StepHead title={i18n.dispatch.steps.timing(step.round)} offset={offset}>
            {" "}<span className="dispatch-log-chip">{t.model ?? i18n.dispatch.steps.noModel}{t.effort ? ` · ${t.effort}` : ""}</span>
          </StepHead>
          {t.attempts && t.attempts > 1 ? <p className="tiny">{i18n.dispatch.steps.attempts(t.attempts)}</p> : null}
          <Bars label={i18n.dispatch.steps.stagesLabel} rows={stages.map(([label, v]) => ({ key: label, name: label, share: v / whole, value: ms(v) }))} />
          <p className="muted tiny">{[t.classifierMs !== undefined ? i18n.dispatch.steps.modelCall(ms(t.classifierMs)) : null, t.totalMs !== undefined ? i18n.dispatch.steps.roundTotal(ms(t.totalMs)) : null].filter(Boolean).join(" · ")}</p>
        </li>
      );
    }
    case "plan": {
      const plan = step.plan as { title?: unknown; description?: unknown };
      return (
        <li>
          <StepHead title={i18n.dispatch.steps.plan} offset={offset} />
          {typeof plan.title === "string" && <p><strong>{plan.title}</strong></p>}
          {typeof plan.description === "string" && <p className="tiny">{plan.description}</p>}
          {step.repairs.length > 0 && <p className="tiny">{i18n.dispatch.entry.repairs(step.repairs)}</p>}
          <details><summary>{i18n.dispatch.steps.planJson}</summary><pre>{JSON.stringify(step.plan, null, 2)}</pre></details>
        </li>
      );
    }
    case "failed":
      return (
        <li>
          <StepHead title={i18n.dispatch.steps.failed} offset={offset} />
          <p className="error">{step.reason}</p>
        </li>
      );
  }
}

/** Owner debug: every dispatch of one message, with what each party was asked and answered. */
export function DispatchLog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.dispatchLog(taskId).then((l) => { if (!cancelled) setLog(l); }, (err) => { if (!cancelled) setError(err instanceof Error ? err.message : i18n.dispatch.loadFailed); });
    return () => { cancelled = true; };
  }, [taskId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <PopupSurface className="file-preview-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="file-preview dispatch-log" role="dialog" aria-modal="true" aria-label={i18n.dispatch.title}>
        <header className="file-preview-head">
          <span className="file-preview-name">{i18n.dispatch.title}{log ? ` · ${log.task.title}` : ""}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>{i18n.dispatch.close}</button>
        </header>
        <div className="dispatch-log-body">
          {error && <p className="error" role="alert">{error}</p>}
          {!log && !error && <p className="muted">{i18n.dispatch.loading}</p>}
          {log && <p className="dispatch-log-message"><span className="muted tiny">{i18n.dispatch.userMessage}</span><br />{log.task.text}</p>}
          {log && !log.entries.length && <p className="muted">{i18n.dispatch.noEntries}</p>}
          {log?.entries.map((entry, i) => {
            const titles = new Map(entry.candidates.map((c) => [c.id, c.title ?? c.id]));
            const name = (id: string) => titles.get(id) ?? id;
            return (
              <section key={entry.at + ":" + i} className="dispatch-log-entry" data-testid="dispatch-log-entry">
                <h3 className={entry.failed ? "error" : undefined}>{log.entries.length > 1 ? i18n.dispatch.entry.index(log.entries.length - i) : ""}{decision(entry, name)}</h3>
                <div className="dispatch-log-chips">
                  {models(entry).map((m) => <span key={m} className="dispatch-log-chip">{m}</span>)}
                  <span className="dispatch-log-chip">{i18n.dispatch.entry.latency((entry.latencyMs / 1000).toFixed(1))}</span>
                  <span className="dispatch-log-chip">{i18n.dispatch.entry.rounds(entry.rounds)}</span>
                  <span className="dispatch-log-chip">{i18n.dispatch.entry.promptChars(entry.promptChars.toLocaleString())}</span>
                  <span className="muted tiny">{clock(entry.at)}</span>
                </div>
                {entry.chosen.related.length > 0 && <p>{i18n.dispatch.entry.related(entry.chosen.related.map(name))}</p>}
                {entry.repairs.length > 0 && <p className="tiny">{i18n.dispatch.entry.repairs(entry.repairs)}</p>}
                <details>
                  <summary>{i18n.dispatch.entry.candidates(entry.candidates.length)}</summary>
                  <ul className="dispatch-log-candidates">
                    {entry.candidates.map((c) => (
                      <li key={c.id}>
                        <span>{c.title ?? i18n.dispatch.entry.deleted}</span> <span className="muted tiny">{SOURCES[c.source] ?? c.source}{c.rank ? i18n.dispatch.entry.rank(c.rank, c.score) : ""} · {c.id}</span>
                      </li>
                    ))}
                  </ul>
                </details>
                {entry.steps.length > 0 ? <ol className="dispatch-log-steps">{entry.steps.map((step, j) => <Step key={j} step={step} name={name} start={entry.steps[0].at} />)}</ol> : <p className="muted tiny">{i18n.dispatch.entry.noSteps}</p>}
              </section>
            );
          })}
        </div>
      </div>
    </PopupSurface>,
    document.body,
  );
}
