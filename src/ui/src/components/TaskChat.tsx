import { ComposerIcon, useComposerHeight } from "./ComposerControls";
import { PopupPresence } from "./PopupMotion";
import { MessageTime, TaskDuration, useDisplayClock } from "./MessageTime";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, openEventStream } from "../api";
import type { Attachment, Task } from "../types";
import { AttachmentCards, MessageFileCards } from "./Chat";
import { DispatchLog } from "./DispatchLog";
import { Markdown } from "./Markdown";
import { ChoiceList } from "./ChoiceList";
import { FilePreview } from "./FilePreview";
import { TaskBrowser } from "./TaskBrowser";
import { MessagePreview } from "./MessagePreview";
import { ComposerAttachments, useUploadTray } from "./ComposerAttachments";
import { TurnPills } from "./TurnPills";
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
/** What a task waiting for the person wants, in a word or two. */
function waitingLabel(t: Task): string {
    if (t.approvals) return "等你确认";
    if (t.browser?.request) return "等你操作浏览器";
    return t.status === "blocked" ? "需要补充" : "等你补充";
}
const labels: Record<string, string> = { planning: "正在分配", needs_input: "等待你补充", planning_failed: "分配失败", waiting: "等待依赖或资源", queued: "排队中", running: "在办", stopping: "正在停止…", completed: "已完成", failed: "执行失败", interrupted: "已停止", unknown: "结果待核对", blocked: "需要补充" };
export function TaskChat({ onDetails, onOpenLink, onOpenFileInBrowser, onExpired, onFeed, onRevealBrowser, debug = false }: {
    /** Owner debug mode: each message offers its dispatch log. */
    debug?: boolean;
    onDetails: (task: Task) => void;
    /** Open the workspace on the browser, where a taken-over task tab is in front. */
    onRevealBrowser: () => void;
    onOpenLink: (url: string) => void;
    /** Open a workspace HTML page in full in the sandbox browser. */
    onOpenFileInBrowser?: (path: string) => void;
    onExpired: () => void;
    onFeed?: (feed:TaskFeed)=>void;
}) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [dispatchLogFor, setDispatchLogFor] = useState<string | null>(null);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [reference, setReference] = useState<{ id: string; title: string } | null>(null);
    /** Answers tapped, by the task (and its revision) they answer. */
    const [choosing, setChoosing] = useState<Record<string, string>>({});
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const tray = useUploadTray();
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);
    useEffect(()=>{onFeed?.({tasks,nextBefore,connected});},[tasks,nextBefore,connected,onFeed]);
    const scroll = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const input = useRef<HTMLTextAreaElement>(null);
    useComposerHeight(input, draft);
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
    /** The feed version on screen: an unchanged feed is not downloaded again. */
    const version = useRef<string | null>(null);
    const refresh = useCallback(async () => {
        try {
            const data = await api.mainSince(version.current);
            setConnected(true);
            if (data.unchanged) return;
            version.current = data.version;
            merge(data.tasks);
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
    // A phone keyboard, or the composer growing on focus, resizes the feed without scrolling it: keep the
    // latest message in view, or, while older ones are being read, the bottom edge of what was on screen.
    const edge = useRef(0);
    const height = useRef(0);
    // Another view hides the feed (zero height, scroll reset): keep where it was, and put it back on return.
    const hidden = useRef(false);
    const refit = (n: HTMLDivElement) => {
        if (!n.clientHeight) { hidden.current = true; return; }
        if (n.clientHeight === height.current && !hidden.current) return;
        hidden.current = false;
        height.current = n.clientHeight;
        n.scrollTop = stick.current ? n.scrollHeight : edge.current - n.clientHeight;
        edge.current = n.scrollTop + n.clientHeight;
    };
    // More than a screen above the latest message: offer the way back.
    const [away, setAway] = useState(false);
    const onFeedScroll = (n: HTMLDivElement) => {
        // WebKit fires the resize's own scroll event before the observer runs: settle the resize first.
        if (!n.clientHeight) return;
        if (height.current || hidden.current) refit(n);
        stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 80;
        edge.current = n.scrollTop + n.clientHeight;
        setAway(n.scrollHeight - n.scrollTop - n.clientHeight > n.clientHeight);
    };
    const toLatest = () => {
        const n = scroll.current;
        if (!n) return;
        stick.current = true;
        n.scrollTo({ top: n.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    useEffect(() => {
        const n = scroll.current;
        if (!n || typeof ResizeObserver !== "function") return;
        height.current = n.clientHeight;
        edge.current = n.scrollTop + n.clientHeight;
        const observer = new ResizeObserver(() => refit(n));
        observer.observe(n);
        return () => observer.disconnect();
    }, []);
    // Older tasks load on their own as the top of the feed comes near, and what was on screen stays put.
    const olderTop = useRef<HTMLDivElement>(null);
    const loadingOlder = useRef(false);
    const [olderState, setOlderState] = useState<"idle" | "loading" | "failed">("idle");
    const anchor = useRef<{ el: Element; top: number } | null>(null);
    const loadOlder = useCallback(async () => {
        if (!nextBefore || loadingOlder.current) return;
        loadingOlder.current = true;
        setOlderState("loading");
        try {
            const d = await api.main(nextBefore);
            const first = scroll.current?.querySelector("[data-task-id]");
            anchor.current = first ? { el: first, top: first.getBoundingClientRect().top } : null;
            stick.current = false;
            merge(d.tasks);
            setNextBefore(d.nextBefore);
            setOlderState("idle");
        }
        catch (err) {
            setOlderState("failed");
            if ((err as { status?: number }).status === 401) callbacks.current.onExpired();
        }
        finally {
            loadingOlder.current = false;
        }
    }, [nextBefore, merge]);
    useLayoutEffect(() => {
        const n = scroll.current, a = anchor.current;
        if (!n || !a) return;
        anchor.current = null;
        n.scrollTop += a.el.getBoundingClientRect().top - a.top;
    }, [tasks]);
    useEffect(() => {
        const n = scroll.current, top = olderTop.current;
        if (!n || !top || !nextBefore || typeof IntersectionObserver !== "function") return;
        const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) void loadOlder(); }, { root: n, rootMargin: "300px 0px 0px 0px" });
        observer.observe(top);
        return () => observer.disconnect();
    }, [nextBefore, loadOlder]);
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
            tray.clear();
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
    /**
     * A tapped answer: sent as the reply to that task, without touching the draft.
     * The same tap (same task revision and answer) is never sent twice.
     */
    const choose = async (t: Task, option: string) => {
        // Keyed by revision: once the task moves on (or asks again), its old tap no longer counts.
        const key = `${t.id}:${t.revision}`;
        if (choosing[key]) return;
        setChoosing(old => ({ ...old, [key]: option }));
        setError(null);
        try {
            const { task } = await api.submitTask({ text: option, attachments: [], relatedTaskId: t.id, clientMessageId: `choice:${key}:${option}` });
            stick.current = true;
            merge([task]);
            void refresh();
        }
        catch (err) {
            setChoosing(old => { const next = { ...old }; delete next[key]; return next; });
            setError(`${err instanceof Error ? err.message : String(err)}（可以再点一次）`);
        }
    };
    /** The reply a finished task got after it asked, if any: its answers are then closed. */
    const replyTo = (t: Task) => tasks.find(x => x.id !== t.id && (x.relatedTaskId === t.id || x.mergedInto === t.id) && x.createdAt >= (t.completedAt ?? t.createdAt));
    const pick = async (files: FileList | null) => {
        if (!files)
            return;
        setUploading(true);
        setError(null);
        const errors: string[] = [];
        for (const item of tray.begin([...files].slice(0, Math.max(0, 6 - attachments.length)))) {
            try {
                const a = await api.upload(item.file);
                setAttachments(old => [...old, a]);
                tray.settle(item, a);
            }
            catch (err) {
                tray.settle(item, null);
                errors.push(`${item.name}：${err instanceof Error ? err.message : "上传失败"}`);
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
    // Tasks waiting for the person whose card is not on screen: a bubble above the composer leads to each.
    const needsYou = tasks.filter(t => !t.mergedInto && !terminal.has(t.status) && turnOf(t) === "you");
    const needsKey = needsYou.map(t => t.id).join(",");
    const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set());
    useEffect(() => {
        const root = scroll.current;
        if (!root || !needsKey || typeof IntersectionObserver !== "function") { setOnScreen(new Set()); return; }
        const observer = new IntersectionObserver(entries => setOnScreen(old => {
            const next = new Set(old);
            for (const e of entries) {
                const id = (e.target as HTMLElement).dataset.progressFor!;
                // Most of the card, or (a card taller than the feed, such as one with a long draft) most of the feed.
                const seen = e.isIntersecting && (e.intersectionRatio >= 0.6 || (!!e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * 0.6));
                if (seen) next.add(id); else next.delete(id);
            }
            return next;
        }), { root, threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
        for (const id of needsKey.split(",")) {
            const card = root.querySelector(`[data-progress-for="${CSS.escape(id)}"]`);
            if (card) observer.observe(card);
        }
        return () => observer.disconnect();
    }, [needsKey, tasks.length]);
    const waiting = needsYou.filter(t => !onScreen.has(t.id));
    // The bubbles take room at the bottom of the feed: the latest message stays above them.
    const bubbles = waiting.length > 0;
    useEffect(() => { const n = scroll.current; if (n && stick.current) n.scrollTop = n.scrollHeight; }, [bubbles]);
    const showWaiting = (id: string) => {
        const card = scroll.current?.querySelector<HTMLElement>(`[data-progress-for="${CSS.escape(id)}"]`);
        if (!card) return;
        card.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        card.classList.remove("attention");
        void card.offsetWidth;
        card.classList.add("attention");
        window.setTimeout(() => card.classList.remove("attention"), 1800);
    };
    const renderProgress = (t: Task) => <div data-progress-for={t.id} className={`task-progress turn-${turnOf(t)} ${t.status === "running" || t.status === "planning" ? "active" : ""} ${t.status === "planning" ? "planning" : ""} ${t.status === "needs_input" ? "needs-input" : ""}`}>
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
          {/* What the executor wrote before its question (a draft to review, what it found so far): the question is about it. */}
          {t.status === "needs_input" && t.result && <div className="task-question-context"><MessagePreview title={t.title}><Markdown source={t.result} onOpenLink={onOpenLink} onOpenFile={setPreview}/><MessageFileCards text={t.result} onOpen={setPreview} onOpenLink={onOpenLink}/></MessagePreview></div>}
          {t.status === "needs_input" && t.clarification && <div className="task-question" role="status" aria-label="需要你补充">
            <div className="task-question-heading"><span aria-hidden="true">?</span><strong>需要你补充</strong></div>
            <p>{t.clarification}</p>
            {t.options?.length ? <ChoiceList options={t.options} chosen={choosing[`${t.id}:${t.revision}`] ?? null} onChoose={option => void choose(t, option)}/> : null}
            <span className="task-question-hint">{t.options?.length ? "点选一个，或直接在下方输入" : "直接在下方输入回复即可"}</span>
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
        ? <TurnPills onJump={showWaiting} groups={[
            { key: "input", tone: "you", label: `${awaiting.length} 件等你补充`, tasks: awaiting, state: waitingLabel },
            { key: "browser", tone: "you", label: `${browserAsks.length} 件等你操作浏览器`, tasks: browserAsks, state: waitingLabel },
            { key: "ai", tone: "ai", label: `${active.length - browserAsks.length} 件在办`, tasks: active.filter(t => !browserAsks.includes(t)), state: t => labels[t.status] ?? t.status },
          ]}/>
        : connected ? "随时可以交给我" : "正在连接…"}</span></div></header>
    <div className={`chat-scroll task-feed${bubbles ? " has-needs-you" : ""}`} ref={scroll} onScroll={e => onFeedScroll(e.currentTarget)}>
      {nextBefore && <div className="feed-older" ref={olderTop}>{olderState === "failed"
        ? <button className="ghost tiny" onClick={() => void loadOlder()}>更早的任务没加载出来，点此重试</button>
        : <span className="muted tiny">{olderState === "loading" ? "正在加载更早的任务…" : ""}</span>}</div>}
      {!tasks.length && <div className="empty"><h3>把事情交给我</h3><p>可以接着发不同任务。过程会收拢，完成后在这里回报。</p></div>}
      {feed.map(({ task: t, report }) => report ? <article className={`msg assistant task-report ${t.status}`} key={`${t.id}:report`} data-task-id={t.id}>
        <div className="task-report-heading"><span>{t.title}</span>{t.schedule && <span className="schedule-badge">定时 · {t.schedule.rule}</span>}<span className="muted tiny">{labels[t.status]}</span></div>
        <MessagePreview title={t.title}><Markdown source={t.result || (t.status === "completed" ? "任务已结束，但没有返回文字结果，请打开详情核对。" : t.error || labels[t.status] || t.status)} onOpenLink={onOpenLink} onOpenFile={setPreview} choices={{ onChoose: option => void choose(t, option), chosen: choosing[`${t.id}:${t.revision}`] ?? replyTo(t)?.text ?? null }}/>{t.result && <MessageFileCards text={t.result} onOpen={setPreview} onOpenLink={onOpenLink}/>}{t.error && t.result && <p className="error">{t.error}</p>}</MessagePreview>
        <TaskBrowser task={t} onReveal={onRevealBrowser}/>
        <div className="message-meta"><MessageTime at={t.completedAt} now={now}/><TaskDuration task={t} now={now}/></div>
        <div className="task-actions"><button className="ghost tiny" disabled={busy} onClick={() => quoteTask(t)} aria-label={`引用任务：${t.title}`}>引用任务</button><button className="ghost tiny" onClick={() => onDetails(t)}>查看过程</button></div>
      </article> : <div className="task-entry" key={t.id} data-task-id={t.id}>
        {t.schedule ? <div className="schedule-run-note" role="note">定时任务「{t.schedule.title}」自动运行 · {t.schedule.rule} · <MessageTime at={t.createdAt} now={now}/></div> : <article className="msg user"><MessagePreview title="用户消息" user>{t.relatedTaskId && <small className="muted">引用：{t.relatedTaskTitle ?? tasks.find(task => task.id === t.relatedTaskId)?.title ?? "此前任务"}</small>}<p>{t.text}</p>{t.attachments.length > 0 && <AttachmentCards attachments={t.attachments} onOpen={setPreview}/>}<div className="message-meta"><MessageTime at={t.createdAt} now={now}/></div></MessagePreview></article>}
        {t.mergedInto && <div className="task-supplement"><button className="ghost tiny" onClick={() => onDetails(t)}>{t.status === "merged" ? "已补充到" : t.status === "merging" || t.status === "steering" ? "正在补充到" : t.status === "interrupted" ? "已取消补充" : "补充需要核对"}：{t.mergedTitle}</button>{t.waitReason && <p className="tiny">{t.waitReason.message}</p>}{t.error && <p className="tiny error">{t.error}</p>}</div>}
        {debug && <div className="task-actions debug-actions"><button className="ghost tiny" onClick={() => setDispatchLogFor(t.id)} aria-label={`派单日志：${t.title}`}>派单日志</button></div>}
        {progressAt.get(t.id) && renderProgress(progressAt.get(t.id)!)}
      </div>)}
    </div>
    <div className="feed-latest-anchor">{waiting.length > 0 && <div className="needs-you" role="group" aria-label="等你处理的任务">{waiting.map(t => <button type="button" key={t.id} className="needs-you-bubble" onClick={() => showWaiting(t.id)} aria-label={`${waitingLabel(t)}：${t.title}，点击查看`}><span className="needs-you-dot" aria-hidden="true"/><span className="needs-you-kind">{waitingLabel(t)}</span><span className="needs-you-title">{t.title}</span></button>)}</div>}<button type="button" className={`feed-latest${away ? " show" : ""}`} aria-label="回到最新消息" title="回到最新消息" aria-hidden={!away} tabIndex={away ? 0 : -1} onClick={toLatest}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg></button></div>
    {error && <div className="banner error" role="alert">{error}<button onClick={() => setError(null)}>关闭</button></div>}
    <div className={`composer${draft || attachments.length || reference || uploading ? " has-content" : ""}`}>
      {reference && <div className="task-reference" role="status"><div><span className="muted tiny">引用任务</span><strong title={reference.title}>{reference.title}</strong></div><button type="button" className="ghost" disabled={busy} aria-label="取消引用任务" onClick={() => { setReference(null); input.current?.focus(); }}><ComposerIcon kind="close"/></button></div>}
      <ComposerAttachments items={attachments} pending={tray.pending} previews={tray.previews} disabled={busy} onRemove={path => { setAttachments(old => old.filter(x => x.path !== path)); tray.drop(path); }}/>
      <textarea ref={input} rows={2} value={draft} aria-label="消息" placeholder={reference ? "继续补充这个任务…" : "交给我一个任务…"} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
    } }}/>
      <div className="composer-row"><label className={`file-button ${busy || uploading ? "disabled" : ""}`}><ComposerIcon kind={uploading ? "busy" : "attach"}/><span className="composer-button-label">{uploading ? "上传中…" : "附件"}</span><input type="file" multiple className="file-input" aria-label="添加附件" data-testid="attachment-input" disabled={busy || uploading} onChange={e => { void pick(e.target.files); e.target.value = ""; }}/></label><span className="spacer"/><button className="primary" disabled={busy || uploading || (!draft.trim() && !attachments.length)} onClick={() => void send()} aria-label={busy ? "提交中…" : "发送"} title="发送"><ComposerIcon kind={busy ? "busy" : "send"}/><span className="composer-button-label">{busy ? "提交中…" : "发送"}</span></button></div>
    </div>
    <PopupPresence>{preview && <FilePreview path={preview} onClose={() => setPreview(null)} onOpenLink={onOpenLink} onOpenInBrowser={onOpenFileInBrowser}/>}</PopupPresence>
    <PopupPresence>{debug && dispatchLogFor && <DispatchLog taskId={dispatchLogFor} onClose={() => setDispatchLogFor(null)}/>}</PopupPresence>
  </section>;
}
