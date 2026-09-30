import { MessageTime, TaskDuration, useDisplayClock } from "./MessageTime";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEventStream } from "../api";
import type { Attachment, Task } from "../types";
import { AttachmentCards, MessageFileCards } from "./Chat";
import { Markdown } from "./Markdown";
import { FilePreview } from "./FilePreview";
import { TaskBrowser } from "./TaskBrowser";
import type {TaskFeed} from '../taskStatus';
const terminal = new Set(["completed", "failed", "interrupted", "unknown"]);
/** What the dispatcher does with every message; shown in turn while it decides, not as live progress. */
const DISPATCH_HINTS = ["理解你的需求", "对照进行中和历史任务", "决定新开任务还是补充到已有任务"];
const HINT_MS = 1800;
function DispatchHint() {
    const [i, setI] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setI(n => (n + 1) % DISPATCH_HINTS.length), HINT_MS);
        return () => window.clearInterval(timer);
    }, []);
    return <p className="task-dispatch-hint"><span key={i}>{DISPATCH_HINTS[i]}</span></p>;
}
/** Whose move it is: the person's (amber), the AI's (indigo), or stuck on an error (red). */
function turnOf(t: Task): "you" | "ai" | "err" {
    if (t.approvals || t.browser?.request || t.status === "needs_input" || t.status === "blocked") return "you";
    if (["planning_failed", "merge_failed", "merge_unknown", "failed", "unknown"].includes(t.status)) return "err";
    return "ai";
}
const labels: Record<string, string> = { planning: "正在分配", needs_input: "等待你补充", planning_failed: "分配失败", waiting: "等待依赖或资源", queued: "排队中", running: "在办", stopping: "正在停止…", completed: "已完成", failed: "执行失败", interrupted: "已停止", unknown: "结果待核对", blocked: "需要补充" };
export function TaskChat({ onDetails, onOpenLink, onExpired, onFeed, onRevealBrowser }: {
    onDetails: (task: Task) => void;
    /** Open the workspace on the browser, where a taken-over task tab is in front. */
    onRevealBrowser: () => void;
    onOpenLink: (url: string) => void;
    onExpired: () => void;
    onFeed?: (feed:TaskFeed)=>void;
}) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [reference, setReference] = useState<{ id: string; title: string } | null>(null);
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);
    useEffect(()=>{onFeed?.({tasks,nextBefore,connected});},[tasks,nextBefore,connected,onFeed]);
    const scroll = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const input = useRef<HTMLTextAreaElement>(null);
    const pageLoaded = useRef(false);
    const pending = useRef<{
        signature: string;
        id: string;
    } | null>(null);
    const callbacks = useRef({ onExpired });
    callbacks.current = { onExpired };
    const merge = useCallback((fresh: Task[]) => setTasks(old => {
        const map = new Map(old.map(t => [t.id, t]));
        for (const t of fresh)
            if (!map.has(t.id) || t.revision >= map.get(t.id)!.revision)
                map.set(t.id, t);
        return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
    }), []);
    const refresh = useCallback(async () => {
        try {
            const data = await api.main();
            merge(data.tasks);
            setConnected(true);
            if (!pageLoaded.current) {
                setNextBefore(data.nextBefore);
                pageLoaded.current = true;
            }
        }
        catch (err) {
            setConnected(false);
            if ((err as {
                status?: number;
            }).status === 401)
                callbacks.current.onExpired();
        }
    }, [merge]);
    useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [refresh]);
    useEffect(() => { if (scroll.current && stick.current)
        scroll.current.scrollTop = scroll.current.scrollHeight; }, [tasks]);
    const runningIds = tasks.filter(t => ["running", "queued"].includes(t.status)).map(t => t.conversationId).sort().join(",");
    useEffect(() => {
        const closes = runningIds.split(",").filter(Boolean).map(id => {
            let live = false;
            return openEventStream(id, 0, {
                onOpen: () => { live = true; }, onError: () => { live = false; }, onRevoked: () => callbacks.current.onExpired(),
                onEvent: event => {
                    if (live && ["turn.finished", "turn.failed", "approval.requested", "approval.resolved"].includes(event.type))
                        void refresh();
                },
            });
        });
        return () => closes.forEach(close => close());
    }, [runningIds, refresh]);
    const quoteTask = (task: Task) => {
        setReference({ id: task.mergedInto ?? task.id, title: task.mergedTitle ?? task.title });
        input.current?.focus();
    };
    const send = async () => {
        if (busy || uploading || (!draft.trim() && !attachments.length))
            return;
        const text = draft.trim();
        const relatedTaskId = reference?.id ?? null;
        const signature = JSON.stringify({ text, attachments, relatedTaskId });
        const id = pending.current?.signature === signature ? pending.current.id : crypto.randomUUID();
        pending.current = { signature, id };
        setBusy(true);
        setError(null);
        try {
            const { task } = await api.submitTask({ text, attachments, relatedTaskId, clientMessageId: id });
            stick.current = true;
            merge([task]);
            setDraft("");
            setReference(null);
            setAttachments([]);
            pending.current = null;
            void refresh();
            input.current?.focus();
        }
        catch (err) {
            setError(`${err instanceof Error ? err.message : String(err)}（内容已保留，可重试）`);
        }
        finally {
            setBusy(false);
        }
    };
    const pick = async (files: FileList | null) => {
        if (!files)
            return;
        setUploading(true);
        setError(null);
        const errors: string[] = [];
        for (const file of [...files].slice(0, Math.max(0, 6 - attachments.length))) {
            try {
                const a = await api.upload(file);
                setAttachments(old => [...old, a]);
            }
            catch (err) {
                errors.push(`${file.name}：${err instanceof Error ? err.message : "上传失败"}`);
            }
        }
        if (errors.length)
            setError(errors.join("；"));
        setUploading(false);
    };
    const act = async (operation: () => Promise<unknown>) => {
        try {
            await operation();
            await refresh();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };
    const active = tasks.filter(t => !t.mergedInto && !terminal.has(t.status) && !["planning_failed", "blocked", "needs_input"].includes(t.status));
    const now = useDisplayClock(tasks.some(t => ["running", "stopping"].includes(t.status)));
    const awaiting = tasks.filter(t => !t.mergedInto && t.status === "needs_input");
    const browserAsks = tasks.filter(t => !t.mergedInto && !terminal.has(t.status) && t.browser?.request);
    // Keep messages chronological; anchor each live card to its latest accepted
    // supplement. Its controls and duration always use the original task.
    const progressAt = new Map<string, Task>();
    for (const task of tasks) {
        if (task.mergedInto || terminal.has(task.status)) continue;
        const anchor = tasks.filter(t => t.mergedInto === task.id && ["merged", "merging", "steering"].includes(t.status))
            .reduce((latest, t) => t.createdAt >= latest.createdAt ? t : latest, task);
        progressAt.set(anchor.id, task);
    }
    const renderProgress = (t: Task) => <div className={`task-progress turn-${turnOf(t)} ${t.status === "running" || t.status === "planning" ? "active" : ""} ${t.status === "planning" ? "planning" : ""} ${t.status === "needs_input" ? "needs-input" : ""}`}>
          {(() => {
            const summary = <>{t.status === "planning"
              ? <span className="dispatch-glyph" aria-hidden="true"><i/><i/><i/></span>
              : <span className={`dot ${t.approvals || t.browser?.request ? "warn" : ""}`}/>}<span className="task-progress-label" key={t.status}>{t.approvals ? "需要你确认" : t.browser?.request && t.status === "running" ? "需要你操作浏览器" : t.waitReason?.label ?? labels[t.status] ?? t.status}</span><span className="task-progress-title">{t.title}</span></>;
            // Still being dispatched (or dispatch failed): nothing has run yet, so there are no details to open.
            return t.status === "planning" || t.status === "planning_failed"
              ? <div className="task-summary">{summary}</div>
              : <button className="task-summary" onClick={() => onDetails(t)} aria-label={`展开任务：${t.title}`}>{summary}<span aria-hidden>›</span></button>;
          })()}
          {t.status === "planning" && <DispatchHint/>}
          {t.waitReason && <p className="task-intro task-wait-reason">{t.waitReason.message}</p>}
          {t.status === "needs_input" && t.clarification && <div className="task-question" role="status" aria-label="需要你补充">
            <div className="task-question-heading"><span aria-hidden="true">?</span><strong>需要你补充</strong></div>
            <p>{t.clarification}</p><span className="task-question-hint">直接在下方输入回复即可</span>
          </div>}
          {t.description && ["running", "stopping"].includes(t.status) && <p className="task-intro">{t.description}</p>}
          <TaskBrowser task={t} onReveal={onRevealBrowser}/>
          <TaskDuration task={t} now={now}/>
          {t.error && <p className="tiny">{t.error}</p>}
          <div className="task-actions"><button className="ghost tiny" disabled={busy} onClick={() => quoteTask(t)} aria-label={`引用任务：${t.title}`}>引用任务</button>{t.status === "planning_failed" ? <button className="ghost tiny" onClick={() => void act(() => api.retryTaskPlanning(t.id))}>重试分配</button> : t.status === "blocked" ? null : <button className="ghost tiny" disabled={t.status === "stopping"} onClick={() => void act(() => api.stopTask(t.id))}>停止该任务</button>}</div>
        </div>;
    const feed = tasks.flatMap(t => [{ task: t, report: false, at: t.createdAt }, ...(!t.mergedInto && terminal.has(t.status) ? [{ task: t, report: true, at: t.completedAt ?? t.createdAt }] : [])])
        .sort((a, b) => a.at - b.at || Number(a.report) - Number(b.report) || a.task.id.localeCompare(b.task.id));
    return <section className="chat task-chat">
    <header className="chat-head"><div className="chat-title"><h2>主会话</h2><span className={`dot ${connected ? "ok" : "warn"}`}/><span className="chat-sub">{active.length || awaiting.length
        ? <>{awaiting.length > 0 && <span className="turn-pill you">{awaiting.length} 件等你补充</span>}{browserAsks.length > 0 && <span className="turn-pill you">{browserAsks.length} 件等你操作浏览器</span>}{active.length - browserAsks.length > 0 && <span className="turn-pill ai">{active.length - browserAsks.length} 件在办</span>}</>
        : connected ? "随时可以交给我" : "正在连接…"}</span></div></header>
    <div className="chat-scroll task-feed" ref={scroll} onScroll={e => { const n = e.currentTarget; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 80; }}>
      {nextBefore && <button className="ghost" onClick={() => void act(async () => { const d = await api.main(nextBefore); stick.current = false; merge(d.tasks); setNextBefore(d.nextBefore); })}>加载更早的任务</button>}
      {!tasks.length && <div className="empty"><h3>把事情交给我</h3><p>可以接着发不同任务。过程会收拢，完成后在这里回报。</p></div>}
      {feed.map(({ task: t, report }) => report ? <article className={`msg assistant task-report ${t.status}`} key={`${t.id}:report`} data-task-id={t.id}>
        <div className="task-report-heading"><span>{t.title}</span><span className="muted tiny">{labels[t.status]}</span></div>
        <div className="bubble"><Markdown source={t.result || (t.status === "completed" ? "任务已结束，但没有返回文字结果，请打开详情核对。" : t.error || labels[t.status] || t.status)} onOpenLink={onOpenLink} onOpenFile={setPreview}/>{t.result && <MessageFileCards text={t.result} onOpen={setPreview}/>}{t.error && t.result && <p className="error">{t.error}</p>}</div>
        <TaskBrowser task={t} onReveal={onRevealBrowser}/>
        <div className="message-meta"><MessageTime at={t.completedAt} now={now}/><TaskDuration task={t} now={now}/></div>
        <div className="task-actions"><button className="ghost tiny" disabled={busy} onClick={() => quoteTask(t)} aria-label={`引用任务：${t.title}`}>引用任务</button><button className="ghost tiny" onClick={() => onDetails(t)}>查看过程</button></div>
      </article> : <div className="task-entry" key={t.id} data-task-id={t.id}>
        <article className="msg user"><div className="bubble">{t.relatedTaskId && <small className="muted">引用：{t.relatedTaskTitle ?? tasks.find(task => task.id === t.relatedTaskId)?.title ?? "此前任务"}</small>}<p>{t.text}</p>{t.attachments.length > 0 && <AttachmentCards attachments={t.attachments} onOpen={setPreview}/>}<div className="message-meta"><MessageTime at={t.createdAt} now={now}/></div></div></article>
        {t.mergedInto && <div className="task-supplement"><button className="ghost tiny" onClick={() => onDetails(t)}>{t.status === "merged" ? "已补充到" : t.status === "merging" || t.status === "steering" ? "正在补充到" : t.status === "interrupted" ? "已取消补充" : "补充需要核对"}：{t.mergedTitle}</button>{t.waitReason && <p className="tiny">{t.waitReason.message}</p>}{t.error && <p className="tiny error">{t.error}</p>}</div>}
        {progressAt.get(t.id) && renderProgress(progressAt.get(t.id)!)}
      </div>)}
    </div>
    {error && <div className="banner error" role="alert">{error}<button onClick={() => setError(null)}>关闭</button></div>}
    <div className="composer">
      {reference && <div className="task-reference" role="status"><div><span className="muted tiny">引用任务</span><strong title={reference.title}>{reference.title}</strong></div><button type="button" className="ghost" disabled={busy} aria-label="取消引用任务" onClick={() => { setReference(null); input.current?.focus(); }}>×</button></div>}
      {!!attachments.length && <div className="chips">{attachments.map(a => <span className="chip" key={a.path}>{a.name}<button aria-label="移除附件" disabled={busy} onClick={() => setAttachments(old => old.filter(x => x.path !== a.path))}>×</button></span>)}</div>}
      <textarea ref={input} rows={2} value={draft} aria-label="消息" placeholder={reference ? "补充、继续或更新这个任务…" : "交给我一个任务，也可以直接补充或回答…"} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
    } }}/>
      <div className="composer-row"><label className={`file-button ${busy || uploading ? "disabled" : ""}`}>{uploading ? "上传中…" : "附件"}<input type="file" multiple className="file-input" aria-label="添加附件" data-testid="attachment-input" disabled={busy || uploading} onChange={e => { void pick(e.target.files); e.target.value = ""; }}/></label><span className="spacer"/><button className="primary" disabled={busy || uploading || (!draft.trim() && !attachments.length)} onClick={() => void send()}>{busy ? "提交中…" : "发送"}</button></div>
    </div>
    {preview && <FilePreview path={preview} onClose={() => setPreview(null)} onOpenLink={onOpenLink}/>}
  </section>;
}
