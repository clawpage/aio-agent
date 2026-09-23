import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "./api";
import type { Conversation, StatusResponse } from "./types";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { Settings } from "./components/Settings";
import { Workspace } from "./components/Workspace";

type SessionState = { checked: boolean; authenticated: boolean; username: string | null };

/** Backend contract for a hand-typed title (mirrors `renameConversation`). */
const TITLE_MAX_CHARS = 200;

export function App() {
  const [session, setSession] = useState<SessionState>({ checked: false, authenticated: false, username: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [archived, setArchived] = useState<Conversation[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined);
  const [browserNonce, setBrowserNonce] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const [mobilePane, setMobilePane] = useState<"chat" | "list">("chat");
  const [toast, setToast] = useState<{ text: string; level: "info" | "error" } | null>(null);
  // The unified config page is a real separate view. The chat pane stays mounted
  // behind it so returning never loses a draft, attachments or the SSE stream.
  const [view, setView] = useState<"chat" | "settings">("chat");
  const lastRefresh = useRef(Date.now());

  const notify = useCallback((message: string, level: "info" | "error" = "info") => {
    setToast({ text: message, level });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const loadSession = useCallback(async () => {
    try {
      const result = await api.session();
      setSession({ checked: true, authenticated: result.authenticated, username: result.username });
    } catch {
      setSession({ checked: true, authenticated: false, username: null });
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession((prev) => ({ ...prev, authenticated: false }));
        setNotice("登录已过期，请重新登录。");
      }
    }
  }, []);

  /**
   * Refresh the active list and, if the current selection was archived
   * elsewhere, move to the next available conversation instead of leaving the
   * chat pane pointing at a missing conversation.
   */
  const refreshConversations = useCallback(async () => {
    try {
      const data = await api.conversations(false);
      setConversations(data.conversations);
      setActiveId((current) =>
        current && data.conversations.some((c) => c.id === current) ? current : (data.conversations[0]?.id ?? null),
      );
    } catch {
      /* ignored; the chat pane already surfaces errors */
    }
  }, []);

  const refreshArchived = useCallback(async () => {
    try {
      const data = await api.conversations(true);
      setArchived(data.conversations.filter((c) => c.archived));
    } catch {
      /* ignored */
    }
  }, []);

  // Initial data load once authenticated.
  useEffect(() => {
    if (!session.authenticated) return;
    void refreshConversations();
    void refreshStatus();
  }, [session.authenticated, refreshConversations, refreshStatus]);

  // Keep the poll light but responsive: status every 8s, conversations every 20s.
  useEffect(() => {
    if (!session.authenticated) return;
    const statusTimer = window.setInterval(() => void refreshStatus(), 8000);
    const listTimer = window.setInterval(() => void refreshConversations(), 20000);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(listTimer);
    };
  }, [session.authenticated, refreshConversations, refreshStatus]);

  /**
   * Automatic login renewal. The session cookie is rotated while the tab is open
   * so long-lived sessions survive without asking the user to log in again.
   */
  const renew = useCallback(async () => {
    try {
      await api.refresh();
      lastRefresh.current = Date.now();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession((prev) => ({ ...prev, authenticated: false }));
        setNotice("登录已过期，请重新登录。");
      }
    }
  }, []);

  useEffect(() => {
    if (!session.authenticated) return;
    const timer = window.setInterval(() => void renew(), 15 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh.current > 5 * 60_000) void renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [renew, session.authenticated]);

  const createConversation = useCallback(async () => {
    try {
      const { conversation, reused } = await api.createConversation();
      // An empty create reuses an existing blank conversation server-side; the
      // list may not contain it yet if the archived view is showing.
      setArchived((prev) => prev.filter((c) => c.id !== conversation.id));
      setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)]);
      setShowArchived(false);
      setActiveId(conversation.id);
      setMobilePane("chat");
      setView("chat");
      setWorkspaceOpen(false);
      if (reused) await refreshConversations();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [notify, refreshConversations]);

  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
    setMobilePane("chat");
    setView("chat");
  }, []);

  /**
   * Open the unified config page. Both entries (desktop sidebar and mobile
   * bottom nav) must close the mobile conversation drawer and the workspace, or
   * the drawer would cover the settings view on a phone.
   */
  const openSettings = useCallback(() => {
    setMobilePane("chat");
    setWorkspaceOpen(false);
    setView("settings");
  }, []);

  const archiveConversation = useCallback(
    async (conversation: Conversation) => {
      try {
        await api.updateConversation(conversation.id, { archived: true });
        await refreshConversations();
        if (showArchived) await refreshArchived();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [notify, refreshArchived, refreshConversations, showArchived],
  );

  const restoreConversation = useCallback(
    async (conversation: Conversation) => {
      try {
        await api.updateConversation(conversation.id, { archived: false });
        await refreshConversations();
        await refreshArchived();
        setActiveId(conversation.id);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [notify, refreshArchived, refreshConversations],
  );

  /**
   * Persist a hand-typed title. Errors are thrown back to the dialog so it can
   * keep the user's input and show the message inline; a successful rename
   * refreshes both lists and the chat header immediately.
   */
  const renameConversation = useCallback(
    async (conversation: Conversation, title: string) => {
      await api.updateConversation(conversation.id, { title });
      await refreshConversations();
      if (showArchived) await refreshArchived();
    },
    [refreshArchived, refreshConversations, showArchived],
  );

  const toggleArchived = useCallback(async () => {
    setShowArchived((prev) => !prev);
    await refreshArchived();
  }, [refreshArchived]);

  /**
   * Reveal the sandbox browser: open the workspace if it is closed, otherwise
   * switch the already-open workspace to the browser tab and refresh it. A
   * closed workspace is opened on the browser tab by default, so a single
   * nonce bump covers both cases without double-loading.
   */
  const revealSandboxBrowser = useCallback(() => {
    setWorkspaceOpen(true);
    setBrowserNonce((n) => n + 1);
  }, []);

  /**
   * A link in an agent reply: create a real tab in the sandbox's Chromium and
   * reveal the browser view. The server validates the URL and surfaces sandbox
   * errors, which are shown to the user instead of pretending success.
   */
  const openBrowserLink = useCallback(
    async (url: string) => {
      try {
        await api.openBrowserTab(url);
        revealSandboxBrowser();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [notify, revealSandboxBrowser],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* logout is best-effort from the UI's perspective */
    }
    setSession({ checked: true, authenticated: false, username: null });
    setConversations([]);
    setArchived([]);
    setActiveId(null);
    setWorkspaceOpen(false);
  }, []);

  if (!session.checked) {
    return <div className="boot">加载中…</div>;
  }

  if (!session.authenticated) {
    return <Login notice={notice} onSuccess={() => void loadSession()} />;
  }

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const hostAuthBad = status !== null && !status.hostAuth.ok;
  const sandboxBad = status !== null && (!status.sandbox.running || !status.sandbox.healthy);
  const agentBad = status !== null && !status.agent.sessionReady;
  const listed = showArchived ? archived : conversations;

  return (
    <div className="app">
      <aside className={`sidebar ${mobilePane === "list" ? "show-mobile" : ""}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <strong>个人智能体</strong>
            <span className="muted tiny">Codex + AIO 沙箱</span>
          </div>
        </div>
        <button type="button" className="primary block" onClick={() => void createConversation()}>
          ＋ 新建会话
        </button>
        <button type="button" className="ghost block" onClick={() => void toggleArchived()}>
          {showArchived ? "← 返回活跃会话" : `查看已归档${archived.length ? `（${archived.length}）` : ""}`}
        </button>
        <nav className="conv-list" aria-label={showArchived ? "已归档会话" : "会话列表"}>
          {listed.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              archived={showArchived}
              active={c.id === activeId && !showArchived}
              onSelect={selectConversation}
              onRename={setRenameTarget}
              onArchive={(conversation) => void archiveConversation(conversation)}
              onRestore={(conversation) => void restoreConversation(conversation)}
            />
          ))}
          {listed.length === 0 && (
            <p className="muted tiny">{showArchived ? "没有已归档的会话。" : "还没有会话，点击上面的按钮开始。"}</p>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className={`status-chip ${status?.agent.sessionReady ? "ok" : "warn"}`}>
            <span className="dot" aria-hidden />
            {status?.agent.sessionReady ? "智能体在线" : "智能体未就绪"}
          </div>
          {status?.agent.account?.email && <span className="muted tiny">{status.agent.account.email}</span>}
          <button type="button" className="ghost block" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "浅色模式" : "深色模式"}
          </button>
          <button
            type="button"
            className={`ghost block ${view === "settings" ? "active" : ""}`}
            onClick={openSettings}
          >
            配置
          </button>
          <button type="button" className="ghost block" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        {(hostAuthBad || sandboxBad || agentBad) && (
          <div className="banner error">
            {hostAuthBad && `宿主机 Codex 登录异常：${status?.hostAuth.error ?? "未知原因"}。请在 Mac 上重新运行 codex login。`}
            {!hostAuthBad && sandboxBad && "沙箱容器未就绪，正在尝试恢复；工作区功能可能暂不可用。"}
            {!hostAuthBad && !sandboxBad && agentBad && `智能体会话未就绪：${status?.agent.lastError ?? "正在启动"}`}
          </div>
        )}
        {/*
          The chat pane stays mounted while the config page is open: hiding it
          (not unmounting) keeps the draft, attachments, scroll position and the
          live SSE stream intact, so returning never interrupts a running task.
        */}
        <div className="view-slot" hidden={view === "settings"}>
          {active && !showArchived ? (
            <Chat
              conversation={active}
              status={status}
              onConversationChanged={() => void refreshConversations()}
              onStatusChanged={() => void refreshStatus()}
              onOpenWorkspace={(path) => {
                setWorkspacePath(path);
                setWorkspaceOpen(true);
              }}
              onOpenBrowserLink={(url) => void openBrowserLink(url)}
              onAgentBrowserNavigate={revealSandboxBrowser}
            />
          ) : (
            <div className="empty">
              <h3>{showArchived ? "已归档会话" : "还没有会话"}</h3>
              <p>
                {showArchived
                  ? "在这里恢复到活跃列表。归档只影响侧栏显示，不会清除沙箱文件或远端 Codex 数据。"
                  : "创建一个会话，开始使用你的常驻智能体。"}
              </p>
              <button type="button" className="primary" onClick={() => void createConversation()}>
                新建会话
              </button>
            </div>
          )}
        </div>
        {view === "settings" && <Settings onBack={() => setView("chat")} />}
      </main>

      <Workspace
        open={workspaceOpen}
        status={status}
        initialPath={workspacePath}
        browserNonce={browserNonce}
        onClose={() => {
          setWorkspaceOpen(false);
          setWorkspacePath(undefined);
        }}
        onNotify={notify}
      />

      <nav className="bottom-nav">
        <button
          type="button"
          className={mobilePane === "list" && view === "chat" ? "active" : ""}
          onClick={() => {
            setView("chat");
            setMobilePane(mobilePane === "list" ? "chat" : "list");
          }}
        >
          会话
        </button>
        <button type="button" onClick={() => void createConversation()}>
          新建
        </button>
        <button
          type="button"
          className={workspaceOpen ? "active" : ""}
          onClick={() => {
            setView("chat");
            setWorkspaceOpen(true);
          }}
        >
          工作区
        </button>
        <button type="button" className={view === "settings" ? "active" : ""} onClick={openSettings}>
          配置
        </button>
        <button type="button" onClick={() => void logout()}>
          退出
        </button>
      </nav>

      {renameTarget && (
        <RenameDialog
          conversation={renameTarget}
          onCancel={() => setRenameTarget(null)}
          onSave={async (title) => {
            await renameConversation(renameTarget, title);
            setRenameTarget(null);
            notify("已重命名");
          }}
        />
      )}

      {toast && <div className={`toast ${toast.level}`}>{toast.text}</div>}
    </div>
  );
}

/**
 * One sidebar row. All per-conversation actions live behind a single lightweight
 * `⋯` button so the row stays readable. The menu is portal-rendered to
 * `document.body` and positioned with fixed viewport coordinates, so it is never
 * clipped by the scrollable sidebar (or its transformed mobile drawer).
 */
function ConversationRow({
  conversation,
  archived,
  active,
  onSelect,
  onRename,
  onArchive,
  onRestore,
}: {
  conversation: Conversation;
  archived: boolean;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (conversation: Conversation) => void;
  onArchive: (conversation: Conversation) => void;
  onRestore: (conversation: Conversation) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
    triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep it inside the viewport: flip above when there is no room below.
    const MENU_WIDTH = 148;
    const MENU_HEIGHT = 92;
    const left = Math.min(Math.max(8, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
    const openUp = rect.bottom + MENU_HEIGHT > window.innerHeight && rect.top > MENU_HEIGHT;
    const top = openUp ? rect.top - MENU_HEIGHT - 4 : rect.bottom + 4;
    setPos({ top: Math.max(8, top), left });
    setOpen(true);
  }, []);

  // Outside pointer press and Escape close the menu; the first item takes focus
  // so the menu is usable from the keyboard.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
      setPos(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    firstItemRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const title = conversation.title;
  // One status dot per row: both branches below share this single element.
  const statusDot = (
    <span className={`dot ${conversation.status === "running" ? "warn" : "idle"}`} aria-hidden />
  );
  return (
    <div className={`conv ${active ? "active" : ""} ${open ? "menu-open" : ""}`}>
      {archived ? (
        // Archived conversations have no chat pane behind this list, so the title
        // is a plain label: clicking it can never select an invisible chat.
        <div className="conv-main static">
          <span className="conv-title" title={title}>
            {title}
          </span>
          {statusDot}
        </div>
      ) : (
        <button type="button" className="conv-main" onClick={() => onSelect(conversation.id)}>
          <span className="conv-title" title={title}>
            {title}
          </span>
          {statusDot}
        </button>
      )}
      <button
        type="button"
        className="conv-menu-button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${title} 的操作`}
        onClick={() => (open ? close() : openMenu())}
      >
        ⋯
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="conv-menu"
            role="menu"
            aria-label={`${title} 的操作`}
            style={{ top: pos.top, left: pos.left }}
          >
            <button
              ref={firstItemRef}
              type="button"
              role="menuitem"
              className="conv-menu-item"
              onClick={() => {
                close();
                onRename(conversation);
              }}
            >
              重命名
            </button>
            {archived ? (
              <button
                type="button"
                role="menuitem"
                className="conv-menu-item"
                onClick={() => {
                  close();
                  onRestore(conversation);
                }}
              >
                恢复
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="conv-menu-item"
                onClick={() => {
                  close();
                  onArchive(conversation);
                }}
              >
                归档
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Rename dialog: prefilled with the current title and validated against the same
 * bound as the server (trimmed, non-empty, ≤200 chars). A failed save keeps the
 * input and shows the error inline; the caller owns closing on success.
 */
function RenameDialog({
  conversation,
  onSave,
  onCancel,
}: {
  conversation: Conversation;
  onSave: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(conversation.title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const submit = useCallback(async () => {
    const title = value.trim();
    if (!title) {
      setError("标题不能为空");
      return;
    }
    if (title.length > TITLE_MAX_CHARS) {
      setError(`标题最长 ${TITLE_MAX_CHARS} 个字符`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [onSave, value]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="重命名会话">
        <h3>重命名会话</h3>
        <label className="field rename-field">
          <span>会话标题</span>
          <input
            ref={inputRef}
            value={value}
            maxLength={TITLE_MAX_CHARS}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
