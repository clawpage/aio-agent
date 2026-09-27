import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, openEventStream } from "../api";
import type { AgentEvent, Attachment, Conversation, StatusResponse } from "../types";
import {
  applyEvent,
  childInProgress,
  cloneTimeline,
  emptyTimeline,
  removeBlock,
  segmentIsActive,
  segmentLabel,
  segmentStatusTone,
  type Block,
  type TimelineState,
  type WorkingBlock,
} from "../timeline";
import { itemOpensSandboxBrowser } from "../browserCommand";
import { Markdown } from "./Markdown";
import { FilePreview } from "./FilePreview";
import { FileCard } from "./FileCard";
import { extractFileRefs, attachmentRefs } from "../fileRefs";
import { isPreviewableKind, workspaceFileKind } from "../sandboxLink";

interface Props {
  conversation: Conversation;
  status: StatusResponse | null;
  onConversationChanged: () => void;
  onStatusChanged: () => void;
  onOpenWorkspace: (path?: string) => void;
  /** Open a Markdown link as a real tab in the sandbox browser. */
  onOpenBrowserLink: (url: string) => void;
  /** The agent itself navigated the sandbox browser; reveal that view. */
  onAgentBrowserNavigate: () => void;
}

const APPROVAL_LABELS: Record<string, string> = {
  "item/commandExecution/requestApproval": "请求执行命令",
  "item/fileChange/requestApproval": "请求修改文件",
  "item/permissions/requestApproval": "请求额外权限",
  "item/tool/requestUserInput": "需要你补充信息",
  "mcpServer/elicitation/request": "MCP 需要你的输入",
  applyPatchApproval: "请求应用补丁",
  execCommandApproval: "请求执行命令",
};

function newMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `m${Date.now()}${Math.random().toString(36).slice(2)}`;
}

