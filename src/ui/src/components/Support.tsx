import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { openNativeBrowser } from '../deviceBrowser';

export function SupportDialog({onClose}: {onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A question or feedback by default; deleting the account is chosen on purpose.
  const [kind, setKind] = useState<'privacy' | 'deletion'>('privacy');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="support-dialog" aria-labelledby="support-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={e => {
      e.preventDefault(); if (busy || id) return;
      setBusy(true); setError(null);
      void api.supportRequest({kind, note}).then(r => setId(r.id)).catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
    }}>
      <h2 id="support-title">{t.support.account}</h2>
      {id ? <p role="status">{t.support.success}<code>{id}</code></p> : <>
        <fieldset className="support-kind"><legend>{t.support.requestKind}</legend>
          <label className="check-row"><input type="radio" name="support-kind" checked={kind === 'privacy'} onChange={() => setKind('privacy')}/>{t.support.ask}</label>
          <label className="check-row"><input type="radio" name="support-kind" checked={kind === 'deletion'} onChange={() => setKind('deletion')}/>{t.support.deleteAccount}</label>
        </fieldset>
        <p className="muted">{kind === 'deletion' ? t.support.deletionInfo : t.support.askInfo}</p>
        <p><a href="/privacy.html" target="_blank" rel="noreferrer" onClick={e => { if (openNativeBrowser(e.currentTarget.href)) e.preventDefault(); }}>{t.support.privacy}</a> · <a href="/account-deletion.html" target="_blank" rel="noreferrer" onClick={e => { if (openNativeBrowser(e.currentTarget.href)) e.preventDefault(); }}>{t.support.deletion}</a></p>
        <p className="tiny muted">{t.support.limitations}</p>
        <label className="field"><span>{t.support.note}</span><textarea autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder={t.support.noteHint} maxLength={2000} required rows={4}/></label>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="support-actions"><button className="ghost" type="button" disabled={busy} onClick={onClose}>{id ? t.support.close : t.support.cancel}</button>{!id && <button className="primary" disabled={busy || !note.trim()}>{busy ? t.support.sending : kind === 'deletion' ? t.support.deletion : t.support.send}</button>}</div>
    </form>
  </dialog>;
}

/**
 * After a 👎: what was wrong, if the person wants to say (it is recorded with the vote), and,
 * only if they choose, a report of the reply, which goes to the support queue like any report.
 */
export function FeedbackDialog({taskId, onClose}: {taskId: string; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState('');
  const [report, setReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{reportId: string | null} | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="support-dialog" aria-labelledby="feedback-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={e => {
      e.preventDefault(); if (busy || done) return;
      setBusy(true); setError(null);
      void (async () => {
        if (note.trim()) await api.setFeedback(taskId, 'down', note);
        const reportId = report ? (await api.supportRequest({kind: 'content', taskId, note})).id : null;
        setDone({reportId});
      })().catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
    }}>
      <h2 id="feedback-title">{t.support.feedbackTitle}</h2>
      {done ? <p role="status">{done.reportId ? <>{t.support.success}<code>{done.reportId}</code></> : t.support.feedbackThanks}</p> : <>
        <p className="muted">{report ? t.support.reportInfo : t.support.feedbackInfo}</p>
        <label className="field"><span>{t.support.note}</span><textarea autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder={t.support.feedbackHint} maxLength={2000} required={report} rows={4}/></label>
        <label className="check-row"><input type="checkbox" checked={report} onChange={e => setReport(e.target.checked)}/><span>{t.support.alsoReport}</span></label>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="support-actions"><button className="ghost" type="button" disabled={busy} onClick={onClose}>{done ? t.support.close : t.support.cancel}</button>{!done && <button className="primary" disabled={busy || (report && !note.trim())}>{busy ? t.support.sending : t.support.send}</button>}</div>
    </form>
  </dialog>;
}

/** Account controls shared by member and owner configuration pages. */
export function AccountPrivacySettings() {
  const [open, setOpen] = useState(false);
  // The account's email; an account from before email has only its name (its placeholder email stays hidden).
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.session(controller.signal).then(s => setAccount(s.email ?? s.username), () => undefined);
    return () => controller.abort();
  }, []);
  return <section className="settings-card" aria-label={t.support.account}>
    <div className="settings-section-head"><h3>{t.support.account}</h3><p>{t.support.settingsIntro}</p></div>
    {account && <p className="muted tiny">{t.support.signedInAs(account)}</p>}
    <button type="button" className="ghost" onClick={() => setOpen(true)}>{t.support.account}</button>
    {open && <SupportDialog onClose={() => setOpen(false)}/>}
  </section>;
}

export function SupportSettings() {
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.supportQueue>>['requests']>([]);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Awaited<ReturnType<typeof api.feedbackQueue>>['feedback']>([]);
  const load = () => api.supportQueue().then(r => setRequests(r.requests)).catch(err => setError(String(err)));
  useEffect(() => { void load(); void api.feedbackQueue().then(r => setFeedback(r.feedback)).catch(err => setError(String(err))); }, []);
  return <section className="settings-card support-settings" aria-label={t.support.queue}>
    <h3>{t.support.queue}</h3><p className="muted">{t.support.queueInfo}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!requests.length && <p className="muted">{t.support.empty}</p>}
    {requests.map(r => <article key={r.id} className="support-request">
      <strong>{t.support.kinds[r.kind]} · {r.account_username || r.username || r.id}</strong>
      <p className="tiny muted">{new Date(r.created_at).toLocaleString(locale)} · {r.status === 'pending' ? t.support.pending : t.support.reviewed} · {r.account_email || r.email}</p>
      <p className="support-note">{r.note}</p>
      {r.content && <details><summary>{r.title}</summary><pre>{r.content}</pre></details>}
      {r.decision && <p className="support-note">{r.decision}</p>}
      <form onSubmit={e => {
        e.preventDefault(); if (busy) return; setBusy(r.id); setError('');
        void api.reviewSupport(r.id, notes[r.id] || '').then(load).catch(err => setError(String(err))).finally(() => setBusy(null));
      }}><label className="field"><span>{t.support.decision}</span><textarea value={notes[r.id] || ''} onChange={e => setNotes(old => ({...old,[r.id]:e.target.value}))} maxLength={2000} required/></label><button className="ghost" disabled={!!busy || !notes[r.id]?.trim()}>{t.support.review}</button></form>
    </article>)}
    <div className="support-feedback"><h3>{t.support.feedbackQueue}</h3><p className="muted">{t.support.feedbackQueueInfo}</p>
    {!feedback.length && <p className="muted">{t.support.feedbackEmpty}</p>}
    {feedback.map(f => <article key={f.id} className="support-request">
      <strong>{f.rating === 'up' ? '👍' : '👎'} {t.support.ratings[f.rating]} · {f.account_username ?? f.id}</strong>
      <p className="tiny muted">{new Date(f.updated_at).toLocaleString(locale)} · {f.title}</p>
      {f.note && <p className="support-note">{f.note}</p>}
      {f.content && <details><summary>{f.title}</summary><pre>{f.content}</pre></details>}
    </article>)}</div>
  </section>;
}
