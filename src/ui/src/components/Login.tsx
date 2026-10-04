import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark } from "./Brand";

type Mode = "login" | "register";

export function Login({ onSuccess, notice, username: named }: { onSuccess: () => void | Promise<void>; notice?: string | null; username?: string }) {
  // `/register` (linked from the clawpage.ai home page) opens straight on the register form.
  const [mode, setMode] = useState<Mode>(() => (!named && location.pathname === "/register" ? "register" : "login"));
  const [username, setUsername] = useState(named ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const onRestored = useRef(onSuccess);
  onRestored.current = onSuccess;
  const request = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      if (document.visibilityState === "hidden" || request.current || submitting.current) return;
      const controller = new AbortController();
      request.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const session = await api.session(controller.signal);
        if (!mounted || controller.signal.aborted || submitting.current) return;
        setSessionError(false);
        setInviteEmail(session.inviteEmail ?? null);
        if (session.authenticated) {
          setChecking(true);
          await onRestored.current();
        }
      } catch {
        if (mounted && !submitting.current) setSessionError(true);
      } finally {
        clearTimeout(timeout);
        if (request.current === controller) request.current = null;
        if (mounted && !submitting.current) setChecking(false);
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    // Safari can restore the old login DOM from bfcache after another tab logs in.
    window.addEventListener("pageshow", visible);
    window.addEventListener("focus", visible);
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 15000);
    return () => {
      mounted = false;
      request.current?.abort();request.current = null;
      clearInterval(timer);
      window.removeEventListener("pageshow", visible);
      window.removeEventListener("focus", visible);
      window.removeEventListener("online", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const register = mode === "register";
  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
    history.replaceState(null, "", next === "register" ? "/register" : "/login");
  };

  const submit = async () => {
    if (!password || submitting.current) return;
    if (register && password !== confirm) { setError("两次输入的密码不一样"); return; }
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    setError(null);
    try {
      if (register) await api.register({ username: username.trim(), password, inviteCode: inviteCode.trim() });
      else await api.login(password, username);
      setPassword("");
      setConfirm("");
      await onSuccess();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (checking) return <div className="boot" role="status">正在恢复登录…</div>;

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="login-brand"><BrandMark size={40}/>一站</h1>
        <p className="muted">{register ? "什么事情都在这里一站解决吧。用邀请码注册一个账号。" : "什么事情都在这里一站解决吧。用你的账号登录。"}</p>
        <label className="field">
          <span>账号</span>
          {/* Account names are matched exactly: a phone must not capitalize or "correct" them. */}
          <input
            value={username}
            onChange={e => setUsername(register ? e.target.value.toLowerCase() : e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!named}
            placeholder={register ? "2–40 位小写字母、数字、- 或 _" : undefined}
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            autoFocus={Boolean(named)}
            autoComplete={register ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={register ? "至少 12 个字符" : "请输入访问密码"}
          />
        </label>
        {register && (
          <>
            <label className="field">
              <span>确认密码</span>
              <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} placeholder="再输入一次密码" />
            </label>
            <label className="field">
              <span>邀请码</span>
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX"
              />
            </label>
            <p className="muted tiny login-invite">
              {inviteEmail
                ? <>还没有邀请码？发邮件到 <a href={`mailto:${inviteEmail}?subject=${encodeURIComponent("申请一站邀请码")}`}>{inviteEmail}</a> 申请。每个邀请码只能注册一个账号。</>
                : "邀请码向管理员索取，每个邀请码只能注册一个账号。"}
            </p>
          </>
        )}
        {sessionError && <div className="banner warn" role="status">暂时无法验证登录状态，网络恢复后会自动重试。</div>}
        {notice && <div className="banner warn">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        <button type="submit" className="primary block" disabled={busy || !password || !username.trim() || (register && (!confirm || !inviteCode.trim()))}>
          {register ? (busy ? "注册中…" : "注册并登录") : (busy ? "登录中…" : "登录")}
        </button>
        {!named && (
          <p className="muted tiny login-switch">
            {register ? "已有账号？" : "还没有账号？"}
            <button type="button" className="link" onClick={() => switchMode(register ? "login" : "register")}>{register ? "去登录" : "用邀请码注册"}</button>
          </p>
        )}

      </form>
    </div>
  );
}
