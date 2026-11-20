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

/** The six-digit box, as on the register form: a pasted "123 456" keeps its digits. */
function CodeField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <label className="field">
    <span>{t.settings.security.code}</span>
    <input className="security-code-input" name="code" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric" autoComplete="one-time-code" placeholder={t.auth.fields.emailCodeHint} disabled={disabled}/>
  </label>;
}

/**
 * Settings → Email and password, for a member. Changing the password takes a code emailed to the
 * account's email; an account that has none (from before email) binds one first, with a code too.
 */
export function SecuritySettings() {
  const S = t.settings.security;
  const [state, setState] = useState<{ available: boolean; email: string | null; minPassword: number } | null | "failed">(null);
  const load = useCallback(async () => {
    setState(null);
    try { setState(await api.accountSecurity()); } catch { setState("failed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const [bound, setBound] = useState(false);
  return <section className="settings-card security-settings" aria-label={S.title}>
    <div className="settings-section-head"><h3>{S.title}</h3><p>{state && state !== "failed" && !state.email ? S.bindIntro : S.intro}</p></div>
    {state === null ? <InlineLoading label={t.common.loading}/>
      : state === "failed" ? <>
        <p className="banner error" role="alert">{t.profile.loadFailed}</p>
        <div className="settings-actions"><button type="button" className="ghost" onClick={() => void load()}>{t.profile.retry}</button></div>
      </>
      : !state.available ? <p className="muted">{S.unavailable}</p>
      : !state.email ? <BindEmail onBound={(email) => { setBound(true); setState({ ...state, email }); }}/>
      : <>
        <p className="muted tiny">{S.bound(state.email)}</p>
        {bound && <p className="banner ok" role="status">{S.boundOk}</p>}
        <ChangePassword email={state.email} minPassword={state.minPassword}/>
      </>}
  </section>;
}

function BindEmail({ onBound }: { onBound: (email: string) => void }) {
  const S = t.settings.security;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resend = useResendWait();
  const send = async () => {
    if (sending || resend.seconds > 0) return;
    const to = email.trim();
    setSending(true); setError(null);
    try { const { retryAfter } = await api.sendBindCode(to); setSentTo(to); resend.wait(retryAfter); }
    catch (err) { if (err instanceof ApiError && err.retryAfter) resend.wait(err.retryAfter); setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  };
  const submit = async () => {
    setBusy(true); setError(null);
    try { const r = await api.bindEmail(email.trim(), code); onBound(r.email); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  // The code fits the address it was sent to only.
  const ready = !!sentTo && sentTo === email.trim() && code.length === 6;
  return <form className="security-form" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
    <div className="field">
      <label htmlFor="security-email">{S.email}</label>
      <div className="security-code-row">
        <input id="security-email" type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder={t.auth.fields.emailHint} disabled={busy}/>
        <button type="button" className="ghost security-send-code" disabled={busy || sending || resend.seconds > 0 || !email.trim()} onClick={() => void send()}>
          {sending ? t.auth.emailCode.sending : resend.seconds > 0 ? t.auth.emailCode.resend(resend.seconds) : t.auth.emailCode.send}
        </button>
      </div>
    </div>
    <CodeField value={code} onChange={setCode} disabled={busy}/>
    {sentTo && <p className="muted tiny" role="status">{t.auth.emailCode.sent(sentTo)}</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="settings-actions"><span className="spacer"/><button type="submit" className="primary" disabled={!ready || busy}>{busy ? S.binding : S.bind}</button></div>
  </form>;
}

function ChangePassword({ email, minPassword }: { email: string; minPassword: number }) {
  const S = t.settings.security;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resend = useResendWait();
  const send = async () => {
    if (sending || resend.seconds > 0) return;
    setSending(true); setError(null);
    try { const { retryAfter } = await api.sendPasswordCode(); setSent(true); resend.wait(retryAfter); }
    catch (err) { if (err instanceof ApiError && err.retryAfter) resend.wait(err.retryAfter); setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  };
  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = async () => {
    setBusy(true); setError(null);
    try { await api.changePassword(password, code); setDone(true); setPassword(""); setConfirm(""); setCode(""); setSent(false); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const ready = sent && code.length === 6 && password.length >= minPassword && password === confirm;
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); if (done) setDone(false); };
  return <form className="security-form" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
    {/* Lets a password manager file the new password under the account's email. */}
    <input type="email" name="username" value={email} autoComplete="username" readOnly hidden/>
    <label className="field"><span>{S.newPassword}</span>
      <input type="password" name="new-password" value={password} onChange={(e) => edit(setPassword)(e.target.value)} autoComplete="new-password" placeholder={t.auth.fields.newPasswordHint} disabled={busy}/></label>
    <label className="field"><span>{S.confirm}</span>
      <input type="password" name="confirm-password" value={confirm} onChange={(e) => edit(setConfirm)(e.target.value)} autoComplete="new-password" disabled={busy}/></label>
    {mismatch && <p className="muted tiny" role="status">{S.mismatch}</p>}
    <div className="field">
      <label htmlFor="security-password-code">{S.code}</label>
      <div className="security-code-row">
        <input id="security-password-code" className="security-code-input" name="code" value={code} onChange={(e) => edit(setCode)(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric" autoComplete="one-time-code" placeholder={t.auth.fields.emailCodeHint} disabled={busy}/>
        <button type="button" className="ghost security-send-code" disabled={busy || sending || resend.seconds > 0} onClick={() => void send()}>
          {sending ? t.auth.emailCode.sending : resend.seconds > 0 ? t.auth.emailCode.resend(resend.seconds) : t.auth.emailCode.send}
        </button>
      </div>
    </div>
    {sent && <p className="muted tiny" role="status">{t.auth.emailCode.sent(email)}</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    {done && <p className="banner ok" role="status">{S.changed}</p>}
    <div className="settings-actions"><span className="spacer"/><button type="submit" className="primary" disabled={!ready || busy}>{busy ? S.changing : S.change}</button></div>
  </form>;
}
