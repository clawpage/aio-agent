import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { InlineLoading } from "./Brand";
import { t } from "../i18n";

/** A send-code button's countdown: the server's wait after each code (a minute). */
function useResendWait() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => { const at = Date.now(); setNow(at); if (at >= until) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  const wait = (seconds: number) => { const at = Date.now(); setNow(at); setUntil(at + seconds * 1000); };
  return { seconds: Math.max(0, Math.ceil((until - now) / 1000)), wait };
}

/**
 * Settings → Email and password, for a member: a new password and the code emailed to the account.
 * An account without an email (from before email) enters one in the same form; the code goes there
 * and the change binds it.
 */
export function SecuritySettings() {
  const S = t.settings.security;
  const [state, setState] = useState<{ available: boolean; email: string | null; minPassword: number } | null | "failed">(null);
  const load = useCallback(async () => {
    setState(null);
    try { setState(await api.accountSecurity()); } catch { setState("failed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <section className="settings-card security-settings" aria-label={S.title}>
    <div className="settings-section-head"><h3>{S.title}</h3><p>{state && state !== "failed" && state.available && !state.email ? S.bindIntro : S.intro}</p></div>
    {state === null ? <InlineLoading label={t.common.loading}/>
      : state === "failed" ? <>
        <p className="banner error" role="alert">{t.profile.loadFailed}</p>
        <div className="settings-actions"><button type="button" className="ghost" onClick={() => void load()}>{t.profile.retry}</button></div>
      </>
      : !state.available ? <p className="muted">{S.unavailable}</p>
      : <ChangePassword email={state.email} minPassword={state.minPassword} onBound={(email) => setState({ ...state, email })}/>}
  </section>;
}

function ChangePassword({ email, minPassword, onBound }: { email: string | null; minPassword: number; onBound: (email: string) => void }) {
  const S = t.settings.security;
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  /** Where the last code went: it fits that address only. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resend = useResendWait();
  const target = email ?? newEmail.trim();
  const send = async () => {
    if (sending || resend.seconds > 0) return;
    setSending(true); setError(null);
    try { const { retryAfter } = await api.sendPasswordCode(email ? undefined : target); setSentTo(target); resend.wait(retryAfter); }
    catch (err) { if (err instanceof ApiError && err.retryAfter) resend.wait(err.retryAfter); setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  };
  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.changePassword(password, code, email ? undefined : target);
      setDone(email ? S.changed : S.changedBound);
      setPassword(""); setConfirm(""); setCode(""); setSentTo(null); setNewEmail("");
      if (!email) onBound(r.email);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const ready = !!target && sentTo === target && code.length === 6 && password.length >= minPassword && password === confirm;
  const edit = (set: (v: string) => void) => (v: string) => { set(v); if (done) setDone(null); };
  const sendButton = <button type="button" className="ghost security-send-code" disabled={busy || sending || resend.seconds > 0 || !target} onClick={() => void send()}>
    {sending ? t.auth.emailCode.sending : resend.seconds > 0 ? t.auth.emailCode.resend(resend.seconds) : t.auth.emailCode.send}
  </button>;
  return <form className="security-form" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
    {email
      ? <>
        <p className="muted tiny">{S.bound(email)}</p>
        {/* Lets a password manager file the new password under the account's email. */}
        <input type="email" name="username" value={email} autoComplete="username" readOnly hidden/>
      </>
      : <label className="field"><span>{S.email}</span>
        <input type="email" name="email" value={newEmail} onChange={(e) => edit(setNewEmail)(e.target.value)} autoComplete="email" placeholder={t.auth.fields.emailHint} disabled={busy}/></label>}
    <label className="field"><span>{S.newPassword}</span>
      <input type="password" name="new-password" value={password} onChange={(e) => edit(setPassword)(e.target.value)} autoComplete="new-password" placeholder={t.auth.fields.newPasswordHint} disabled={busy}/></label>
    <label className="field"><span>{S.confirm}</span>
      <input type="password" name="confirm-password" value={confirm} onChange={(e) => edit(setConfirm)(e.target.value)} autoComplete="new-password" disabled={busy}/></label>
    {mismatch && <p className="muted tiny" role="status">{S.mismatch}</p>}
    <div className="field">
      <label htmlFor="security-code">{S.code}</label>
      <div className="security-code-row">
        <input id="security-code" className="security-code-input" name="code" value={code} onChange={(e) => edit(setCode)(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric" autoComplete="one-time-code" placeholder={t.auth.fields.emailCodeHint} disabled={busy}/>
        {sendButton}
      </div>
    </div>
    {sentTo && <p className="muted tiny" role="status">{t.auth.emailCode.sent(sentTo)}</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    {done && <p className="banner ok" role="status">{done}</p>}
    <div className="settings-actions"><span className="spacer"/><button type="submit" className="primary" disabled={!ready || busy}>{busy ? S.changing : S.change}</button></div>
  </form>;
}