export function Chat({
  conversation,
  status,
  onConversationChanged,
  onStatusChanged,
  onOpenWorkspace,
  onOpenBrowserLink,
  onAgentBrowserNavigate,
}: Props) {
  const [timeline, setTimeline] = useState<TimelineState>(() => emptyTimeline());
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  /**
   * Which activity segments the user has opened, keyed by *segment id* (not turn
   * id): a turn can own several segments now, so each one expands independently
   * and an incremental SSE update can never reset a segment the user opened.
   * History starts collapsed and only an explicit click opens one.
   */
  const [openSegments, setOpenSegments] = useState<ReadonlySet<string>>(() => new Set());
  const lastIdRef = useRef(0);
  const pendingRef = useRef<{ clientMessageId: string; signature: string; snapshot: { text: string; attachments: Attachment[] } } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const stateRef = useRef<TimelineState>(timeline);
  stateRef.current = timeline;
  useEffect(() => {
    const input = draftRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);
  // Stream handlers must not re-run the effect (the SSE connection would drop).
  const onChangedRef = useRef(onConversationChanged);
  onChangedRef.current = onConversationChanged;
  const onStatusRef = useRef(onStatusChanged);
  onStatusRef.current = onStatusChanged;
  // Same rule as the other stream callbacks: keep the latest handler in a ref so
  // a new identity never re-runs the effect and reconnects the SSE stream.
  const onBrowserNavRef = useRef(onAgentBrowserNavigate);
  onBrowserNavRef.current = onAgentBrowserNavigate;

  // Load history, then stream. Reconnects resume from the last seen event id.
  useEffect(() => {
    let disposed = false;
    let close: (() => void) | null = null;
    let retry: number | null = null;
    // Replayed history must never move the workspace. Live events only start
    // after the stream reports `replay.complete`; every (re)connect resets this
    // so a reconnect's replay is treated like history too.
    let liveEvents = false;
    setTimeline(emptyTimeline());
    setConnected(false);
    lastIdRef.current = 0;

    const start = async () => {
      connect();
    };

    const connect = () => {
      liveEvents = false;
      close = openEventStream(conversation.id, lastIdRef.current, {
        onEvent: (event: AgentEvent) => {
          if (event.id <= lastIdRef.current) return;
          lastIdRef.current = event.id;
          // The agent itself navigated the sandbox browser: reveal that view, but
          // only on this open chat page and only if it is in the foreground, so a
          // background tab never steals focus.
          if (liveEvents && event.type === "item/started") {
            const item = (event.payload?.item ?? null) as Record<string, unknown> | null;
            if (itemOpensSandboxBrowser(item) && document.visibilityState === "visible" && document.hasFocus()) {
              onBrowserNavRef.current();
            }
          }
          setTimeline((prev) => {
            const next = cloneTimeline(prev);
            applyEvent(next, event);
            return next;
          });
          if (event.type === "turn.finished" || event.type === "turn.failed" || event.type === "turn.reconciled") {
            onChangedRef.current();
            onStatusRef.current();
          }
          // An automatic title lands as its own event; refresh the sidebar (and
          // this header) immediately instead of waiting for the next poll.
          if (event.type === "conversation.title_updated") onChangedRef.current();
        },
        onOpen: () => {
          setConnected(true);
          liveEvents = true;
        },
        onError: () => {
          setConnected(false);
          close?.();
          if (!disposed && retry === null) {
            retry = window.setTimeout(() => {
              retry = null;
              if (!disposed) connect();
            }, 2000);
          }
        },
        onRevoked: () => {
          setError("会话已失效，请重新登录");
          close?.();
        },
      });
    };

    void start();
    return () => {
      disposed = true;
      if (retry !== null) window.clearTimeout(retry);
      close?.();
    };
  }, [conversation.id]);

  // Keep the view pinned to the newest content unless the user scrolled up.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [timeline]);

  const activeTurns = status?.agent.activeTurns ?? [];
  const capacity = status?.agent.capacity ?? 1;
  const activeHere = activeTurns.length
    ? activeTurns.some((t) => t.conversationId === conversation.id)
    : status?.agent.activeConversationId === conversation.id;
  const running = activeHere || conversation.status === "running";
  const atCapacity = activeTurns.length >= capacity;
  // This conversation has nothing running, but sending now would wait: the
  // sandbox is at capacity, or a stale "running" flag has not cleared yet.
  const willQueue = !activeHere && (atCapacity || conversation.status === "running");

  const send = useCallback(async () => {
    if (busy) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setBusy(true);
    setError(null);
    // Reuse the pending id when retrying the exact same payload so a failed
    // request can never start two runs for one message.
    const signature = `${text}\u0000${attachments.map((a) => a.path).join(",")}`;
    const clientMessageId =
      pendingRef.current && pendingRef.current.signature === signature ? pendingRef.current.clientMessageId : newMessageId();
    pendingRef.current = { clientMessageId, signature, snapshot: { text, attachments } };
    try {
      // Optimistic echo so the message appears instantly.
      const optimistic: AgentEvent = {
        id: -1,
        type: "local.pending",
        turnId: null,
        createdAt: Date.now(),
        payload: { clientMessageId, text, attachments },
      };
      setTimeline((prev) => {
        const next = cloneTimeline(prev);
        applyEvent(next, optimistic);
        return next;
      });
      stickRef.current = true;
      await api.submitTurn(conversation.id, {
        text,
        clientMessageId,
        attachments,
      });
      // Only clear the composer once the server has accepted the turn.
      setDraft("");
      setAttachments([]);
      pendingRef.current = null;
      onChangedRef.current();
      onStatusRef.current();
    } catch (err) {
      // Roll the optimistic bubble back and keep the draft + identical id so the
      // user can retry safely (no duplicate execution).
      setTimeline((prev) => removeBlock(prev, `user:pending:${clientMessageId}`));
      setDraft(text);
      setAttachments(attachments);
      setError(`${err instanceof Error ? err.message : String(err)}（内容已保留，可直接重试）`);
    } finally {
      setBusy(false);
    }
  }, [attachments, busy, conversation.id, draft]);

  const stop = useCallback(async () => {
    try {
      const result = await api.interrupt(conversation.id);
      if (!result.ok) setError(result.message);
      onStatusRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversation.id]);

  const respond = useCallback(async (requestId: string, decision: string, extra?: unknown) => {
    try {
      await api.respond(requestId, decision, extra);
      onStatusRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const openSandboxFile = useCallback((path: string) => {
    // Everything the console can render opens in the unified preview; only a
    // format nothing can preview falls back to a straight download.
    if (isPreviewableKind(workspaceFileKind(path)) || workspaceFileKind(path) === "text") {
      setPreviewPath(path);
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = api.downloadUrl(path);
    anchor.download = path.slice(path.lastIndexOf("/") + 1) || "download";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files).slice(0, 6);
    setUploading(true);
    setError(null);
    // Upload one by one and keep every success even if a later file fails, so a
    // partial failure never discards attachments that already made it.
    const uploaded: Attachment[] = [];
    const failures: string[] = [];
    for (const file of picked) {
      try {
        uploaded.push(await api.upload(file));
      } catch (err) {
        failures.push(`${file.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (uploaded.length) {
      setAttachments((prev) => [...prev, ...uploaded]);
      pendingRef.current = null;
    }
    if (failures.length) {
      setError(`部分附件上传失败：${failures.join("；")}${uploaded.length ? "（已上传的附件已保留）" : ""}`);
    }
    setUploading(false);
  }, []);

  const blocks = timeline.blocks;
  const pendingApprovals = useMemo(() => blocks.filter((b) => b.kind === "approval" && b.status === "pending").length, [blocks]);

  return (
    <section className={`chat ${running ? "running" : ""}`}>
      <header className="chat-head">
        <div className="chat-title">
          <h2 title={conversation.title}>{conversation.title}</h2>
          <span className={`dot ${connected ? "ok" : "warn"}`} aria-hidden />
          <span className="chat-sub">
            {running ? "智能体工作中…" : connected ? "已连接" : "重连中…"}
          </span>
        </div>
        <div className="chat-head-actions">
          {pendingApprovals > 0 && <span className="pill warn">{pendingApprovals} 项待处理</span>}
          <button type="button" className="ghost" onClick={() => onOpenWorkspace()}>
            工作区
          </button>
        </div>
      </header>

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {blocks.length === 0 && (
          <div className="empty">
            <h3>开始新的对话</h3>
            <p>
              这是一个常驻的 Codex 智能体，运行在你自己的 AIO 沙箱里。它可以读写沙箱文件、运行命令、操作真实浏览器并查看桌面。
            </p>
            <div className="hints">
              <button type="button" onClick={() => setDraft("打开 https://example.com，告诉我页面标题并截图保存到工作区。")}>
                浏览器实测
              </button>
              <button type="button" onClick={() => setDraft("在当前工作区创建一个 hello.py，运行并输出结果。")}>
                写代码并运行
              </button>
              <button type="button" onClick={() => setDraft("列出 /home/gem/workspace 下的文件并总结。")}>
                查看工作区文件
              </button>
            </div>
          </div>
        )}

        {blocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            openSegments={openSegments}
            onToggleSegment={(segmentId) =>
              setOpenSegments((prev) => {
                const next = new Set(prev);
                if (next.has(segmentId)) next.delete(segmentId);
                else next.add(segmentId);
                return next;
              })
            }
            onRespond={respond}
            onOpenWorkspace={onOpenWorkspace}
            onOpenBrowserLink={onOpenBrowserLink}
            onOpenFile={openSandboxFile}
          />
        ))}
      </div>

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="composer">
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((a) => (
              <span className="chip" key={a.path}>
                {a.kind === "image" ? "🖼" : "📄"} {a.name}
                <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} aria-label="移除附件">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={draftRef}
          aria-label="消息"
          value={draft}
          placeholder="想做些什么？"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
        />
        <div className="composer-row">
          {/* A real <label> wrapping a visually-hidden input: clicking the label
              opens the native picker in every browser, including ones that
              refuse a programmatic click on a display:none input. The control is
              disabled while an upload or a send is in flight so picking a file
              can never race the composer being cleared on send. */}
          <label className={`file-button ${uploading || busy ? "disabled" : ""}`} aria-disabled={uploading || busy}>
            {uploading ? "上传中…" : "附件"}
            <input
              type="file"
              multiple
              className="file-input"
              aria-label="添加附件"
              data-testid="attachment-input"
              disabled={uploading || busy}
              onChange={(e) => {
                void onPickFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className="spacer" />
          {running && activeHere ? (
            <button type="button" className="danger" onClick={() => void stop()}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void send()}
              disabled={busy || uploading || (!draft.trim() && attachments.length === 0)}
            >
              {willQueue ? "排队发送" : "发送"}
            </button>
          )}
        </div>
        {willQueue && <div className="queue-hint">沙箱正在执行其他会话（最多 {capacity} 个并发），本条消息会排队等待。</div>}
      </div>

      {previewPath && <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />}
    </section>
  );
}

/**
 * Cards for the workspace files one agent message points at.
 *
 * Extraction is memoised on the message text: an incremental `stream.delta`
 * appends text, so React reconciles the existing cards (keyed by path) instead of
 * rebuilding the list — the cards never flicker or reset mid-stream. Extraction
 * itself is pure, so a delta that adds no new reference produces the same array.
 */
function MessageFileCards({ text, onOpen }: { text: string; onOpen: (path: string) => void }) {
  const refs = useMemo(() => extractFileRefs(text), [text]);
  if (refs.length === 0) return null;
  return (
    <div className="file-cards" data-testid="message-file-cards">
      {refs.map((ref) => (
        <FileCard key={ref.path} path={ref.path} name={ref.name} kind={ref.kind} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Cards for the files attached to a user turn (uploaded or pasted paths). */
function AttachmentCards({
  attachments,
  onOpen,
}: {
  attachments: ReadonlyArray<{ path?: string; name?: string; kind?: string }>;
  onOpen: (path: string) => void;
}) {
  const refs = useMemo(() => attachmentRefs(attachments), [attachments]);
  if (refs.length === 0) return null;
  return (
    <div className="file-cards" data-testid="message-attachment-cards">
      {refs.map((ref) => (
        <FileCard key={ref.path} path={ref.path} name={ref.name} kind={ref.kind} onOpen={onOpen} />
      ))}
    </div>
  );
}

function BlockView({
  block,
  openSegments,
  onToggleSegment,
  onRespond,
  onOpenWorkspace,
  onOpenBrowserLink,
  onOpenFile,
}: {
  block: Block;
  openSegments: ReadonlySet<string>;
  onToggleSegment: (segmentId: string) => void;
  onRespond: (requestId: string, decision: string, extra?: unknown) => void;
  onOpenWorkspace: (path?: string) => void;
  onOpenBrowserLink: (url: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (block.kind === "user") {
    return (
      <article className="msg user">
        <div className="bubble">
          {block.text && <div className="plain">{block.text}</div>}
          {block.attachments.length > 0 && (
            <AttachmentCards attachments={block.attachments} onOpen={onOpenFile} />
          )}
        </div>
      </article>
    );
  }

  if (block.kind === "assistant") {
    // Defensive fallback for stored or abnormal history: an assistant block
    // with no text at all would render an empty bubble, and a zero-width
    // streaming caret would wrongly steal the bottom slot from the live
    // activity row. The reducer never creates such a block (creation is lazy);
    // this only keeps a blank bubble or bare caret off screen if one ever
    // reaches the view.
    if (!block.text.trim()) return null;
    return (
      <article className="msg assistant">
        <div className="bubble">
          <Markdown source={block.text} onOpenLink={onOpenBrowserLink} onOpenFile={onOpenFile} />
          <MessageFileCards text={block.text} onOpen={onOpenFile} />
          {block.streaming && <span className="caret" aria-hidden />}
        </div>
      </article>
    );
  }

  if (block.kind === "reasoning") {
    return (
      <details className="reasoning">
        <summary>摘要{block.streaming ? "（进行中）" : ""}</summary>
        <pre>{block.text}</pre>
      </details>
    );
  }

  if (block.kind === "tool") {
    return <ToolCard block={block} />;
  }

  if (block.kind === "working") {
    return (
      <WorkingGroup
        block={block}
        open={openSegments.has(block.id)}
        onToggle={() => onToggleSegment(block.id)}
      />
    );
  }

  if (block.kind === "approval") {
    return <ApprovalCard block={block} onRespond={onRespond} />;
  }

  const status = block as Extract<Block, { kind: "status" }>;
  return (
    <div className={`status-line ${status.level}`}>
      {status.text}
      {status.text.includes("浏览器") && (
        <button type="button" className="link" onClick={() => onOpenWorkspace()}>
          打开工作区
        </button>
      )}
    </div>
  );
}
/**
 * One tool call inside a Working group: the existing compact tool summary.
 * `inProgress` comes from the owning turn's lifecycle, so a tool left without an
 * `item/completed` stops looking active once the turn ends; its real recorded
 * status and output are untouched.
 */
function ToolCard({ block, inProgress }: { block: Extract<Block, { kind: "tool" }>; inProgress?: boolean }) {
  const running = block.status === "running" && inProgress !== false;
  const shown = running ? "running" : block.status === "running" ? "done" : block.status;
  return (
    <details className={`tool ${shown}`} open={running}>
      <summary>
        <span className={`dot ${running ? "warn" : block.status === "error" ? "error" : "ok"}`} aria-hidden />
        <span className="tool-title">{block.title}</span>
        {block.detail && <span className="tool-detail">{block.detail}</span>}
      </summary>
      {block.output ? <pre>{block.output}</pre> : <pre className="muted">（暂无输出）</pre>}
    </details>
  );
}

/**
 * One continuous run of activity inside a turn. Tools and reasoning summaries
 * live inside; the header states the run's own status, flags a failed tool, and
 * animates only while this run is the turn's live one — a run closed by later
 * prose keeps its place and never animates again. It is a real button, so it is
 * reachable and toggleable from the keyboard, with `aria-expanded` reflecting the
 * state of *this* segment only.
 */
function WorkingGroup({
  block,
  open,
  onToggle,
}: {
  block: WorkingBlock;
  open: boolean;
  onToggle: () => void;
}) {
  const toolCount = block.children.filter((c) => c.kind === "tool").length;
  const reasoningCount = block.children.length - toolCount;
  const label = segmentLabel(block, toolCount);
  const active = segmentIsActive(block);
  const tone = segmentStatusTone(block);
  const emptyHint =
    block.status === "running"
      ? "正在处理…"
      : block.status === "stopping"
        ? "正在停止…"
        : block.status === "queued"
          ? "已排队等待"
          : "本轮没有工具调用或摘要";
  // The label already counts the tools ("执行了 3 项操作"), and a summary-only
  // history row already says "思考摘要". So the meta only adds what the label
  // leaves out: the summary count beside a tool count, or the live row's own
  // hint before anything has arrived. Nothing is shown when the label already
  // says everything there is to say — never a duplicated count.
  const meta =
    toolCount > 0 && reasoningCount > 0
      ? `${reasoningCount} 条摘要`
      : active && block.children.length === 0
        ? "工具与摘要"
        : "";
  // History rows read as neutral marks, not the amber in-progress dot; a real
  // error still flags loudly.
  const dotClass = tone === "active" ? "warn" : tone === "error" ? "error" : "idle";
  // Stable per segment, so two segments in one turn never share a body id.
  const bodyId = `working-body-${block.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <article className={`working ${block.status}${active ? " active" : ""}${block.closed ? " closed" : ""}`}>
      <button
        type="button"
        className="working-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        {active && <span className="working-sweep" aria-hidden />}
        <span className={`dot ${dotClass}`} aria-hidden />
        <span className="working-label">{label}</span>
        {block.hasToolError && <span className="working-flag">工具出错</span>}
        {meta && <span className="working-meta">{meta}</span>}
        <span className="working-caret" aria-hidden>
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open && (
        <div className="working-body" id={bodyId}>
          {/* A run that has started but has no tool or summary yet still gets an
              honest, content-free line — never a fabricated summary. */}
          {block.children.length === 0 && <div className="working-empty">{emptyHint}</div>}
          {block.children.map((child) => {
            const inProgress = childInProgress(block, child);
            return child.kind === "tool" ? (
              <ToolCard key={child.id} block={child} inProgress={inProgress} />
            ) : (
              <details className="reasoning" key={child.id}>
                <summary>摘要{inProgress ? "（进行中）" : ""}</summary>
                <pre>{child.text}</pre>
              </details>
            );
          })}
        </div>
      )}
    </article>
  );
}

interface QuestionOption {
  label?: string;
  description?: string;
}

interface Question {
  id: string;
  header?: string;
  question?: string;
  options?: QuestionOption[] | null;
  isOther?: boolean;
  isSecret?: boolean;
}

function ApprovalCard({
  block,
  onRespond,
}: {
  block: Extract<Block, { kind: "approval" }>;
  onRespond: (requestId: string, decision: string, extra?: unknown) => void;
}) {
  const params = block.payload as Record<string, unknown>;
  const resolved = block.status === "resolved";
  const decisionLabel = block.decision === "expired" ? "已超时/已失效" : `已处理：${block.decision}`;

  // ---- request_user_input: render the questions and send an answers map ----
  const questions = Array.isArray(params.questions) ? (params.questions as Question[]) : [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  // ---- MCP elicitation (form mode): render the requested JSON schema ----
  const elicitationSchema = (params.requestedSchema ?? null) as
    | { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[]; items?: { enum?: string[] } }>; required?: string[] }
    | null;
  const [form, setForm] = useState<Record<string, unknown>>({});
  const elicitationUrl = typeof params.url === "string" ? params.url : null;

  const permissions = (params.permissions ?? null) as Record<string, unknown> | null;
  const command = typeof params.command === "string" ? params.command : null;
  const reason = typeof params.reason === "string" ? params.reason : null;
  const changedPaths = Array.isArray(params.changes)
    ? (params.changes as Array<Record<string, unknown>>).map((c) => String(c.path ?? c.kind ?? "")).filter(Boolean)
    : [];

  const submitAnswers = () => {
    const payload: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const selected = answers[question.id] ?? [];
      const extra = freeText[question.id]?.trim();
      payload[question.id] = { answers: extra ? [...selected, extra] : selected };
    }
    onRespond(block.requestId, "accept", { answers: payload });
  };

  return (
    <div className={`approval ${block.status}`}>
      <div className="approval-head">
        <strong>{APPROVAL_LABELS[block.method] ?? block.method}</strong>
        {resolved && <span className="pill">{decisionLabel}</span>}
      </div>

      {command && <pre>{command}</pre>}
      {changedPaths.length > 0 && (
        <ul className="paths">
          {changedPaths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      )}
      {reason && <p className="muted">{reason}</p>}

      {!resolved && questions.length > 0 && (
        <div className="question-list">
          {questions.map((question) => (
            <fieldset key={question.id}>
              <legend>{question.header || question.question}</legend>
              {question.header && question.question && <p className="muted">{question.question}</p>}
              {(question.options ?? []).map((option) => {
                const label = option.label ?? "";
                const selected = (answers[question.id] ?? []).includes(label);
                return (
                  <label key={label} className="option">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => {
                        const current = answers[question.id] ?? [];
                        const next = e.target.checked ? [...current, label] : current.filter((v) => v !== label);
                        setAnswers({ ...answers, [question.id]: next });
                      }}
                    />
                    <span>
                      {label}
                      {option.description && <span className="muted"> · {option.description}</span>}
                    </span>
                  </label>
                );
              })}
              {(question.isOther || !question.options || question.options.length === 0) && (
                <input
                  type={question.isSecret ? "password" : "text"}
                  placeholder="手动输入…"
                  value={freeText[question.id] ?? ""}
                  onChange={(e) => setFreeText({ ...freeText, [question.id]: e.target.value })}
                />
              )}
            </fieldset>
          ))}
          <div className="approval-actions">
            <button type="button" className="primary" onClick={submitAnswers}>
              提交
            </button>
            <button type="button" className="danger" onClick={() => onRespond(block.requestId, "cancel")}>
              取消
            </button>
          </div>
        </div>
      )}

      {!resolved && questions.length === 0 && elicitationSchema && (
        <div className="question-list">
          {typeof params.message === "string" && <p>{params.message}</p>}
          {Object.entries(elicitationSchema.properties ?? {}).map(([key, prop]) => {
            const label = prop.title ?? key;
            const value = form[key];
            if (Array.isArray(prop.enum)) {
              return (
                <label key={key} className="field">
                  <span>{label}</span>
                  <select value={String(value ?? "")} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
                    <option value="">请选择</option>
                    {prop.enum.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  {prop.description && <span className="muted tiny">{prop.description}</span>}
                </label>
              );
            }
            if (prop.type === "boolean") {
              return (
                <label key={key} className="option">
                  <input type="checkbox" checked={Boolean(value)} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
                  <span>{label}</span>
                </label>
              );
            }
            return (
              <label key={key} className="field">
                <span>{label}</span>
                <input
                  type={prop.type === "number" || prop.type === "integer" ? "number" : "text"}
                  value={String(value ?? "")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [key]: prop.type === "number" || prop.type === "integer" ? Number(e.target.value) : e.target.value,
                    })
                  }
                />
                {prop.description && <span className="muted tiny">{prop.description}</span>}
              </label>
            );
          })}
          <div className="approval-actions">
            <button type="button" className="primary" onClick={() => onRespond(block.requestId, "accept", { content: form })}>
              提交
            </button>
            <button type="button" className="ghost" onClick={() => onRespond(block.requestId, "decline")}>
              拒绝
            </button>
          </div>
        </div>
      )}

      {!resolved && elicitationUrl && (
        <div className="approval-actions">
          <a className="link" href={elicitationUrl} target="_blank" rel="noopener noreferrer">
            打开授权页面
          </a>
          <button type="button" className="primary" onClick={() => onRespond(block.requestId, "accept")}>
            我已完成授权
          </button>
          <button type="button" className="ghost" onClick={() => onRespond(block.requestId, "decline")}>
            拒绝
          </button>
        </div>
      )}

      {!resolved && permissions && questions.length === 0 && !elicitationSchema && !elicitationUrl && (
        <div className="question-list">
          <p className="muted">智能体请求以下额外权限：</p>
          <pre>{JSON.stringify(permissions, null, 2)}</pre>
          <div className="approval-actions">
            <button type="button" className="primary" onClick={() => onRespond(block.requestId, "accept", { permissions })}>
              允许本轮
            </button>
            <button type="button" className="ghost" onClick={() => onRespond(block.requestId, "acceptForSession", { permissions })}>
              本次会话都允许
            </button>
            <button type="button" className="ghost" onClick={() => onRespond(block.requestId, "decline")}>
              拒绝
            </button>
          </div>
        </div>
      )}

      {!resolved && questions.length === 0 && !elicitationSchema && !elicitationUrl && !permissions && (
        <div className="approval-actions">
          <button type="button" className="primary" onClick={() => onRespond(block.requestId, "accept")}>
            允许
          </button>
          <button type="button" className="ghost" onClick={() => onRespond(block.requestId, "acceptForSession")}>
            本次会话都允许
          </button>
          <button type="button" className="ghost" onClick={() => onRespond(block.requestId, "decline")}>
            拒绝
          </button>
          <button type="button" className="danger" onClick={() => onRespond(block.requestId, "cancel")}>
            中止本轮
          </button>
        </div>
      )}
    </div>
  );
}
