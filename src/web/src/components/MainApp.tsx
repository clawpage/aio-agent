import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Conversation, StatusResponse, Task } from "../types";
import { Chat } from "./Chat";
import { Login } from "./Login";
import { Settings } from "./Settings";
import { Workspace } from "./Workspace";
import { TaskChat } from "./TaskChat";
import { TaskList } from "./TaskList";
import {taskStatusLabels,type TaskFeed} from '../taskStatus';
/** One owner-facing inbox; executor conversations are implementation details. */
export function MainApp() {
    const [mobile, setMobile] = useState(() => matchMedia("(max-width: 900px)").matches);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuButton = useRef<HTMLButtonElement>(null);
    const sidebar = useRef<HTMLElement>(null);
    const closeMenu = useCallback(() => { setMenuOpen(false); menuButton.current?.focus(); }, []);
    useEffect(() => {
        const query = matchMedia("(max-width: 900px)");
        const change = () => { setMobile(query.matches); setMenuOpen(false); };
        query.addEventListener("change", change);
        return () => query.removeEventListener("change", change);
    }, []);
    useEffect(() => {
        if (!mobile || !menuOpen) return;
        const controls = () => [...(sidebar.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled), a[href]") ?? [])];
        controls()[0]?.focus();
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
            if (event.key === "Tab") {
                const items = controls(), first = items[0], last = items.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        };
        document.addEventListener("keydown", key);
        return () => document.removeEventListener("keydown", key);
    }, [mobile, menuOpen, closeMenu]);
    const [auth, setAuth] = useState<boolean | null>(null);
    const [status, setStatus] = useState<StatusResponse | null>(null);
    const [view, setView] = useState<"main" | "tasks" | "settings" | "detail">("main");
    const [taskFeed,setTaskFeed]=useState<TaskFeed>({tasks:[],nextBefore:null,connected:false});
    const [detailReturn,setDetailReturn]=useState<'main'|'tasks'>('main');
    const [detailTask,setDetailTask]=useState<Task|null>(null);
    const [detail, setDetail] = useState<Conversation | null>(null);
    const detailRequest = useRef(0);
    const [workspace, setWorkspace] = useState(false);
    const [workspacePath, setWorkspacePath] = useState<string | undefined>();
    const [browserNonce, setBrowserNonce] = useState(0);
    const [notice, setNotice] = useState<string | null>(null);
    const [theme, setTheme] = useState(() => matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const expired = useCallback(() => { setAuth(false); setMenuOpen(false); setNotice("登录已过期，请重新登录。"); }, []);
    const check = useCallback(async () => { try {
        const session = await api.session();
        if (session.authenticated) {
            if (location.pathname === "/login") history.replaceState(null, "", "/");
            setNotice(null); setView("main"); setWorkspace(false);
        }
        setAuth(session.authenticated);
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
    const openWorkspace = useCallback((path?: string) => { setMenuOpen(false); setWorkspacePath(path); setWorkspace(true); }, []);
    const details = useCallback(async (task: Task,from:'main'|'tasks'='main') => { const request=++detailRequest.current; try {
        const conversation=(await api.conversation(task.conversationId)).conversation;
        if(request!==detailRequest.current)return;
        setDetail({...conversation,title:task.title});
        setDetailTask(task);setDetailReturn(from);
        setView("detail");
        setWorkspace(false);
    }
    catch (err) {
        notify(err instanceof Error ? err.message : String(err));
    } }, [notify]);
    const settings = () => { detailRequest.current++;closeMenu(); setView("settings"); setWorkspace(false); };
    const logout = async () => { try {
        await api.logout();
        setAuth(false);
        setMenuOpen(false);
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
        return <Login notice={notice} onSuccess={check}/>;
    return <div className="app main-inbox-app">
    <button className="mobile-menu-button ghost" ref={menuButton} aria-label="打开导航" aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    {mobile && menuOpen && <div className="mobile-menu-backdrop" onClick={closeMenu} aria-hidden="true"/>}
    <aside ref={sidebar} id="main-navigation" className={`sidebar ${menuOpen ? "show-mobile" : ""}`} role={mobile && menuOpen ? "dialog" : undefined} aria-modal={mobile && menuOpen ? true : undefined} aria-label="导航" aria-hidden={mobile && !menuOpen ? true : undefined} inert={mobile && !menuOpen}>
      <button className="mobile-menu-close ghost" aria-label="关闭导航" onClick={closeMenu}>×</button><div className="brand"><span className="brand-mark" aria-hidden/><div><strong>AIO Agent</strong><span className="muted tiny">一个入口，把事情交给我</span></div></div>
      <button className={`ghost block ${view === "main" ? "active" : ""}`} onClick={() => { detailRequest.current++;closeMenu(); setView("main"); setWorkspace(false); }}>主会话</button>
      <button className={`ghost block ${view === "tasks" ? "active" : ""}`} onClick={() => { detailRequest.current++;closeMenu(); setView("tasks"); setWorkspace(false); }}>任务列表</button>
      <button className="ghost block" onClick={() => { closeMenu(); openWorkspace(); }}>工作区</button>
      <div className="sidebar-foot"><span className="muted tiny">{status?.agent.sessionReady ? "智能体在线" : "正在连接智能体"}</span><button className="ghost block" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>{theme === "dark" ? "浅色模式" : "深色模式"}</button><button className="ghost block" onClick={settings}>配置</button><button className="ghost block" onClick={() => void logout()}>退出登录</button></div>
    </aside>
    <main className="main" inert={mobile && menuOpen}>
      {notice && <div className="banner" role="alert">{notice}<button onClick={() => setNotice(null)}>关闭</button></div>}
      {status && !status.agent.sessionReady && <div className="banner error">智能体暂未就绪：{status.agent.lastError ?? "正在连接"}。消息仍会保留。</div>}
      <div className="view-slot" hidden={view !== "main"}><TaskChat onFeed={setTaskFeed} onDetails={t => void details(t)} onOpenLink={u => void openLink(u)} onBrowserNavigate={() => { if (view === "main")
        revealBrowser(); }} onExpired={expired}/></div>
      <div className="view-slot" hidden={view !== 'tasks'}><TaskList feed={taskFeed} onDetails={t=>void details(t,'tasks')} onExpired={expired}/></div>
      {view === "settings" && <Settings onBack={() => setView("main")}/>}
      {view === "detail" && detail && <div className="task-detail"><div className="task-detail-bar"><button className="ghost" onClick={() => setView(detailReturn)}>← 返回{detailReturn==='tasks'?'任务列表':'主会话'}</button><span className="muted tiny">{taskStatusLabels[(taskFeed.tasks.find(t=>t.id===detailTask?.id)??detailTask)?.status??'']??'过程详情'}</span></div><Chat key={detail.id} readOnly conversation={detail} status={status} onConversationChanged={() => { }} onStatusChanged={() => void refreshStatus()} onOpenWorkspace={openWorkspace} onOpenBrowserLink={u => void openLink(u)} onAgentBrowserNavigate={revealBrowser}/></div>}
    </main>
    <Workspace open={workspace} status={status} initialPath={workspacePath} browserNonce={browserNonce} onClose={() => { setWorkspace(false); setWorkspacePath(undefined); }} onNotify={notify}/>
  </div>;
}
