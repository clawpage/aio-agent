import { useKeyboardViewport } from "../useKeyboardViewport";
import { PopupPresence, PopupSurface } from "./PopupMotion";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Conversation, StatusResponse, Task, TaskTab } from "../types";
import { personConsoleTarget, TaskConsole } from "./TaskConsole";
import { homePath, pathUser } from "../userPath";
import { BrandMark } from "./Brand";
import { Chat } from "./Chat";
import { Login } from "./Login";
import { Settings } from "./Settings";
import { UsageDashboard } from './UsageDashboard';
import { useDebugMode } from "../debugMode";
import { Workspace } from "./Workspace";
import { TaskChat } from "./TaskChat";
import { TaskList } from "./TaskList";
import { ScheduleList } from "./ScheduleList";
import { VaultList } from "./VaultList";
import { PushToggle } from "./PushToggle";
import {taskStatusLabels,type TaskFeed} from '../taskStatus';
import { isSandboxLink } from "../sandboxLink";
import { openDeviceBrowser } from "../deviceBrowser";
/** One owner-facing inbox; executor conversations are implementation details. */
/** The site a link goes to, named on the opening card. */
function hostOf(url: string): string {
    try { return new URL(url).host || url; } catch { return url; }
}

/** This device's push subscription address, if notifications are on here. */
async function pushEndpoint(): Promise<string | undefined> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return undefined;
    const registration = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
    return (await registration?.pushManager.getSubscription().catch(() => null))?.endpoint;
}

