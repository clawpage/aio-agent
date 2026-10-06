import { createPortal } from "react-dom";
import { PopupSurface } from "./PopupMotion";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { DispatchLog as Log, DispatchLogEntry, DispatchStep } from "../types";

// "today" and "search" only appear in dispatch logs recorded before those sources were removed.
const SOURCES: Record<string, string> = {
  active: "进行中", recent: "最近", today: "今天", recall: "召回", context: "上下文召回", search: "搜索", explicit: "手动引用",
};

const clock = (ts: number) => new Date(ts).toLocaleString("sv-SE", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pct = (p: number) => `${Math.round(p * 100)}%`;

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

function decision(entry: DispatchLogEntry, name: (id: string) => string): string {
  if (entry.failed) return `失败：${entry.failReason ?? "未知原因"}`;
  if (entry.chosen.appendTo) return `追加到「${name(entry.chosen.appendTo)}」`;
  if (entry.chosen.resume) return `续接「${name(entry.chosen.resume)}」的原执行会话`;
  return "作为新任务";
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
          <StepHead title={`主会话时间线 · 候选 ${step.candidates} 个`} offset={offset} />
          <pre>{step.timeline}</pre>
        </li>
      );
    case "jev": {
      const r = step.result;
      return (
        <li>
          <StepHead title="Jev 相关性与接续建议" offset={offset} />
          {r?.suggestion ? (
            <p>建议 <strong>{r.suggestion.kind === "new" ? "新任务" : `${r.suggestion.kind === "steer" ? "追加" : "续接"}「${name(r.suggestion.taskId!)}」`}</strong>（{pct(r.suggestion.probability)}，{r.confident ? "高置信" : "不确定"}，{r.latencyMs} ms）；由派单器最终决定。</p>
          ) : r ? (
            <p>
              选择 <strong>{r.choice === "NEW" ? "新任务" : `「${name(r.choice)}」`}</strong>（{pct(r.probabilities[r.choice] ?? 0)}，
              {r.confident ? "有把握，作为强提示" : "不确定，只作参考"}，{r.latencyMs} ms）
            </p>
          ) : <p className="error">不可用：{step.error}</p>}
          {r?.scores && Object.keys(r.scores).length > 0 && (
            <>
              <p className="muted tiny">逐任务相关性</p>
              <Bars label="逐任务相关性" rows={Object.entries(r.scores).sort((a, b) => b[1] - a[1]).map(([id, p]) => ({ key: id, name: name(id), share: p, value: pct(p) }))} />
            </>
          )}
          {r && (
            <>
              <p className="muted tiny">路由概率</p>
              <Bars label="路由概率" rows={Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).map(([id, p]) => ({ key: id, name: id === "NEW" ? "新任务" : name(id), share: p, value: pct(p) }))} />
            </>
          )}
          <details><summary>给 Jev 的候选说明</summary><pre>{Object.entries(step.criteria).map(([id, text]) => `${id}\n  ${text}`).join("\n")}</pre></details>
        </li>
      );
    }
    case "ask":
      return (
        <li>
          <StepHead title={`派单器第 ${step.round} 轮回答`} offset={offset} />
          {step.correction && <p className="error tiny">上一轮回答无法使用，带着原因重问：{step.correction}</p>}
          <pre>{step.answer ?? "（没有回答）"}</pre>
          <details><summary>完整提示词（{step.prompt.length.toLocaleString()} 字）</summary><pre>{step.prompt}</pre></details>
        </li>
      );
    case "timing": {
      const t = step.timing;
      const stages = ([
        ["排队", t.queueMs], ["准备候选", t.contextMs], ["Jev 判断", t.jevMs],
        ["沙箱就绪", t.sandboxMs], ["模型连接", t.connectionMs],
        ["创建会话", t.threadStartMs], ["提交请求", t.turnStartMs],
        ["提交至首字", t.firstTextMs], ["首字至完成", t.finishMs],
      ] as Array<[string, number | undefined]>).filter((s): s is [string, number] => s[1] !== undefined);
      const whole = Math.max(t.totalMs ?? 0, ...stages.map(([, v]) => v), 1);
      return (
        <li>
          <StepHead title={`派单耗时 · 第 ${step.round} 轮`} offset={offset}>
            {" "}<span className="dispatch-log-chip">{t.model ?? "模型未返回"}{t.effort ? ` · ${t.effort}` : ""}</span>
          </StepHead>
          {t.attempts && t.attempts > 1 ? <p className="tiny">尝试 {t.attempts} 次（建会话超时或模型满载后重试）</p> : null}
          <Bars label="各阶段耗时" rows={stages.map(([label, v]) => ({ key: label, name: label, share: v / whole, value: ms(v) }))} />
          <p className="muted tiny">{[t.classifierMs !== undefined ? `模型调用 ${ms(t.classifierMs)}` : null, t.totalMs !== undefined ? `本轮总计 ${ms(t.totalMs)}` : null].filter(Boolean).join(" · ")}</p>
        </li>
      );
    }
    case "plan": {
      const plan = step.plan as { title?: unknown; description?: unknown };
      return (
        <li>
          <StepHead title="最终计划" offset={offset} />
          {typeof plan.title === "string" && <p><strong>{plan.title}</strong></p>}
          {typeof plan.description === "string" && <p className="tiny">{plan.description}</p>}
          {step.repairs.length > 0 && <p className="tiny">自动修正：{step.repairs.join("；")}</p>}
          <details><summary>计划 JSON</summary><pre>{JSON.stringify(step.plan, null, 2)}</pre></details>
        </li>
      );
    }
    case "failed":
      return (
        <li>
          <StepHead title="派单失败" offset={offset} />
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
    api.dispatchLog(taskId).then((l) => { if (!cancelled) setLog(l); }, (err) => { if (!cancelled) setError(err instanceof Error ? err.message : "读取失败"); });
    return () => { cancelled = true; };
  }, [taskId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <PopupSurface className="file-preview-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="file-preview dispatch-log" role="dialog" aria-modal="true" aria-label="派单日志">
        <header className="file-preview-head">
          <span className="file-preview-name">派单日志{log ? ` · ${log.task.title}` : ""}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>关闭</button>
        </header>
        <div className="dispatch-log-body">
          {error && <p className="error" role="alert">{error}</p>}
          {!log && !error && <p className="muted">正在读取…</p>}
          {log && <p className="dispatch-log-message"><span className="muted tiny">用户消息</span><br />{log.task.text}</p>}
          {log && !log.entries.length && <p className="muted">这条消息没有派单记录（派单日志从调试功能上线后开始记录，也可能是手动引用直接追加的补充）。</p>}
          {log?.entries.map((entry, i) => {
            const titles = new Map(entry.candidates.map((c) => [c.id, c.title ?? c.id]));
            const name = (id: string) => titles.get(id) ?? id;
            return (
              <section key={entry.at + ":" + i} className="dispatch-log-entry" data-testid="dispatch-log-entry">
                <h3 className={entry.failed ? "error" : undefined}>{log.entries.length > 1 ? `第 ${log.entries.length - i} 次派单 · ` : ""}{decision(entry, name)}</h3>
                <div className="dispatch-log-chips">
                  {models(entry).map((m) => <span key={m} className="dispatch-log-chip">{m}</span>)}
                  <span className="dispatch-log-chip">耗时 {(entry.latencyMs / 1000).toFixed(1)} 秒</span>
                  <span className="dispatch-log-chip">派单器 {entry.rounds} 轮</span>
                  <span className="dispatch-log-chip">提示词 {entry.promptChars.toLocaleString()} 字</span>
                  <span className="muted tiny">{clock(entry.at)}</span>
                </div>
                {entry.chosen.related.length > 0 && <p>关联背景：{entry.chosen.related.map((id) => `「${name(id)}」`).join("、")}</p>}
                {entry.repairs.length > 0 && <p className="tiny">自动修正：{entry.repairs.join("；")}</p>}
                <details>
                  <summary>候选任务（{entry.candidates.length} 个）</summary>
                  <ul className="dispatch-log-candidates">
                    {entry.candidates.map((c) => (
                      <li key={c.id}>
                        <span>{c.title ?? "（已删除）"}</span> <span className="muted tiny">{SOURCES[c.source] ?? c.source}{c.rank ? ` · 第 ${c.rank} 名 · ${c.score}` : ""} · {c.id}</span>
                      </li>
                    ))}
                  </ul>
                </details>
                {entry.steps.length > 0 ? <ol className="dispatch-log-steps">{entry.steps.map((step, j) => <Step key={j} step={step} name={name} start={entry.steps[0].at} />)}</ol> : <p className="muted tiny">这次派单早于逐步日志，只有上面的汇总。</p>}
              </section>
            );
          })}
        </div>
      </div>
    </PopupSurface>,
    document.body,
  );
}
