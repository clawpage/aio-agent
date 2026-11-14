import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark, PageLoading } from "./Brand";
import { t } from "../i18n";
import { hasAppleSignIn, hasNativeBrowser, listenGoogleReturn, openDeviceBrowser, openNativeBrowser, signInWithApple } from "../deviceBrowser";
import { campaignProps, track } from "../analytics";

export function AuthIcon({name, size}: {name: "check" | "arrow" | "mail"; size: number}) {
  const paths = {check: "M5 12l4 4L19 6", arrow: "M5 12h14m-6-6 6 6-6 6", mail: "M4 5h16v14H4Z M4 6l8 7 8-7"};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

/**
 * A phone keyboard shrinks the page to the area above it and keeps the window at the top
 * (useKeyboardViewport), so iOS no longer scrolls the box being typed in into view: a `.login`
 * page (sign-in, and a new account's first step) scrolls itself, once the keyboard has settled.
 */
export function useRevealTypedBox() {
  useEffect(() => {
    const vv = window.visualViewport;
    let timer: number | undefined;
    const reveal = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const el = document.activeElement;
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.closest(".login")) el.scrollIntoView({ block: "nearest" });
      }, 80);
    };
    // In the iOS app the keyboard arrives as `aio-keyboard` events instead (useKeyboardViewport).
    vv?.addEventListener("resize", reveal);
    window.addEventListener("aio-keyboard", reveal);
    document.addEventListener("focusin", reveal);
    return () => { clearTimeout(timer); vv?.removeEventListener("resize", reveal); window.removeEventListener("aio-keyboard", reveal); document.removeEventListener("focusin", reveal); };
  }, []);
}

