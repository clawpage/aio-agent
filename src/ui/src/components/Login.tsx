import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark } from "./Brand";
import { locale, setLocale, t } from "../i18n";

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
    if (register && password !== confirm) { setError(t.auth.passwordMismatch); return; }
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

  if (checking) return <div className="boot" role="status">{t.auth.restoring}</div>;

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="login-brand"><BrandMark size={40}/>{t.auth.brand}</h1>
        <p className="muted">{register ? t.auth.intro.register : t.auth.intro.login}</p>
        <label className="field">
          <span>{t.auth.fields.username}</span>
          {/* Account names are matched exactly: a phone must not capitalize or "correct" them. */}
          <input
            value={username}
            onChange={e => setUsername(register ? e.target.value.toLowerCase() : e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!named}
            placeholder={register ? t.auth.fields.usernameHint : undefined}
          />
        </label>
        <label className="field">
          <span>{t.auth.fields.password}</span>
          <input
            type="password"
            value={password}
            autoFocus={Boolean(named)}
            autoComplete={register ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={register ? t.auth.fields.newPasswordHint : t.auth.fields.passwordHint}
          />
        </label>
        {register && (
          <>
            <label className="field">
              <span>{t.auth.fields.confirm}</span>
              <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} placeholder={t.auth.fields.confirmHint} />
            </label>
            <label className="field">
              <span>{t.auth.fields.inviteCode}</span>
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
                ? <>{t.auth.invite.askBefore}<a href={`mailto:${inviteEmail}?subject=${encodeURIComponent(t.auth.invite.mailSubject)}`}>{inviteEmail}</a>{t.auth.invite.askAfter}</>
                : t.auth.invite.askAdmin}
            </p>
          </>
        )}
        {sessionError && <div className="banner warn" role="status">{t.auth.sessionUnverified}</div>}
        {notice && <div className="banner warn">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        <button type="submit" className="primary block" disabled={busy || !password || !username.trim() || (register && (!confirm || !inviteCode.trim()))}>
          {register ? (busy ? t.auth.submit.registering : t.auth.submit.register) : (busy ? t.auth.submit.loggingIn : t.auth.submit.login)}
        </button>
        {!named && (
          <p className="muted tiny login-switch">
            {register ? t.auth.switch.haveAccount : t.auth.switch.noAccount}
            <button type="button" className="link" onClick={() => switchMode(register ? "login" : "register")}>{register ? t.auth.switch.toLogin : t.auth.switch.toRegister}</button>
          </p>
        )}
        <p className="muted tiny login-switch">
          <button type="button" className="link" lang={locale === "en" ? "zh-CN" : "en"} onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>{t.nav.otherLanguage}</button>
        </p>
      </form>
    </div>
  );
}
