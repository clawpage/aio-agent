import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark, PageLoading } from "./Brand";
import { t } from "../i18n";
import { hasNativeBrowser, listenGoogleReturn, openDeviceBrowser } from "../deviceBrowser";

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
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [googleWaiting, setGoogleWaiting] = useState(false);
  const googleError = useRef(new URLSearchParams(location.search).get("google") === "error");

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
        } else {
          try {
            const google = await api.googlePending(controller.signal);
            if (!mounted || controller.signal.aborted || submitting.current) return;
            setGoogleEnabled(google.enabled);
            setGoogleEmail(google.pending?.email ?? null);
            if (googleError.current) {
              setError(t.auth.google.failed);
              googleError.current = false;
            }
          } catch { /* Password sign-in remains available if the Google endpoint is unavailable. */ }
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

  useEffect(() => listenGoogleReturn(detail => {
    setGoogleWaiting(false);
    if (!detail.ticket || detail.error) { setError(t.auth.google.failed); return; }
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    void api.googleRedeem(detail.ticket).then(async result => {
      if (result.authenticated) await onRestored.current();
      else { setGoogleEmail(result.pending?.email ?? null); setError(null); }
    }).catch(() => setError(t.auth.google.failed)).finally(() => {
      submitting.current = false; setBusy(false); setChecking(false);
    });
  }), []);

  const startGoogle = async () => {
    if (submitting.current) return;
    submitting.current = true;
    request.current?.abort();
    setBusy(true); setError(null);
    try {
      const native = hasNativeBrowser();
      const {url} = await api.googleStart(native);
      if (native) { setGoogleWaiting(true); openDeviceBrowser(url); }
      else location.assign(url);
    } catch (err) { setError(err instanceof Error ? err.message : t.auth.google.failed); }
    finally { submitting.current = false; setBusy(false); }
  };

  const cancelGoogle = async () => {
    if (submitting.current) return;
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    try { await api.googleCancel(); setGoogleEmail(null); setGoogleWaiting(false); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : t.auth.google.failed); }
    finally { submitting.current = false; setBusy(false); }
  };

  const register = mode === "register";
  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
    history.replaceState(null, "", next === "register" ? "/register" : "/login");
  };

  const submit = async () => {
    if ((!googleEmail && !password) || submitting.current) return;
    if (!googleEmail && register && password !== confirm) { setError(t.auth.passwordMismatch); return; }
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    setError(null);
    try {
      if (googleEmail) await api.googleRegister({username: username.trim(), inviteCode: inviteCode.trim()});
      else if (register) await api.register({ username: username.trim(), password, inviteCode: inviteCode.trim() });
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

  if (checking) return <PageLoading label={t.auth.restoring}/>;

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
        <p className="muted">{googleEmail ? t.auth.google.inviteIntro : register ? t.auth.intro.register : t.auth.intro.login}</p>
        {googleEmail && <p className="login-google-email">{googleEmail}</p>}
        {!googleEmail && googleEnabled && <button type="button" className="block" disabled={busy} onClick={() => void startGoogle()}>{t.auth.google.button}</button>}
        {googleWaiting && <p className="banner" role="status">{t.auth.google.waiting}</p>}
        <label className="field">
          <span>{t.auth.fields.username}</span>
          {/* Account names are matched exactly: a phone must not capitalize or "correct" them. */}
          <input
            value={username}
            onChange={e => setUsername(register || googleEmail ? e.target.value.toLowerCase() : e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!named}
            placeholder={register || googleEmail ? t.auth.fields.usernameHint : undefined}
          />
        </label>
        {!googleEmail && <label className="field">
          <span>{t.auth.fields.password}</span>
          <input
            type="password"
            value={password}
            autoFocus={Boolean(named)}
            autoComplete={register ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={register ? t.auth.fields.newPasswordHint : t.auth.fields.passwordHint}
          />
        </label>}
        {(register || googleEmail) && (
          <>
            {!googleEmail && <label className="field">
              <span>{t.auth.fields.confirm}</span>
              <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} placeholder={t.auth.fields.confirmHint} />
            </label>}
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
        <button type="submit" className="primary block" disabled={busy || !username.trim() || (googleEmail ? !inviteCode.trim() : !password || (register && (!confirm || !inviteCode.trim())))}>
          {googleEmail ? (busy ? t.auth.google.activating : t.auth.google.activate) : register ? (busy ? t.auth.submit.registering : t.auth.submit.register) : (busy ? t.auth.submit.loggingIn : t.auth.submit.login)}
        </button>
        {(googleEmail || googleWaiting) && <button type="button" className="link" disabled={busy} onClick={() => void cancelGoogle()}>{t.auth.google.cancel}</button>}
        {!named && !googleEmail && (
          <p className="muted tiny login-switch">
            {register ? t.auth.switch.haveAccount : t.auth.switch.noAccount}
            <button type="button" className="link" onClick={() => switchMode(register ? "login" : "register")}>{register ? t.auth.switch.toLogin : t.auth.switch.toRegister}</button>
          </p>
        )}
      </form>
    </div>
  );
}
