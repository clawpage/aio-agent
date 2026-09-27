import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEventStream } from "../api";
import type { Attachment, Task } from "../types";
import { itemOpensSandboxBrowser } from "../browserCommand";
import { AttachmentCards, MessageFileCards } from "./Chat";
import { Markdown } from "./Markdown";
import { FilePreview } from "./FilePreview";
const terminal = new Set(["completed", "failed", "interrupted", "unknown"]);
const labels: Record<string, string> = { planning: "正在分配…", planning_failed: "分配失败", waiting: "等待依赖或资源", queued: "排队中", running: "Working…", stopping: "正在停止…", completed: "已完成", failed: "执行失败", interrupted: "已停止", unknown: "结果待核对", blocked: "需要补充" };
export function TaskChat({ onDetails, onOpenWorkspace, onOpenLink, onBrowserNavigate, onExpired }: {
    onDetails: (task: Task) => void;
    onOpenWorkspace: () => void;
    onOpenLink: (url: string) => void;
    onBrowserNavigate: () => void;
    onExpired: () => void;
}) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [related, setRelated] = useState<Task | null>(null);
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);
    const scroll = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const input = useRef<HTMLTextAreaElement>(null);
    const pageLoaded = useRef(false);
    const pending = useRef<{
        signature: string;
        id: string;
    } | null>(null);
    const callbacks = useRef({ onBrowserNavigate, onExpired });
    callbacks.current = { onBrowserNavigate, onExpired };
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
                    if (live && event.type === "item/started" && itemOpensSandboxBrowser(event.payload.item as Record<string, unknown>) && document.visibilityState === "visible" && document.hasFocus())
                        callbacks.current.onBrowserNavigate();
                    if (live && ["turn.finished", "turn.failed", "approval.requested", "approval.resolved"].includes(event.type))
                        void refresh();
                },
            });
        });
        return () => closes.forEach(close => close());
    }, [runningIds, refresh]);
    const send = async () => {
        if (busy || uploading || (!draft.trim() && !attachments.length))
            return;
        const text = draft.trim();
        const signature = JSON.stringify({ text, attachments, related: related?.id });
        const id = pending.current?.signature === signature ? pending.current.id : crypto.randomUUID();
        pending.current = { signature, id };
        setBusy(true);
        setError(null);
        try {
            const { task } = await api.submitTask({ text, attachments, relatedTaskId: related?.id ?? null, clientMessageId: id });
            stick.current = true;
            merge([task]);
            setDraft("");
            setAttachments([]);
            setRelated(null);
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
    const relate = (task: Task) => { setRelated(task); input.current?.focus(); };
    const active = tasks.filter(t => !t.mergedInto && !terminal.has(t.status) && !["planning_failed", "blocked"].includes(t.status));
    const feed = tasks.flatMap(t => [{ task: t, report: false, at: t.createdAt }, ...(!t.mergedInto && terminal.has(t.status) ? [{ task: t, report: true, at: t.completedAt ?? t.createdAt }] : [])])
        .sort((a, b) => a.at - b.at || Number(a.report) - Number(b.report) || a.task.id.localeCompare(b.task.id));
    return <section className="chat task-chat">
    <header className="chat-head"><div className="chat-title"><h2>主会话</h2><span className={`dot ${connected ? "ok" : "warn"}`}/><span className="chat-sub">{active.length ? `${active.length} 个任务处理中` : connected ? "随时可以交给我" : "正在连接…"}</span></div><button className="ghost" onClick={onOpenWorkspace}>工作区</button></header>
    <div className="chat-scroll task-feed" ref={scroll} onScroll={e => { const n = e.currentTarget; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 80; }}>
      {nextBefore && <button className="ghost" onClick={() => void act(async () => { const d = await api.main(nextBefore); stick.current = false; merge(d.tasks); setNextBefore(d.nextBefore); })}>加载更早的任务</button>}
      {!tasks.length && <div className="empty"><h3>把事情交给我</h3><p>可以接着发不同任务。过程会收拢，完成后在这里回报。</p></div>}
      {feed.map(({ task: t, report }) => report ? <article className={`msg assistant task-report ${t.status}`} key={`${t.id}:report`} data-task-id={t.id}>
        <div className="task-report-heading"><span>{t.title}</span><span className="muted tiny">{labels[t.status]}</span></div>
        <div className="bubble"><Markdown source={t.result || (t.status === "completed" ? "任务已结束，但没有返回文字结果，请打开详情核对。" : t.error || labels[t.status] || t.status)} onOpenLink={onOpenLink} onOpenFile={setPreview}/>{t.result && <MessageFileCards text={t.result} onOpen={setPreview}/>}{t.error && t.result && <p className="error">{t.error}</p>}</div>
        <div className="task-actions"><button className="ghost tiny" onClick={() => relate(t)}>继续此任务</button><button className="ghost tiny" onClick={() => onDetails(t)}>查看过程</button></div>
      </article> : <div className="task-entry" key={t.id} data-task-id={t.id}>
        <article className="msg user"><div className="bubble">{t.relatedTaskId && <small className="muted">关联任务</small>}<p>{t.text}</p>{t.attachments.length > 0 && <AttachmentCards attachments={t.attachments} onOpen={setPreview}/>}</div></article>
        {t.mergedInto && <div className="task-supplement"><button className="ghost tiny" onClick={() => onDetails(t)}>{t.status === "merged" ? "已补充到" : t.status === "merging" || t.status === "steering" ? "正在补充到" : t.status === "interrupted" ? "已取消补充" : "补充需要核对"}：{t.mergedTitle}</button>{t.error && <p className="tiny error">{t.error}</p>}</div>}
        {!t.mergedInto && !terminal.has(t.status) && <div className={`task-progress ${t.status === "running" ? "active" : ""}`}>
          <button className="task-summary" onClick={() => onDetails(t)} aria-label={`展开任务：${t.title}`}><span className={`dot ${t.approvals ? "warn" : ""}`}/><span className="task-progress-label">{t.approvals ? "需要你确认" : labels[t.status] ?? t.status}</span><span className="task-progress-title">{t.title}</span><span aria-hidden>›</span></button>
          {t.error && <p className="tiny">{t.error}</p>}
          <div className="task-actions">{t.status === "planning_failed" ? <button className="ghost tiny" onClick={() => void act(() => api.retryTaskPlanning(t.id))}>重试分配</button> : t.status === "blocked" ? <button className="ghost tiny" onClick={() => relate(t)}>补充任务</button> : <button className="ghost tiny" disabled={t.status === "stopping"} onClick={() => void act(() => api.stopTask(t.id))}>停止该任务</button>}<button className="ghost tiny" onClick={() => relate(t)}>补充此任务</button></div>
        </div>}
      </div>)}
    </div>
    {error && <div className="banner error" role="alert">{error}<button onClick={() => setError(null)}>关闭</button></div>}
    <div className="composer">
      {related && <div className="chip">关联：{related.title}<button onClick={() => setRelated(null)} aria-label="取消关联">×</button></div>}
      {!!attachments.length && <div className="chips">{attachments.map(a => <span className="chip" key={a.path}>{a.name}<button aria-label="移除附件" disabled={busy} onClick={() => setAttachments(old => old.filter(x => x.path !== a.path))}>×</button></span>)}</div>}
      <textarea ref={input} rows={2} value={draft} aria-label="消息" placeholder="交给我一个任务，也可以继续发其他事情…" disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
    } }}/>
      <div className="composer-row"><label className={`file-button ${busy || uploading ? "disabled" : ""}`}>{uploading ? "上传中…" : "附件"}<input type="file" multiple className="file-input" aria-label="添加附件" data-testid="attachment-input" disabled={busy || uploading} onChange={e => { void pick(e.target.files); e.target.value = ""; }}/></label><span className="spacer"/><button className="primary" disabled={busy || uploading || (!draft.trim() && !attachments.length)} onClick={() => void send()}>{busy ? "提交中…" : "发送"}</button></div>
    </div>
    {preview && <FilePreview path={preview} onClose={() => setPreview(null)}/>}
  </section>;
}
