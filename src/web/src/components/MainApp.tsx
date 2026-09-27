import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Conversation, StatusResponse, Task } from "../types";
import { Chat } from "./Chat";
import { Login } from "./Login";
import { Settings } from "./Settings";
import { Workspace } from "./Workspace";
import { TaskChat } from "./TaskChat";
/** One owner-facing inbox; executor conversations are implementation details. */
export function MainApp() {
    const [auth, setAuth] = useState<boolean | null>(null);
    const [status, setStatus] = useState<StatusResponse | null>(null);
    const [view, setView] = useState<"main" | "settings" | "detail">("main");
    const [detail, setDetail] = useState<Conversation | null>(null);
    const [workspace, setWorkspace] = useState(false);
    const [workspacePath, setWorkspacePath] = useState<string | undefined>();
    const [browserNonce, setBrowserNonce] = useState(0);
    const [notice, setNotice] = useState<string | null>(null);
    const [theme, setTheme] = useState(() => matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const expired = useCallback(() => { setAuth(false); setNotice("登录已过期，请重新登录。"); }, []);
    const check = useCallback(async () => { try {
        setAuth((await api.session()).authenticated);
    }
    catch {
        setAuth(false);
    } }, []);
    const refreshStatus = useCallback(async () => {
        try {
            setStatus(await api.status());
        }
        catch (err) {
            if (err instanceof ApiError && err.status === 401)
                expired();
        }
    }, [expired]);
    useEffect(() => { void check(); }, [check]);
    useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
    useEffect(() => {
        if (!auth)
            return;
        void refreshStatus();
        const poll = setInterval(() => void refreshStatus(), 8000);
        const renew = async () => { try {
            await api.refresh();
        }
        catch (err) {
            if (err instanceof ApiError && err.status === 401)
                expired();
        } };
        const timer = setInterval(() => void renew(), 15 * 60000);
        const visible = () => { if (document.visibilityState === "visible") {
            void refreshStatus();
            void renew();
        } };
        document.addEventListener("visibilitychange", visible);
        return () => { clearInterval(poll); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
    }, [auth, expired, refreshStatus]);
    const notify = useCallback((message: string) => setNotice(message), []);
    const revealBrowser = useCallback(() => { setWorkspace(true); setBrowserNonce(n => n + 1); }, []);
    const openLink = useCallback(async (url: string) => { try {
        await api.openBrowserTab(url);
        revealBrowser();
    }
    catch (err) {
        notify(err instanceof Error ? err.message : String(err));
    } }, [notify, revealBrowser]);
    const openWorkspace = useCallback((path?: string) => { setWorkspacePath(path); setWorkspace(true); }, []);
    const details = useCallback(async (task: Task) => { try {
        setDetail((await api.conversation(task.conversationId)).conversation);
        setView("detail");
        setWorkspace(false);
    }
    catch (err) {
        notify(err instanceof Error ? err.message : String(err));
    } }, [notify]);
    const settings = () => { setView("settings"); setWorkspace(false); };
    const logout = async () => { try {
        await api.logout();
        setAuth(false);
        setDetail(null);
        setWorkspace(false);
        setView("main");
    }
    catch (err) {
        notify(err instanceof Error ? err.message : String(err));
    } };
    if (auth === null)
        return <div className="boot">加载中…</div>;
    if (!auth)
        return <Login notice={notice} onSuccess={() => void check()}/>;
    return <div className="app main-inbox-app">
    <aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden/><div><strong>AIO Agent</strong><span className="muted tiny">一个入口，把事情交给我</span></div></div>
      <button className={`ghost block ${view === "main" ? "active" : ""}`} onClick={() => setView("main")}>主会话</button>
      <div className="sidebar-foot"><span className="muted tiny">{status?.agent.sessionReady ? "智能体在线" : "正在连接智能体"}</span><button className="ghost block" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>{theme === "dark" ? "浅色模式" : "深色模式"}</button><button className="ghost block" onClick={settings}>配置</button><button className="ghost block" onClick={() => void logout()}>退出登录</button></div>
    </aside>
    <main className="main">
      {notice && <div className="banner" role="alert">{notice}<button onClick={() => setNotice(null)}>关闭</button></div>}
      {status && !status.agent.sessionReady && <div className="banner error">智能体暂未就绪：{status.agent.lastError ?? "正在连接"}。消息仍会保留。</div>}
      <div className="view-slot" hidden={view !== "main"}><TaskChat onDetails={t => void details(t)} onOpenWorkspace={() => openWorkspace()} onOpenLink={u => void openLink(u)} onBrowserNavigate={() => { if (view === "main")
        revealBrowser(); }} onExpired={expired}/></div>
      {view === "settings" && <Settings onBack={() => setView("main")}/>}
      {view === "detail" && detail && <div className="task-detail"><div className="task-detail-bar"><button className="ghost" onClick={() => setView("main")}>← 返回主会话</button><span className="muted tiny">过程详情</span></div><Chat key={detail.id} readOnly conversation={detail} status={status} onConversationChanged={() => { }} onStatusChanged={() => void refreshStatus()} onOpenWorkspace={openWorkspace} onOpenBrowserLink={u => void openLink(u)} onAgentBrowserNavigate={revealBrowser}/></div>}
    </main>
    <Workspace open={workspace} status={status} initialPath={workspacePath} browserNonce={browserNonce} onClose={() => { setWorkspace(false); setWorkspacePath(undefined); }} onNotify={notify}/>
    <nav className="bottom-nav"><button onClick={() => setView("main")}>主会话</button><button onClick={() => openWorkspace()}>工作区</button><button onClick={settings}>配置</button><button onClick={() => void logout()}>退出</button></nav>
  </div>;
}