type Mode = "login" | "register";
/** A Google or Apple sign-in verified by the server that has no account yet: it registers next. */
type Pending = { provider: "google" | "apple"; email: string };

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
  // The deployment emails a code a password registration must give back.
  const [emailCodeOn, setEmailCodeOn] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [appleEnabled, setAppleEnabled] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingEmail = pending?.email ?? null;
  const [googleWaiting, setGoogleWaiting] = useState(false);
  /** A web Google sign-in that came back refused: `?google=error`, or `suspended` for a stopped account. */
  const googleError = useRef(new URLSearchParams(location.search).get("google"));

  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  // Opened without ever reaching the server (offline, or the console came from the saved copy):
  // whether there is a session is unknown, so no form is shown, and the first answer reloads the
  // page so it is the latest deployed one.
  const [offline, setOffline] = useState<"noNetwork" | "unreachable" | null>(null);
  const verified = useRef(false);
  const wasOffline = useRef(false);
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
        if (wasOffline.current) { location.reload(); return; }
        verified.current = true;
        setSessionError(false);
        setInviteEmail(session.inviteEmail ?? null);
        setRequiresInvite(session.registrationRequiresInvite !== false);
        setEmailCodeOn(session.emailCode === true);
        if (session.authenticated) {
          setChecking(true);
          await onRestored.current();
        } else {
          try {
            const [google, apple] = await Promise.all([api.googlePending(controller.signal),
              hasAppleSignIn() ? api.applePending(controller.signal) : Promise.resolve({enabled: false, pending: null})]);
            if (!mounted || controller.signal.aborted || submitting.current) return;
            setGoogleEnabled(google.enabled);
            setAppleEnabled(apple.enabled);
            setPending(google.pending ? {provider: "google", email: google.pending.email} : apple.pending ? {provider: "apple", email: apple.pending.email} : null);
            if (googleError.current === "error" || googleError.current === "suspended") {
              setError(googleError.current === "suspended" ? t.auth.suspended : t.auth.google.failed);
              googleError.current = null;
            }
          } catch { /* Password sign-in remains available if the Google endpoint is unavailable. */ }
        }
      } catch {
        if (mounted && !submitting.current) {
          setSessionError(true);
          if (!verified.current) { wasOffline.current = true; setOffline(navigator.onLine ? "unreachable" : "noNetwork"); }
        }
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
      else { setPending(result.pending ? {provider: "google", email: result.pending.email} : null); setError(null); }
    }).catch(err => setError(err instanceof ApiError && err.code === "account_suspended" ? err.message : t.auth.google.failed)).finally(() => {
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

  // The system sheet answers in the app; nothing waits on a browser.
  const startApple = async () => {
    if (submitting.current) return;
    submitting.current = true;
    request.current?.abort();
    setBusy(true); setError(null);
    try {
      const {nonce} = await api.appleStart();
      const answer = await signInWithApple(nonce);
      if (answer.error === "canceled") return;
      if (!answer.identityToken) { setError(t.auth.apple.failed); return; }
      const result = await api.appleVerify(answer.identityToken);
      if (result.authenticated) { setChecking(true); await onRestored.current(); }
      else setPending(result.pending ? {provider: "apple", email: result.pending.email} : null);
    } catch (err) { setError(err instanceof Error ? err.message : t.auth.apple.failed); }
    finally { submitting.current = false; setBusy(false); }
  };

  const cancelGoogle = async () => {
    if (submitting.current) return;
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    try { await (pending?.provider === "apple" ? api.appleCancel() : api.googleCancel()); setPending(null); setGoogleWaiting(false); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : t.auth.google.failed); }
    finally { submitting.current = false; setBusy(false); }
  };

  const register = mode === "register";
  const needCode = register && !pendingEmail && emailCodeOn;
  // The send button counts down the server's wait (a minute after each code).
  useEffect(() => {
    if (!resendAt) return;
    const timer = window.setInterval(() => { const at = Date.now(); setNow(at); if (at >= resendAt) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  const waitSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const waitFor = (seconds: number) => { const at = Date.now(); setNow(at); setResendAt(at + seconds * 1000); };
  const sendCode = async () => {
    if (sendingCode || waitSeconds > 0) return;
    const email = account.trim();
    setSendingCode(true);
    setError(null);
    try {
      const { retryAfter } = await api.sendSignupCode(email);
      setCodeSentTo(email);
      waitFor(retryAfter);
    } catch (err) {
      if (err instanceof ApiError && err.retryAfter) waitFor(err.retryAfter);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingCode(false);
    }
  };
  useEffect(() => { if (!checking && !pendingEmail) track("auth_view", { mode, ...campaignProps() }); }, [mode, checking, pendingEmail]);
  useRevealTypedBox();
  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
    history.replaceState(null, "", next === "register" ? "/register" : "/login");
  };

  const submit = async () => {
    if ((!pendingEmail && !password) || submitting.current) return;
    if (!pendingEmail && register && password !== confirm) { setError(t.auth.passwordMismatch); return; }
    submitting.current = true;
    request.current?.abort();
    setBusy(true);
    setError(null);
    try {
      if (pending) await (pending.provider === "apple" ? api.appleRegister : api.googleRegister)({inviteCode: inviteCode.trim()});
      else if (register) await api.register({ email: account.trim(), password, inviteCode: inviteCode.trim(), ...(needCode ? { emailCode } : {}) });
      else await api.login(password, account.trim());
      setPassword("");
      setConfirm("");
      await onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.code === "invite_required") {
        setRequiresInvite(true);
        setError(t.auth.invite.quotaReached);
      } else if (err instanceof ApiError) {
        // A code that can no longer work is cleared, so the next one is typed into an empty box.
        if (err.code === "email_code_expired" || err.code === "email_code_attempts") setEmailCode("");
        setError(err.message);
      }
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // Old account names are matched exactly: a phone must not capitalize or "correct" them.
  const emailInput = (
    <input
      id="login-email"
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
  );

  if (offline) return (
    <div className="login">
      <div className="login-card login-offline" role="alert">
        <div className="login-brand"><BrandMark size={36}/><span>{t.auth.brand}</span></div>
        <header className="login-heading"><h1>{t.auth.offline.title}</h1><p>{t.auth.offline[offline]}</p></header>
        <button type="button" className="primary block" onClick={() => location.reload()}>{t.auth.offline.retry}</button>
      </div>
    </div>
  );
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
          <h1>{pendingEmail ? (requiresInvite ? t.auth.heading.invite : t.auth.heading.register) : register ? t.auth.heading.register : t.auth.heading.login}</h1>
          <p>{(pendingEmail || register) && !requiresInvite ? t.auth.intro.openRegistration : pendingEmail ? t.auth.google.inviteIntro : register ? t.auth.intro.register : t.auth.intro.login}</p>
        </header>
        {pendingEmail && <div className="login-identity"><span className="login-identity-check"><AuthIcon name="check" size={16}/></span><div><span>{pending?.provider === "apple" ? t.auth.apple.verified : t.auth.google.verified}</span><p className="login-google-email">{pendingEmail}</p></div></div>}
        {/* Apple's button comes first and as large as Google's (App Store rule 4.8). */}
        {!pendingEmail && appleEnabled && hasAppleSignIn() && <button type="button" className="login-apple block" disabled={busy || googleWaiting} onClick={() => void startApple()}>
          <svg viewBox="0 0 17 20" width="16" height="19" aria-hidden="true"><path fill="currentColor" d="M14.1 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.5 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1ZM11.6 3c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3-1.5Z"/></svg>
          <span>{t.auth.apple.button}</span>
        </button>}
        {!pendingEmail && (googleEnabled || (appleEnabled && hasAppleSignIn())) && <>
          {googleEnabled && <button type="button" className="login-google block" disabled={busy || googleWaiting} onClick={() => void startGoogle()}>
            <svg className="login-google-mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
              <path fill="var(--google-yellow)" d="M43.6 20.5H42V20H24v8h11.3A12 12 0 1 1 32.2 13l5.7-5.7A20 20 0 1 0 44 24c0-1.2-.1-2.4-.4-3.5Z"/>
              <path fill="var(--google-red)" d="m6.3 14.7 6.6 4.8A12 12 0 0 1 32.2 13l5.7-5.7A20 20 0 0 0 6.3 14.7Z"/>
              <path fill="var(--google-green)" d="M24 44c5.2 0 10-2 13.5-5.3l-6.2-5.2A12 12 0 0 1 12.7 28l-6.6 5.1A20 20 0 0 0 24 44Z"/>
              <path fill="var(--google-blue)" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4 5.5l6.2 5.2A20 20 0 0 0 44 24c0-1.2-.1-2.4-.4-3.5Z"/>
            </svg>
            <span>{t.auth.google.button}</span>
          </button>}
          <div className="login-divider"><span>{t.auth.passwordAlternative}</span></div>
        </>}
        {googleWaiting && <p className="banner" role="status">{t.auth.google.waiting}</p>}
        {/* A Google registration takes the verified Google email shown above. */}
        {!pendingEmail && (needCode
          // The send button sits in the box's row, as tall as it; outside the label so the box's name stays "email".
          ? <div className="field">
            <label htmlFor="login-email">{t.auth.fields.email}</label>
            <div className="login-code-row">
              {emailInput}
              <button type="button" className="ghost login-send-code" disabled={busy || sendingCode || waitSeconds > 0 || !account.trim()} onClick={() => void sendCode()}>
                {sendingCode ? t.auth.emailCode.sending : waitSeconds > 0 ? t.auth.emailCode.resend(waitSeconds) : t.auth.emailCode.send}
              </button>
            </div>
          </div>
          : <label className="field">
            <span>{t.auth.fields.email}</span>
            {emailInput}
          </label>)}
        {needCode && <>
          <label className="field">
            <span>{t.auth.fields.emailCode}</span>
            {/* No maxLength: a pasted "123 456" is cut to digits here, not to six characters first. */}
            <input
              className="login-code-input"
              value={emailCode}
              onChange={e => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t.auth.fields.emailCodeHint}
            />
          </label>
          {codeSentTo && <p className="muted tiny login-code-sent" role="status">{t.auth.emailCode.sent(codeSentTo)}</p>}
        </>}
        {!pendingEmail && <label className="field">
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
        {(register || pendingEmail) && (
          <>
            {!pendingEmail && <label className="field">
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
        <button type="submit" className="primary block" disabled={busy || (pendingEmail ? requiresInvite && !inviteCode.trim() : !account.trim() || !password || (register && (!confirm || (requiresInvite && !inviteCode.trim()) || (needCode && emailCode.length !== 6))))}>
          <span>{pendingEmail ? (busy ? t.auth.google.activating : requiresInvite ? t.auth.google.activate : t.auth.google.activateOpen) : register ? (busy ? t.auth.submit.registering : t.auth.submit.register) : (busy ? t.auth.submit.loggingIn : t.auth.submit.login)}</span><AuthIcon name="arrow" size={18}/>
        </button>
        {(pendingEmail || googleWaiting) && <button type="button" className="link" disabled={busy} onClick={() => void cancelGoogle()}>{t.auth.google.cancel}</button>}
        {!named && !pendingEmail && (
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
