import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark } from "./Brand";

export function Login({ onSuccess, notice, username: named }: { onSuccess: () => void | Promise<void>; notice?: string | null; username?: string }) {
  const [username, setUsername] = useState(named ?? "owner");
  const [password, setPassword] = useState("");
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

  const submit = async () => {
    if (!password || submitting.current) return;
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    setError(null);
    try {
      await api.login(password, username);
      setPassword("");
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
        <p className="muted">什么事情都在我这里一站解决吧。用管理员给你的账号登录。</p>
        <label className="field">
          <span>账号</span>
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入访问密码"
          />
        </label>
        {sessionError && <div className="banner warn" role="status">暂时无法验证登录状态，网络恢复后会自动重试。</div>}
        {notice && <div className="banner warn">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        <button type="submit" className="primary block" disabled={busy || !password}>
          {busy ? "登录中…" : "登录"}
        </button>

      </form>
    </div>
  );
}
