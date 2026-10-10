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
import { VaultPrompt } from "./VaultPrompt";
import { TaskPhone } from "./TaskPhone";
import { MessagePreview } from "./MessagePreview";
import { ComposerAttachments, releasePreviews, useUploadTray, type PendingUpload } from "./ComposerAttachments";
import { TurnPills } from "./TurnPills";
import { FormCard } from "./FormCard";
import { VoiceButton } from "./VoiceInput";
import type {TaskFeed} from '../taskStatus';
import { t as i18n } from "../i18n";
const terminal = new Set(["completed", "failed", "interrupted", "unknown"]);
/** What the dispatcher does with every message; shown in turn while it decides, not as live progress. */
const DISPATCH_HINTS = i18n.feed.dispatchHints;
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
    if (t.approvals) return i18n.feed.waiting.approvals;
    if (t.browser?.request) return i18n.feed.waiting.browser;
    return t.status === "blocked" ? i18n.feed.waiting.blocked : i18n.feed.waiting.input;
}
const labels: Record<string, string> = i18n.feed.status;
/** A message shown the moment it is sent, until the server's task takes its place. */
interface Outgoing {
    id: string;
    text: string;
    reference: { id: string; title: string } | null;
    attachments: Attachment[];
    /** Files still uploading when it was sent; their previews show meanwhile. */
    uploads: PendingUpload[];
    state: "sending" | "failed";
    error?: string;
}
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
    const tray = useUploadTray();
    const uploading = tray.pending.length > 0;
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);
    /** "loading" until the feed first arrives (skeletons instead of the empty state), then "entering" while it rises in. */
    const [arrival, setArrival] = useState<"loading" | "entering" | "settled">("loading");
    useEffect(()=>{onFeed?.({tasks,nextBefore,connected});},[tasks,nextBefore,connected,onFeed]);
    const scroll = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const input = useRef<HTMLTextAreaElement>(null);
    useComposerHeight(input, draft);
    const pageLoaded = useRef(false);
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
                setArrival("entering");
                window.setTimeout(() => setArrival("settled"), 900);
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
    /**
     * Sent messages show at once, before the server has them: each waits for its own uploads
     * (attachments still uploading go with it), then is submitted in the order it was sent.
     * Its id is the idempotency key, so a retry never makes a second task. The task that
     * arrives takes its place without rising in again.
     */
    const [outbox, setOutbox] = useState<Outgoing[]>([]);
    const outboxNow = useRef<Outgoing[]>([]);
    const setOutboxNow = (next: (old: Outgoing[]) => Outgoing[]) => { outboxNow.current = next(outboxNow.current); setOutbox(outboxNow.current); };
    const sending = useRef<Promise<unknown>>(Promise.resolve());
    const adopted = useRef(new Set<string>());
    /** Uploads by tray item: a message sent before they finish waits for them. */
    const uploads = useRef(new Map<string, Promise<Attachment | null>>());
    const handed = useRef(new Set<string>());
    useEffect(() => () => { for (const o of outboxNow.current) releasePreviews(o.uploads); }, []);
    const deliver = async (id: string) => {
        const o = outboxNow.current.find(x => x.id === id);
        if (!o) return;
        const results = await Promise.all(o.uploads.map(u => (uploads.current.get(u.id) ?? Promise.resolve(null))
            .then(a => a ?? api.upload(u.file).then(r => { uploads.current.set(u.id, Promise.resolve(r)); return r; }, () => null))));
        const failed = o.uploads.filter((_, i) => !results[i]);
        if (failed.length) {
            setOutboxNow(old => old.map(x => x.id === id ? { ...x, state: "failed", error: i18n.feed.errors.notUploaded(failed.map(f => f.name).join(i18n.chat.listSeparator)) } : x));
            return;
        }
        try {
            const { task } = await api.submitTask({ text: o.text, attachments: [...o.attachments, ...results as Attachment[]], relatedTaskId: o.reference?.id ?? null, clientMessageId: id });
            adopted.current.add(task.id);
            stick.current = true;
            merge([task]);
            setOutboxNow(old => old.filter(x => x.id !== id));
            releasePreviews(o.uploads);
            for (const u of o.uploads) uploads.current.delete(u.id);
            void refresh();
        }
        catch (err) {
            if ((err as { status?: number }).status === 401) callbacks.current.onExpired();
            setOutboxNow(old => old.map(x => x.id === id ? { ...x, state: "failed", error: err instanceof Error ? err.message : String(err) } : x));
        }
    };
    const queue = (id: string) => { sending.current = sending.current.then(() => deliver(id)); };
    // A message just sent is the latest one: keep it in view.
    useEffect(() => { if (scroll.current && stick.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [outbox]);
    // The poll can bring a sent message's task before its own answer does: it takes the place just the same.
    for (const t of tasks) if (t.clientMessageId && outbox.some(o => o.id === t.clientMessageId)) adopted.current.add(t.id);
    const send = () => {
        const text = draft.trim();
        if (!text && !attachments.length && !tray.pending.length) return;
        const taken = tray.handOff();
        for (const u of taken) handed.current.add(u.id);
        const message: Outgoing = { id: crypto.randomUUID(), text, reference, attachments, uploads: taken, state: "sending" };
        setOutboxNow(old => [...old, message]);
        setDraft("");
        setReference(null);
        setAttachments([]);
        tray.clear();
        setError(null);
        stick.current = true;
        queue(message.id);
        // A computer keeps typing; a phone puts its keyboard away, as before (an open composer that
        // collapses on the next tap would move the feed under the finger).
        if (matchMedia("(pointer: fine)").matches) input.current?.focus();
    };
    const retry = (id: string) => {
        setOutboxNow(old => old.map(x => x.id === id ? { ...x, state: "sending", error: undefined } : x));
        queue(id);
    };
    /** Back into the composer to change it: its text, reference and what was uploaded. */
    const edit = (id: string) => {
        const o = outboxNow.current.find(x => x.id === id);
        if (!o) return;
        setOutboxNow(old => old.filter(x => x.id !== id));
        void Promise.all(o.uploads.map(u => uploads.current.get(u.id) ?? Promise.resolve(null))).then(done => {
            setAttachments(old => [...old, ...o.attachments, ...done.filter((a): a is Attachment => !!a)]);
            releasePreviews(o.uploads);
        });
        setDraft(old => (old ? `${o.text}\n${old}` : o.text));
        if (o.reference) setReference(o.reference);
        input.current?.focus();
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
            setError(i18n.feed.errors.retry(err instanceof Error ? err.message : String(err)));
        }
    };
    /** The reply a finished task got after it asked, if any: its answers are then closed. */
    const replyTo = (t: Task) => tasks.find(x => x.id !== t.id && (x.relatedTaskId === t.id || x.mergedInto === t.id) && x.createdAt >= (t.completedAt ?? t.createdAt));
    /** Uploads one after another; a file still uploading when its message is sent goes with that message. */
    const uploadChain = useRef<Promise<unknown>>(Promise.resolve());
    const pick = (files: FileList | null) => {
        if (!files)
            return;
        setError(null);
        for (const item of tray.begin([...files].slice(0, Math.max(0, 6 - attachments.length - tray.pending.length)))) {
            // One left in the composer is an ordinary attachment from here on; only one a message took is waited for.
            const done = uploadChain.current.then(() => api.upload(item.file)).then(a => {
                if (!handed.current.has(item.id)) { setAttachments(old => [...old, a]); uploads.current.delete(item.id); }
                tray.settle(item, a);
                return a as Attachment | null;
            }, err => {
                tray.settle(item, null);
                if (!handed.current.has(item.id)) { setError(i18n.feed.errors.upload(item.name, err instanceof Error ? err.message : i18n.feed.errors.uploadFailed)); uploads.current.delete(item.id); }
                return null;
            });
            uploadChain.current = done;
            uploads.current.set(item.id, done);
        }
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
    // Tasks that continue one execution session share its browser: only the latest of them shows it.
    const browserShownBy = new Map<string, string>();
    for (const t of tasks) {
        if (t.mergedInto) continue;
        const shown = tasks.find(x => x.id === browserShownBy.get(t.conversationId));
        if (!shown || t.createdAt >= shown.createdAt) browserShownBy.set(t.conversationId, t.id);
    }
    const ownsBrowser = (t: Task) => browserShownBy.get(t.conversationId) === t.id;
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
              : <span className={`dot ${t.approvals || t.browser?.request ? "warn" : ""}`}/>}<span className="task-progress-label" key={t.status}>{t.approvals ? i18n.feed.progress.needsConfirm : t.browser?.request && t.status === "running" ? i18n.feed.progress.needsBrowser : t.waitReason?.label ?? labels[t.status] ?? t.status}</span><span className="task-progress-title">{t.title}</span></>;
            // Still being dispatched (or dispatch failed): nothing has run yet, so there are no details to open.
            return t.status === "planning" || t.status === "planning_failed"
              ? <div className="task-summary">{summary}</div>
              : <button className="task-summary" onClick={() => onDetails(t)} aria-label={i18n.feed.progress.expand(t.title)}>{summary}<span aria-hidden>›</span></button>;
          })()}
          {t.status === "planning" && <DispatchHint/>}
          {t.waitReason && <p className="task-intro task-wait-reason">{t.waitReason.message}</p>}
          {/* What the executor wrote before its question (a draft to review, what it found so far): the question is about it. */}
          {t.status === "needs_input" && t.result && <div className="task-question-context"><MessagePreview title={t.title}><Markdown source={t.result} onOpenLink={onOpenLink} onOpenFile={setPreview}/><MessageFileCards text={t.result} onOpen={setPreview} onOpenLink={onOpenLink}/></MessagePreview></div>}
          {t.status === "needs_input" && t.clarification && <div className="task-question" role="status" aria-label={i18n.feed.question.label}>
            <div className="task-question-heading"><span aria-hidden="true">?</span><strong>{i18n.feed.question.label}</strong></div>
            <p>{t.clarification}</p>
            {t.form ? <FormCard spec={t.form} embedded sent={choosing[`${t.id}:${t.revision}`] ?? null} onSubmit={text => void choose(t, text)}/>
              : t.options?.length ? <ChoiceList options={t.options} chosen={choosing[`${t.id}:${t.revision}`] ?? null} onChoose={option => void choose(t, option)}/> : null}
            <span className="task-question-hint">{t.form ? i18n.feed.question.hintForm : t.options?.length ? i18n.feed.question.hintOptions : i18n.feed.question.hintText}</span>
          </div>}
          {!!t.messages?.length && ["running", "stopping"].includes(t.status) && <div className="task-intro task-messages">{t.messages.map((m, i) => <Markdown key={i} source={m} onOpenLink={onOpenLink} onOpenFile={setPreview}/>)}</div>}
          {ownsBrowser(t) && <><VaultPrompt task={t}/><TaskBrowser task={t} onReveal={onRevealBrowser}/></>}
          {t.phone && !t.mergedInto && ["needs_input", "queued", "running", "stopping"].includes(t.status) && <TaskPhone task={t} onDone={() => void choose(t, i18n.feed.phoneDone)}/>}
          <TaskDuration task={t} now={now}/>
          {t.error && <p className="tiny">{t.error}</p>}
          <div className="task-actions"><button className="ghost tiny" onClick={() => quoteTask(t)} aria-label={i18n.feed.actions.quoteLabel(t.title)}>{i18n.feed.actions.quote}</button>{t.status === "planning_failed" ? <button className="ghost tiny" onClick={() => void act(() => api.retryTaskPlanning(t.id))}>{i18n.feed.actions.retryPlanning}</button> : t.status === "blocked" ? null : <button className="ghost tiny" disabled={t.status === "stopping"} onClick={() => void act(() => api.stopTask(t.id))}>{i18n.feed.actions.stop}</button>}</div>
        </div>;
    const feed = tasks.flatMap(t => [{ task: t, report: false, at: t.createdAt }, ...(!t.mergedInto && terminal.has(t.status) ? [{ task: t, report: true, at: t.completedAt ?? t.createdAt }] : [])])
        .sort((a, b) => a.at - b.at || Number(a.report) - Number(b.report) || a.task.id.localeCompare(b.task.id));
    return <section className="chat task-chat">
    <header className="chat-head"><div className="chat-title"><h2>{i18n.feed.head.title}</h2><span className={`dot ${connected ? "ok" : "warn"}`}/><span className="chat-sub">{active.length || awaiting.length
        ? <TurnPills onJump={showWaiting} groups={[
            { key: "input", tone: "you", label: i18n.feed.head.awaitingInput(awaiting.length), tasks: awaiting, state: waitingLabel },
            { key: "browser", tone: "you", label: i18n.feed.head.awaitingBrowser(browserAsks.length), tasks: browserAsks, state: waitingLabel },
            { key: "ai", tone: "ai", label: i18n.feed.head.active(active.length - browserAsks.length), tasks: active.filter(t => !browserAsks.includes(t)), state: t => labels[t.status] ?? t.status },
          ]}/>
        : connected ? i18n.feed.head.idle : i18n.feed.head.connecting}</span></div></header>
    <div className={`chat-scroll task-feed${bubbles ? " has-needs-you" : ""}${arrival === "entering" ? " entering" : ""}`} ref={scroll} onScroll={e => onFeedScroll(e.currentTarget)} aria-busy={arrival === "loading" || undefined}>
      {arrival === "loading" && <div className="feed-skeleton" aria-hidden="true"><i className="sk-user"/><i className="sk-reply"><b/><b/><b/></i><i className="sk-user short"/><i className="sk-reply"><b/><b/></i></div>}
      {nextBefore && <div className="feed-older" ref={olderTop}>{olderState === "failed"
        ? <button className="ghost tiny" onClick={() => void loadOlder()}>{i18n.feed.older.retry}</button>
        : <span className="muted tiny">{olderState === "loading" ? i18n.feed.older.loading : ""}</span>}</div>}
      {!tasks.length && !outbox.length && arrival !== "loading" && <div className="empty"><h3>{i18n.feed.empty.title}</h3><p>{i18n.feed.empty.body}</p></div>}
      {feed.map(({ task: t, report }) => report ? <article className={`msg assistant task-report ${t.status}`} key={`${t.id}:report`} data-task-id={t.id}>
        <div className="task-report-heading"><span>{t.title}</span>{t.schedule && <span className="schedule-badge">{i18n.feed.report.schedule(t.schedule.rule)}</span>}<span className="muted tiny">{labels[t.status]}</span></div>
        <MessagePreview title={t.title}><Markdown source={t.result || (t.status === "completed" ? i18n.feed.report.noResult : t.error || labels[t.status] || t.status)} onOpenLink={onOpenLink} onOpenFile={setPreview} choices={{ onChoose: option => void choose(t, option), chosen: choosing[`${t.id}:${t.revision}`] ?? replyTo(t)?.text ?? null }}/>{t.result && <MessageFileCards text={t.result} onOpen={setPreview} onOpenLink={onOpenLink}/>}{t.error && t.result && <p className="error">{t.error}</p>}</MessagePreview>
        {ownsBrowser(t) && <><VaultPrompt task={t}/><TaskBrowser task={t} onReveal={onRevealBrowser}/></>}
        <div className="message-meta"><MessageTime at={t.completedAt} now={now}/><TaskDuration task={t} now={now}/></div>
        <div className="task-actions"><button className="ghost tiny" onClick={() => quoteTask(t)} aria-label={i18n.feed.actions.quoteLabel(t.title)}>{i18n.feed.actions.quote}</button><button className="ghost tiny" onClick={() => onDetails(t)}>{i18n.feed.actions.details}</button></div>
      </article> : <div className={`task-entry${adopted.current.has(t.id) ? " adopted" : ""}`} key={t.id} data-task-id={t.id}>
        {t.schedule ? <div className="schedule-run-note" role="note">{i18n.feed.scheduleRun(t.schedule.title, t.schedule.rule)}<MessageTime at={t.createdAt} now={now}/></div> : <article className="msg user"><MessagePreview title={i18n.feed.userMessage} user>{t.relatedTaskId && <small className="muted">{i18n.feed.quoted(t.relatedTaskTitle ?? tasks.find(task => task.id === t.relatedTaskId)?.title ?? i18n.feed.earlierTask)}</small>}<p>{t.text}</p>{t.attachments.length > 0 && <AttachmentCards attachments={t.attachments} onOpen={setPreview}/>}<div className="message-meta"><MessageTime at={t.createdAt} now={now}/></div></MessagePreview></article>}
        {t.mergedInto && <div className="task-supplement"><button className="ghost tiny" onClick={() => onDetails(t)}>{(t.status === "merged" ? i18n.feed.supplement.merged : t.status === "merging" || t.status === "steering" ? i18n.feed.supplement.merging : t.status === "interrupted" ? i18n.feed.supplement.cancelled : i18n.feed.supplement.check)(t.mergedTitle ?? "")}</button>{t.waitReason && <p className="tiny">{t.waitReason.message}</p>}{t.error && <p className="tiny error">{t.error}</p>}</div>}
        {debug && <div className="task-actions debug-actions"><button className="ghost tiny" onClick={() => setDispatchLogFor(t.id)} aria-label={i18n.feed.actions.dispatchLogLabel(t.title)}>{i18n.feed.actions.dispatchLog}</button></div>}
        {progressAt.get(t.id) && renderProgress(progressAt.get(t.id)!)}
      </div>)}
      {outbox.filter(o => !tasks.some(t => t.clientMessageId === o.id)).map(o => <div className="task-entry outgoing" key={o.id} data-outgoing={o.state}>
        <article className="msg user"><MessagePreview title={i18n.feed.userMessage} user>
          {o.reference && <small className="muted">{i18n.feed.quoted(o.reference.title)}</small>}
          {o.text && <p>{o.text}</p>}
          {o.attachments.length > 0 && <AttachmentCards attachments={o.attachments} onOpen={setPreview}/>}
          {o.uploads.length > 0 && <div className="outgoing-uploads" aria-label={i18n.feed.outgoing.uploading}>{o.uploads.map(u => u.preview
            ? <span className="outgoing-upload image" key={u.id}><img src={u.preview} alt=""/>{o.state === "sending" && <span className="tray-spinner" aria-hidden="true"/>}</span>
            : <span className="outgoing-upload file" key={u.id}>{u.name}{o.state === "sending" && <span className="tray-spinner" aria-hidden="true"/>}</span>)}</div>}
          <div className="message-meta">{o.state === "sending" ? <span className="outgoing-state">{i18n.feed.outgoing.sending}</span> : <span className="outgoing-state failed">{i18n.feed.outgoing.unsent}</span>}</div>
        </MessagePreview></article>
        {o.state === "failed"
          ? <div className="outgoing-failed" role="alert"><span>{o.error ?? i18n.feed.outgoing.failed}</span><button type="button" className="ghost tiny" onClick={() => retry(o.id)}>{i18n.feed.outgoing.retry}</button><button type="button" className="ghost tiny" onClick={() => edit(o.id)}>{i18n.feed.outgoing.edit}</button></div>
          : <div className="task-progress turn-ai active planning"><div className="task-summary"><span className="dispatch-glyph" aria-hidden="true"><i/><i/><i/></span><span className="task-progress-label">{labels.planning}</span></div><DispatchHint/></div>}
      </div>)}
    </div>
    <div className="feed-latest-anchor">{waiting.length > 0 && <div className="needs-you" role="group" aria-label={i18n.feed.needsYou.label}>{waiting.map(t => <button type="button" key={t.id} className="needs-you-bubble" onClick={() => showWaiting(t.id)} aria-label={i18n.feed.needsYou.bubble(waitingLabel(t), t.title)}><span className="needs-you-dot" aria-hidden="true"/><span className="needs-you-kind">{waitingLabel(t)}</span><span className="needs-you-title">{t.title}</span></button>)}</div>}<button type="button" className={`feed-latest${away ? " show" : ""}`} aria-label={i18n.feed.toLatest} title={i18n.feed.toLatest} aria-hidden={!away} tabIndex={away ? 0 : -1} onClick={toLatest}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg></button></div>
    {error && <div className="banner error" role="alert">{error}<button onClick={() => setError(null)}>{i18n.chat.close}</button></div>}
    <div className={`composer${draft || attachments.length || reference || uploading ? " has-content" : ""}`}>
      {reference && <div className="task-reference" role="status"><div><span className="muted tiny">{i18n.feed.reference.label}</span><strong title={reference.title}>{reference.title}</strong></div><button type="button" className="ghost" aria-label={i18n.feed.reference.cancel} onClick={() => { setReference(null); input.current?.focus(); }}><ComposerIcon kind="close"/></button></div>}
      <ComposerAttachments items={attachments} pending={tray.pending} previews={tray.previews} onRemove={path => { setAttachments(old => old.filter(x => x.path !== path)); tray.drop(path); }}/>
      <textarea ref={input} rows={2} value={draft} aria-label={i18n.chat.composer.message} placeholder={reference ? i18n.feed.composer.placeholderReference : i18n.feed.composer.placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
    } }}/>
      <div className="composer-row"><label className="file-button"><ComposerIcon kind={uploading ? "busy" : "attach"}/><span className="composer-button-label">{uploading ? i18n.chat.composer.uploading : i18n.chat.composer.attach}</span><input type="file" multiple className="file-input" aria-label={i18n.chat.composer.addAttachment} data-testid="attachment-input" onChange={e => { pick(e.target.files); e.target.value = ""; }}/></label><VoiceButton disabled={false} onError={setError} onText={heard => { setDraft(old => old + (/[A-Za-z0-9]$/.test(old) && /^[A-Za-z0-9]/.test(heard) ? " " : "") + heard); input.current?.focus(); }}/><span className="spacer"/><button className="primary" disabled={!draft.trim() && !attachments.length && !uploading} onClick={send} aria-label={i18n.chat.composer.send} title={i18n.chat.composer.send}><ComposerIcon kind="send"/><span className="composer-button-label">{i18n.chat.composer.send}</span></button></div>
    </div>
    <PopupPresence>{preview && <FilePreview path={preview} onClose={() => setPreview(null)} onOpenLink={onOpenLink} onOpenInBrowser={onOpenFileInBrowser}/>}</PopupPresence>
    <PopupPresence>{debug && dispatchLogFor && <DispatchLog taskId={dispatchLogFor} onClose={() => setDispatchLogFor(null)}/>}</PopupPresence>
  </section>;
}
