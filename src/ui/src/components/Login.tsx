import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark, PageLoading } from "./Brand";
import { t } from "../i18n";
import { hasNativeBrowser, listenGoogleReturn, openDeviceBrowser, openNativeBrowser } from "../deviceBrowser";
import { track } from "../analytics";

function AuthIcon({name, size}: {name: "check" | "arrow" | "mail"; size: number}) {
  const paths = {check: "M5 12l4 4L19 6", arrow: "M5 12h14m-6-6 6 6-6 6", mail: "M4 5h16v14H4Z M4 6l8 7 8-7"};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

type Mode = "login" | "register";

export function Login({ onSuccess, notice, username: named }: { onSuccess: () => void | Promise<void>; notice?: string | null; username?: string }) {
  // `/register` (linked from the clawpage.ai home page) opens straight on the register form.
  const [mode, setMode] = useState<Mode>(() => (!named && location.pathname === "/register" ? "register" : "login"));
  // The account's email; an account from before email may also sign in with its username.
  const [account, setAccount] = useState(named ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [requiresInvite, setRequiresInvite] = useState(true);
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
        setRequiresInvite(session.registrationRequiresInvite !== false);
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
  useEffect(() => { if (!checking && !googleEmail) track("auth_view", { mode }); }, [mode, checking, googleEmail]);
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
      if (googleEmail) await api.googleRegister({inviteCode: inviteCode.trim()});
      else if (register) await api.register({ email: account.trim(), password, inviteCode: inviteCode.trim() });
      else await api.login(password, account.trim());
      setPassword("");
      setConfirm("");
      await onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.code === "invite_required") {
        setRequiresInvite(true);
        setError(t.auth.invite.quotaReached);
      } else if (err instanceof ApiError) setError(err.message);
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
        <div className="login-brand"><BrandMark size={36}/><span>{t.auth.brand}</span></div>
        <header className="login-heading">
          <h1>{googleEmail ? (requiresInvite ? t.auth.heading.invite : t.auth.heading.register) : register ? t.auth.heading.register : t.auth.heading.login}</h1>
          <p>{(googleEmail || register) && !requiresInvite ? t.auth.intro.openRegistration : googleEmail ? t.auth.google.inviteIntro : register ? t.auth.intro.register : t.auth.intro.login}</p>
        </header>
        {googleEmail && <div className="login-identity"><span className="login-identity-check"><AuthIcon name="check" size={16}/></span><div><span>{t.auth.google.verified}</span><p className="login-google-email">{googleEmail}</p></div></div>}
        {!googleEmail && googleEnabled && <>
          <button type="button" className="login-google block" disabled={busy || googleWaiting} onClick={() => void startGoogle()}>
            <svg className="login-google-mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
              <path fill="var(--google-yellow)" d="M43.6 20.5H42V20H24v8h11.3A12 12 0 1 1 32.2 13l5.7-5.7A20 20 0 1 0 44 24c0-1.2-.1-2.4-.4-3.5Z"/>
              <path fill="var(--google-red)" d="m6.3 14.7 6.6 4.8A12 12 0 0 1 32.2 13l5.7-5.7A20 20 0 0 0 6.3 14.7Z"/>
              <path fill="var(--google-green)" d="M24 44c5.2 0 10-2 13.5-5.3l-6.2-5.2A12 12 0 0 1 12.7 28l-6.6 5.1A20 20 0 0 0 24 44Z"/>
              <path fill="var(--google-blue)" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4 5.5l6.2 5.2A20 20 0 0 0 44 24c0-1.2-.1-2.4-.4-3.5Z"/>
            </svg>
            <span>{t.auth.google.button}</span>
          </button>
          <div className="login-divider"><span>{t.auth.passwordAlternative}</span></div>
        </>}
        {googleWaiting && <p className="banner" role="status">{t.auth.google.waiting}</p>}
        {/* A Google registration takes the verified Google email shown above. */}
        {!googleEmail && <label className="field">
          <span>{t.auth.fields.email}</span>
          {/* Old account names are matched exactly: a phone must not capitalize or "correct" them. */}
          <input
            type={register ? "email" : "text"}
            inputMode="email"
            value={account}
            onChange={e => setAccount(e.target.value)}
            autoComplete={register ? "email" : "username"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!named}
            placeholder={register ? t.auth.fields.emailHint : t.auth.fields.signInHint}
          />
        </label>}
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
            {requiresInvite && <><label className="field">
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
            <p className="muted tiny login-invite"><AuthIcon name="mail" size={14}/><span>
              {inviteEmail
                ? <>{t.auth.invite.askBefore}<a href={`mailto:${inviteEmail}?subject=${encodeURIComponent(t.auth.invite.mailSubject)}`}>{inviteEmail}</a>{t.auth.invite.askAfter}</>
                : t.auth.invite.askAdmin}
            </span></p></>}
          </>
        )}
        {sessionError && <div className="banner warn" role="status">{t.auth.sessionUnverified}</div>}
        {notice && <div className="banner warn">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        <button type="submit" className="primary block" disabled={busy || (googleEmail ? requiresInvite && !inviteCode.trim() : !account.trim() || !password || (register && (!confirm || (requiresInvite && !inviteCode.trim()))))}>
          <span>{googleEmail ? (busy ? t.auth.google.activating : requiresInvite ? t.auth.google.activate : t.auth.google.activateOpen) : register ? (busy ? t.auth.submit.registering : t.auth.submit.register) : (busy ? t.auth.submit.loggingIn : t.auth.submit.login)}</span><AuthIcon name="arrow" size={18}/>
        </button>
        {(googleEmail || googleWaiting) && <button type="button" className="link" disabled={busy} onClick={() => void cancelGoogle()}>{t.auth.google.cancel}</button>}
        {!named && !googleEmail && (
          <p className="muted tiny login-switch">
            {register ? t.auth.switch.haveAccount : t.auth.switch.noAccount}
            <button type="button" className="link" onClick={() => switchMode(register ? "login" : "register")}>{register ? t.auth.switch.toLogin : t.auth.switch.toRegister}</button>
          </p>
        )}
      <p className="login-policy tiny"><a href="/privacy.html" target="_blank" rel="noreferrer" onClick={e => { if (openNativeBrowser(e.currentTarget.href)) e.preventDefault(); }}>{t.support.privacy}</a> · <a href="/account-deletion.html" target="_blank" rel="noreferrer" onClick={e => { if (openNativeBrowser(e.currentTarget.href)) e.preventDefault(); }}>{t.support.account}</a></p>
      </form>
    </div>
  );
}
