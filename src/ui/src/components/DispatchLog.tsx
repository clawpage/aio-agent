import { createPortal } from "react-dom";
import { PopupSurface } from "./PopupMotion";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { DispatchLog as Log, DispatchLogEntry, DispatchStep } from "../types";

const SOURCES: Record<string, string> = {
  active: "进行中", recent: "最近", today: "今天", recall: "召回", context: "上下文召回", search: "搜索", explicit: "手动引用",
};

const clock = (ts: number) => new Date(ts).toLocaleString("sv-SE", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pct = (p: number) => `${Math.round(p * 100)}%`;

function decision(entry: DispatchLogEntry, name: (id: string) => string): string {
  if (entry.failed) return `失败：${entry.failReason ?? "未知原因"}`;
  if (entry.chosen.appendTo) return `追加到「${name(entry.chosen.appendTo)}」`;
  if (entry.chosen.resume) return `续接「${name(entry.chosen.resume)}」的原执行会话`;
  return "作为新任务";
}

function Step({ step, name }: { step: DispatchStep; name: (id: string) => string }) {
  switch (step.kind) {
    case "context":
      return (
        <li>
          <h4>主会话时间线 <span className="muted tiny">候选 {step.candidates} 个 · {clock(step.at)}</span></h4>
          <pre>{step.timeline}</pre>
        </li>
      );
    case "jev":
      return (
        <li>
          <h4>Jev 判断接续哪个任务 <span className="muted tiny">{clock(step.at)}</span></h4>
          {step.result ? (
            <p>
              选择 <strong>{step.result.choice === "NEW" ? "新任务" : `「${name(step.result.choice)}」`}</strong>（{pct(step.result.probabilities[step.result.choice] ?? 0)}，
              {step.result.confident ? "有把握，作为强提示" : "不确定，只作参考"}，{step.result.latencyMs} ms）
            </p>
          ) : <p className="error">不可用：{step.error}</p>}
          {step.result && (
            <ul className="dispatch-log-probs">
              {Object.entries(step.result.probabilities).sort((a, b) => b[1] - a[1]).map(([id, p]) => <li key={id}>{pct(p)} · {id === "NEW" ? "新任务" : name(id)}</li>)}
            </ul>
          )}
          <details><summary>给 Jev 的候选说明</summary><pre>{Object.entries(step.criteria).map(([id, text]) => `${id}\n  ${text}`).join("\n")}</pre></details>
        </li>
      );
    case "ask":
      return (
        <li>
          <h4>派单器第 {step.round} 轮 <span className="muted tiny">{clock(step.at)}</span></h4>
          {step.correction && <p className="error tiny">上一轮回答无法使用，带着原因重问：{step.correction}</p>}
          {step.searched && <p>要求检索历史任务：{step.searched.map((q) => `「${q}」`).join("、")}</p>}
          <pre>{step.answer ?? "（没有回答）"}</pre>
          <details><summary>完整提示词（{step.prompt.length.toLocaleString()} 字）</summary><pre>{step.prompt}</pre></details>
        </li>
      );
    case "timing": {
      const t = step.timing;
      const stages = [
        ["排队", t.queueMs], ["准备候选", t.contextMs], ["Jev 判断", t.jevMs],
        ["沙箱就绪", t.sandboxMs], ["模型连接", t.connectionMs],
        ["创建会话", t.threadStartMs], ["提交请求", t.turnStartMs],
        ["提交至首字", t.firstTextMs], ["首字至完成", t.finishMs],
        ["模型调用", t.classifierMs], ["本轮总计", t.totalMs],
      ] as const;
      return (
        <li>
          <h4>派单耗时 · 第 {step.round} 轮 <span className="muted tiny">{clock(step.at)}</span></h4>
          <p>{t.model ?? "模型未返回"}{t.effort ? ` · ${t.effort}` : ""}{t.attempts && t.attempts > 1 ? ` · 建会话尝试 ${t.attempts} 次` : ""}</p>
          <p className="muted tiny">{stages.filter(([, ms]) => ms !== undefined).map(([label, ms]) => `${label} ${ms} ms`).join(" · ")}</p>
        </li>
      );
    }
    case "plan":
      return (
        <li>
          <h4>最终计划 <span className="muted tiny">{clock(step.at)}</span></h4>
          {step.repairs.length > 0 && <p className="tiny">自动修正：{step.repairs.join("；")}</p>}
          <pre>{JSON.stringify(step.plan, null, 2)}</pre>
        </li>
      );
    case "failed":
      return (
        <li>
          <h4>派单失败 <span className="muted tiny">{clock(step.at)}</span></h4>
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
                <h3>{log.entries.length > 1 ? `第 ${log.entries.length - i} 次派单 · ` : ""}{decision(entry, name)}</h3>
                <p className="muted tiny">{clock(entry.at)} · 耗时 {(entry.latencyMs / 1000).toFixed(1)} 秒 · 派单器 {entry.rounds} 轮 · 提示词共 {entry.promptChars.toLocaleString()} 字</p>
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
                {entry.steps.length > 0 ? <ol className="dispatch-log-steps">{entry.steps.map((step, j) => <Step key={j} step={step} name={name} />)}</ol> : <p className="muted tiny">这次派单早于逐步日志，只有上面的汇总。</p>}
              </section>
            );
          })}
        </div>
      </div>
    </PopupSurface>,
    document.body,
  );
}
