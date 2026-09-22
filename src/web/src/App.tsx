import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { Conversation, ModelInfo, StatusResponse } from "./types";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { Workspace } from "./components/Workspace";

type SessionState = { checked: boolean; authenticated: boolean; username: string | null };

export function App() {
  const [session, setSession] = useState<SessionState>({ checked: false, authenticated: false, username: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const [mobilePane, setMobilePane] = useState<"chat" | "list">("chat");
  const [toast, setToast] = useState<{ text: string; level: "info" | "error" } | null>(null);
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

  const refreshConversations = useCallback(async () => {
    try {
      const data = await api.conversations();
      setConversations(data.conversations);
      setActiveId((current) => current ?? data.conversations[0]?.id ?? null);
    } catch {
      /* ignored; the chat pane already surfaces errors */
    }
  }, []);

  // Initial data load once authenticated.
  useEffect(() => {
    if (!session.authenticated) return;
    void refreshConversations();
    void refreshStatus();
    void (async () => {
      try {
        const data = await api.models();
        setModels(data.models);
      } catch {
        setModels([]);
      }
    })();
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
      const { conversation } = await api.createConversation();
      setConversations((prev) => [conversation, ...prev]);
      setActiveId(conversation.id);
      setMobilePane("chat");
      setWorkspaceOpen(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [notify]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* logout is best-effort from the UI's perspective */
    }
    setSession({ checked: true, authenticated: false, username: null });
    setConversations([]);
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
        <nav className="conv-list">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conv ${c.id === activeId ? "active" : ""}`}
              onClick={() => {
                setActiveId(c.id);
                setMobilePane("chat");
              }}
            >
              <span className="conv-title">{c.title}</span>
              <span className={`dot ${c.status === "running" ? "warn" : "idle"}`} aria-hidden />
            </button>
          ))}
          {conversations.length === 0 && <p className="muted tiny">还没有会话，点击上面的按钮开始。</p>}
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
        {active ? (
          <Chat
            conversation={active}
            models={models}
            status={status}
            onConversationChanged={() => void refreshConversations()}
            onStatusChanged={() => void refreshStatus()}
            onOpenWorkspace={(path) => {
              setWorkspacePath(path);
              setWorkspaceOpen(true);
            }}
          />
        ) : (
          <div className="empty">
            <h3>还没有会话</h3>
            <p>创建一个会话，开始使用你的常驻智能体。</p>
            <button type="button" className="primary" onClick={() => void createConversation()}>
              新建会话
            </button>
          </div>
        )}
      </main>

      <Workspace
        open={workspaceOpen}
        status={status}
        initialPath={workspacePath}
        onClose={() => {
          setWorkspaceOpen(false);
          setWorkspacePath(undefined);
        }}
        onNotify={notify}
      />

      <nav className="bottom-nav">
        <button type="button" className={mobilePane === "list" ? "active" : ""} onClick={() => setMobilePane(mobilePane === "list" ? "chat" : "list")}>
          会话
        </button>
        <button type="button" onClick={() => void createConversation()}>
          新建
        </button>
        <button type="button" className={workspaceOpen ? "active" : ""} onClick={() => setWorkspaceOpen(true)}>
          工作区
        </button>
        <button type="button" onClick={() => void logout()}>
          退出
        </button>
      </nav>

      {toast && <div className={`toast ${toast.level}`}>{toast.text}</div>}
    </div>
  );
}
