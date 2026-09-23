import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, openEventStream } from "../api";
import type { AgentEvent, Attachment, Conversation, ModelInfo, StatusResponse } from "../types";
import { applyEvent, emptyTimeline, removeBlock, type Block, type TimelineState } from "../timeline";
import { Markdown } from "./Markdown";

interface Props {
  conversation: Conversation;
  models: ModelInfo[];
  status: StatusResponse | null;
  onConversationChanged: () => void;
  onStatusChanged: () => void;
  onOpenWorkspace: (path?: string) => void;
}

const EFFORT_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

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

export function Chat({ conversation, models, status, onConversationChanged, onStatusChanged, onOpenWorkspace }: Props) {
  const [timeline, setTimeline] = useState<TimelineState>(() => emptyTimeline());
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<string>("");
  const lastIdRef = useRef(0);
  const pendingRef = useRef<{ clientMessageId: string; signature: string; snapshot: { text: string; attachments: Attachment[] } } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stateRef = useRef<TimelineState>(timeline);
  stateRef.current = timeline;
  // Stream handlers must not re-run the effect (the SSE connection would drop).
  const onChangedRef = useRef(onConversationChanged);
  onChangedRef.current = onConversationChanged;
  const onStatusRef = useRef(onStatusChanged);
  onStatusRef.current = onStatusChanged;

  // Load history, then stream. Reconnects resume from the last seen event id.
  useEffect(() => {
    let disposed = false;
    let close: (() => void) | null = null;
    let retry: number | null = null;
    setTimeline(emptyTimeline());
    setConnected(false);
    lastIdRef.current = 0;
    // Back to the app default first: a conversation without a stored model must
    // not inherit the model picked in the previously opened conversation.
    setModel("");
    setEffort("");

    const start = async () => {
      try {
        const detail = await api.conversation(conversation.id);
        if (disposed) return;
        // Conversations that only carried the legacy default were moved to the
        // app default once, server-side; so a stored model here is a real choice.
        if (detail.conversation.model) setModel(detail.conversation.model);
      } catch {
        /* model defaults are optional */
      }
      if (disposed) return;
      connect();
    };

    const connect = () => {
      close = openEventStream(conversation.id, lastIdRef.current, {
        onEvent: (event: AgentEvent) => {
          if (event.id <= lastIdRef.current) return;
          lastIdRef.current = event.id;
          setTimeline((prev) => {
            const next: TimelineState = { blocks: [...prev.blocks], index: new Map(prev.index) };
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
        onOpen: () => setConnected(true),
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

  const running = Boolean(status?.agent.activeTurnId) || conversation.status === "running";
  const activeTurnId = status?.agent.activeTurnId ?? null;
  const activeHere = status?.agent.activeConversationId === conversation.id || !activeTurnId;

  const currentModel = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0];
  const efforts = currentModel?.reasoningEfforts ?? [];

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
        const next: TimelineState = { blocks: [...prev.blocks], index: new Map(prev.index) };
        applyEvent(next, optimistic);
        return next;
      });
      stickRef.current = true;
      await api.submitTurn(conversation.id, {
        text,
        clientMessageId,
        attachments,
        model: model || null,
        effort: effort || null,
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
  }, [attachments, busy, conversation.id, draft, effort, model]);

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

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      const uploaded: Attachment[] = [];
      for (const file of Array.from(files).slice(0, 6)) {
        uploaded.push(await api.upload(file));
        pendingRef.current = null;
      }
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const blocks = timeline.blocks;
  const pendingApprovals = useMemo(() => blocks.filter((b) => b.kind === "approval" && b.status === "pending").length, [blocks]);

  return (
    <section className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <h2 title={conversation.title}>{conversation.title}</h2>
          <span className={`dot ${connected ? "ok" : "warn"}`} aria-hidden />
          <span className="chat-sub">{connected ? "已连接" : "重连中…"}</span>
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
          <BlockView key={block.id} block={block} onRespond={respond} onOpenWorkspace={onOpenWorkspace} />
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
          value={draft}
          placeholder="要做什么？Enter 发送，Shift+Enter 换行。可以附上文件或图片。"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        <div className="composer-row">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" className="ghost" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            附件
          </button>
          {models.length > 0 && (
            <label className="field">
              <span>模型</span>
              <select
                value={model || currentModel?.id || ""}
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort("");
                }}
                disabled={running}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.isDefault ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {efforts.length > 1 && (
            <label className="field">
              <span>思考</span>
              <select value={effort || currentModel?.defaultReasoningEffort || ""} onChange={(e) => setEffort(e.target.value)} disabled={running}>
                {efforts.map((value) => (
                  <option key={value} value={value}>
                    {EFFORT_LABELS[value] ?? value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="spacer" />
          {running && activeHere ? (
            <button type="button" className="danger" onClick={() => void stop()}>
              停止
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void send()} disabled={busy || (!draft.trim() && attachments.length === 0)}>
              {running ? "排队发送" : "发送"}
            </button>
          )}
        </div>
        {running && !activeHere && <div className="queue-hint">沙箱正在执行另一个会话，本条消息会排队等待。</div>}
      </div>
    </section>
  );
}

function BlockView({
  block,
  onRespond,
  onOpenWorkspace,
}: {
  block: Block;
  onRespond: (requestId: string, decision: string, extra?: unknown) => void;
  onOpenWorkspace: (path?: string) => void;
}) {
  if (block.kind === "user") {
    return (
      <article className="msg user">
        <div className="bubble">
          {block.text && <div className="plain">{block.text}</div>}
          {block.attachments.length > 0 && (
            <div className="chips">
              {block.attachments.map((a) => (
                <span className="chip" key={a.path}>
                  {a.kind === "image" ? "🖼" : "📄"} {a.name || a.path}
                </span>
              ))}
            </div>
          )}
        </div>
      </article>
    );
  }

  if (block.kind === "assistant") {
    return (
      <article className="msg assistant">
        <div className="bubble">
          <Markdown source={block.text} />
          {block.streaming && <span className="caret" aria-hidden />}
        </div>
      </article>
    );
  }

  if (block.kind === "reasoning") {
    return (
      <details className="reasoning">
        <summary>思考过程{block.streaming ? "（进行中）" : ""}</summary>
        <pre>{block.text}</pre>
      </details>
    );
  }

  if (block.kind === "tool") {
    return (
      <details className={`tool ${block.status}`} open={block.status === "running"}>
        <summary>
          <span className={`dot ${block.status === "running" ? "warn" : block.status === "error" ? "error" : "ok"}`} aria-hidden />
          {block.title}
          {block.detail && <span className="tool-detail">{block.detail}</span>}
        </summary>
        {block.output ? <pre>{block.output}</pre> : <pre className="muted">（暂无输出）</pre>}
      </details>
    );
  }

  if (block.kind === "approval") {
    return <ApprovalCard block={block} onRespond={onRespond} />;
  }

  return (
    <div className={`status-line ${block.level}`}>
      {block.text}
      {block.text.includes("浏览器") && (
        <button type="button" className="link" onClick={() => onOpenWorkspace()}>
          打开工作区
        </button>
      )}
    </div>
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