export function MainApp() {
    useKeyboardViewport();
    const [mobile, setMobile] = useState(() => matchMedia("(max-width: 900px)").matches);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuButton = useRef<HTMLButtonElement>(null);
    const sidebar = useRef<HTMLElement>(null);
    const closeMenu = useCallback(() => { setMenuOpen(false); }, []);
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
    const [role, setRole] = useState<"owner" | "member">("member");
    const [debug] = useDebugMode();
    const [username, setUsername] = useState<string | null>(null);
    /** The address names another account than the one signed in. */
    const [foreign, setForeign] = useState<string | null>(null);
    const [auth, setAuth] = useState<boolean | null>(null);
    const [status, setStatus] = useState<StatusResponse | null>(null);
    const [view, setView] = useState<"main" | "tasks" | "schedules" | "vault" | "usage" | "settings" | "detail">("main");
    const [taskFeed,setTaskFeed]=useState<TaskFeed>({tasks:[],nextBefore:null,connected:false});
    const [detailReturn,setDetailReturn]=useState<'main'|'tasks'>('main');
    const [detailTask,setDetailTask]=useState<Task|null>(null);
    const [detail, setDetail] = useState<Conversation | null>(null);
    const detailRequest = useRef(0);
    const [workspace, setWorkspace] = useState(false);
    const [workspacePath, setWorkspacePath] = useState<string | undefined>();
    const [browserNonce, setBrowserNonce] = useState(0);
    const [notice, setNotice] = useState<string | null>(null);
    // A link opened from a reply: its own tab, operated from the same console as a taken-over task tab.
    const [linkTab, setLinkTab] = useState<TaskTab | null>(null);
    // What is being opened in the sandbox browser, and how to give up on it.
    const [opening, setOpening] = useState<{ title: string; detail: string; slow: boolean; controller: AbortController } | null>(null);
    const [theme, setTheme] = useState(() => matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const expired = useCallback(() => { setAuth(false); setMenuOpen(false); setNotice("登录已过期，请重新登录。"); }, []);
    const check = useCallback(async () => { try {
        // A stuck request falls back to the login screen, which keeps checking and restores the session.
        const session = await api.session(AbortSignal.timeout(10000));
        if (session.authenticated && session.username) {
            const at = pathUser();
            // An address without an account (the root, /login, an old link) becomes your own.
            if (!at) history.replaceState(null, "", homePath(session.username) + location.search);
            setForeign(at && at !== session.username ? at : null);
            setUsername(session.username);
            setNotice(null); setView("main"); setWorkspace(false);
        }
        setRole(session.role ?? (session.username === "owner" ? "owner" : "member"));
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
        // Only while the console is actually on screen: this is the foreground half of idle detection.
        // It names this device's push subscription (if any), so only this device skips notifications while on screen.
        const present = () => { if (document.visibilityState === "visible")
            void pushEndpoint().then((endpoint) => api.presence(endpoint)).catch(() => undefined); };
        present();
        const presence = setInterval(present, 20000);
        const visible = () => { if (document.visibilityState === "visible") {
            present();
            void refreshStatus();
            void renew();
        } };
        document.addEventListener("visibilitychange", visible);
        return () => { clearInterval(poll); clearInterval(timer); clearInterval(presence); document.removeEventListener("visibilitychange", visible); };
    }, [auth, expired, refreshStatus]);
    const notify = useCallback((message: string) => setNotice(message), []);
    const revealBrowser = useCallback(() => { setWorkspace(true); setBrowserNonce(n => n + 1); }, []);
    const openTab = useCallback(async (title: string, detail: string, open: (signal: AbortSignal) => Promise<{ tab?: TaskTab }>) => {
        // Never a dead end: the person can cancel, and a browser that does not answer gives up on its own.
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
        const slow = setTimeout(() => setOpening(o => (o?.controller === controller ? { ...o, slow: true } : o)), 8_000);
        setOpening({ title, detail, slow: false, controller });
        try {
            const opened = await open(controller.signal);
            if (controller.signal.aborted) return;
            // Without the tab server there is no tab of the person's own: show the whole browser instead.
            if (opened.tab) setLinkTab(opened.tab);
            else revealBrowser();
        }
        catch (err) {
            if (timedOut) notify("打开超时：沙箱浏览器暂时没有响应，请稍后重试。");
            else if (!controller.signal.aborted) notify(err instanceof Error ? err.message : String(err));
        }
        finally {
            clearTimeout(timeout);
            clearTimeout(slow);
            setOpening(o => (o?.controller === controller ? null : o));
        }
    }, [notify, revealBrowser]);
    const openLink = useCallback((url: string) => {
        if (!isSandboxLink(url)) { openDeviceBrowser(url); return; }
        return openTab("正在打开链接", hostOf(url), signal => api.openBrowserTab(url, signal));
    }, [openTab]);
    const openFileInBrowser = useCallback((path: string) => openTab("正在打开页面", path.split("/").pop() || path, signal => api.openBrowserFile(path, signal)), [openTab]);
    const closeLink = useCallback((visited: string[]) => {
        setLinkTab(null);
        for (const id of visited) void api.personBrowserClose(id).catch(() => undefined);
    }, []);
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
    // Signing out leaves the account's address; switching to another account keeps its address to name it on the form.
    const logout = async (keepAddress = false) => { try {
        await api.logout();
        if (!keepAddress) history.replaceState(null, "", "/login");
        setAuth(false);
        setForeign(null);
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
        return <Login notice={notice} onSuccess={check} username={pathUser() ?? undefined}/>;
    if (foreign && username)
        return <div className="boot foreign-account" role="alert">
          <h2>这是 {foreign} 的页面</h2>
          <p>当前登录的是 {username}。同一浏览器一次只能登录一个账号。</p>
          <div className="foreign-account-actions">
            <button className="primary" onClick={() => void logout(true)}>退出并登录 {foreign}</button>
            <button className="ghost" onClick={() => { history.replaceState(null, "", homePath(username)); setForeign(null); }}>回到我的页面</button>
          </div>
        </div>;
    // An environment that is starting or waking says nothing: the wait is part of the first request. Only a start that failed is reported.
    const startFailed = status && !status.agent.sessionReady && !status.sandbox.idle ? status.sandbox.setupError ?? null : null;
    return <div className="app main-inbox-app">
    <button className="mobile-menu-button ghost" ref={menuButton} aria-label="打开导航" aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <PopupPresence animate={mobile} onExited={() => menuButton.current?.focus()}>
    {(!mobile || menuOpen) && <>
    {mobile && <PopupSurface className="mobile-menu-backdrop" onClick={closeMenu} aria-hidden="true"/>}
    <PopupSurface as="aside" ref={sidebar} id="main-navigation" className={`sidebar ${menuOpen ? "show-mobile" : ""}`} role={mobile && menuOpen ? "dialog" : undefined} aria-modal={mobile && menuOpen ? true : undefined} aria-label="导航" aria-hidden={mobile && !menuOpen ? true : undefined} inert={mobile && !menuOpen}>
      <button className="mobile-menu-close ghost" aria-label="关闭导航" onClick={closeMenu}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18"/></svg></button><div className="brand"><BrandMark/><div><strong>一站</strong><span className="muted tiny">什么事情都在这里一站解决吧</span></div></div>
      <button className={`ghost block ${view === "main" ? "active" : ""}`} onClick={() => { detailRequest.current++;closeMenu(); setView("main"); setWorkspace(false); }}>主会话</button>
      <button className={`ghost block ${view === "tasks" ? "active" : ""}`} onClick={() => { detailRequest.current++;closeMenu(); setView("tasks"); setWorkspace(false); }}>任务列表</button>
      <button className={`ghost block ${view === "schedules" ? "active" : ""}`} onClick={() => { detailRequest.current++;closeMenu(); setView("schedules"); setWorkspace(false); }}>定时任务</button>
      <button className={`ghost block ${view === "vault" ? "active" : ""}`} onClick={() => { detailRequest.current++;closeMenu(); setView("vault"); setWorkspace(false); }}>密码器</button>
      {role === 'owner' && <button className={`ghost block ${view === 'usage' ? 'active' : ''}`} onClick={() => { detailRequest.current++;closeMenu();setView('usage');setWorkspace(false); }}>用量看板</button>}
      <button className="ghost block" onClick={() => { closeMenu(); openWorkspace(); }}>工作区</button>
      <div className="sidebar-foot"><span className="muted tiny">{!status || startFailed ? "正在连接智能体" : "智能体在线"}</span><PushToggle/><button className="ghost block" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>{theme === "dark" ? "浅色模式" : "深色模式"}</button>{role === "owner" && <button className={`ghost block ${view === "settings" ? "active" : ""}`} onClick={settings}>配置</button>}<button className="ghost block" onClick={() => void logout()}>退出登录</button></div>
    </PopupSurface>
    </>}
    </PopupPresence>
    <main className="main" inert={mobile && menuOpen}>
      {notice && <div className="banner" role="alert">{notice}<button onClick={() => setNotice(null)}>关闭</button></div>}
      {startFailed && <div className="banner error">智能体暂未就绪：{startFailed}。消息仍会保留。</div>}
      <div className="view-slot" hidden={view !== "main"}><TaskChat debug={role === "owner" && debug} onFeed={setTaskFeed} onDetails={t => void details(t)} onOpenLink={u => void openLink(u)} onOpenFileInBrowser={p => void openFileInBrowser(p)} onExpired={expired} onRevealBrowser={revealBrowser}/></div>
      <div className="view-slot" hidden={view !== 'tasks'}><TaskList feed={taskFeed} onDetails={t=>void details(t,'tasks')} onExpired={expired}/></div>
      <div className="view-slot" hidden={view !== 'schedules'}><ScheduleList active={view === 'schedules'} onExpired={expired} onOpenTask={id => { const t = taskFeed.tasks.find(task => task.id === id); if (t) void details(t, 'tasks'); else setView('main'); }}/></div>
      <div className="view-slot" hidden={view !== 'vault'}><VaultList active={view === 'vault'} onExpired={expired}/></div>
      {role === "owner" && view === "settings" && <Settings onBack={() => setView("main")}/>}
      {role === 'owner' && view === 'usage' && <UsageDashboard onExpired={expired}/>}
      {view === "detail" && detail && <div className="task-detail"><div className="task-detail-bar"><button className="ghost" onClick={() => setView(detailReturn)}>← 返回{detailReturn==='tasks'?'任务列表':'主会话'}</button><span className="muted tiny">{taskStatusLabels[(taskFeed.tasks.find(t=>t.id===detailTask?.id)??detailTask)?.status??'']??'过程详情'}</span></div><Chat key={detail.id} readOnly conversation={detail} status={status} onConversationChanged={() => { }} onStatusChanged={() => void refreshStatus()} onOpenWorkspace={openWorkspace} onOpenBrowserLink={u => void openLink(u)} onOpenBrowserFile={p => void openFileInBrowser(p)}/></div>}
    </main>
    <PopupPresence>{opening && <PopupSurface className="task-console-overlay opening-overlay" role="presentation">
      <div className="opening-card" role="status" aria-live="polite">
        <span className="opening-spinner" aria-hidden="true"/>
        <div className="opening-text">
          <strong>{opening.title}</strong>
          <span className="opening-detail">{opening.detail}</span>
          <span className="opening-hint">{opening.slow ? "比平时慢：浏览器可能正在唤醒，通常半分钟内好" : "在沙箱浏览器里加载"}</span>
        </div>
        <button type="button" className="ghost" onClick={() => opening.controller.abort()}>取消</button>
      </div>
    </PopupSurface>}</PopupPresence>
    <PopupPresence>{linkTab && <TaskConsole key={linkTab.id} target={personConsoleTarget} tab={linkTab} label="操作网页" closeLabel="关闭页面" onClose={closeLink} onReveal={() => { setLinkTab(null); revealBrowser(); }}/>}</PopupPresence>
    <Workspace canConfigure={role === "owner"} open={workspace} status={status} initialPath={workspacePath} browserNonce={browserNonce} onClose={() => { setWorkspace(false); setWorkspacePath(undefined); }} onNotify={notify}/>
  </div>;
}
