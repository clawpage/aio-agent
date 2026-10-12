import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { openNativeBrowser } from '../deviceBrowser';

export function SupportDialog({taskId, onClose}: {taskId?: string; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="support-dialog" aria-labelledby="support-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={e => {
      e.preventDefault(); if (busy || id) return;
      setBusy(true); setError(null);
      void api.supportRequest({kind: taskId ? 'content' : 'deletion', taskId, note}).then(r => setId(r.id)).catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
    }}>
      <h2 id="support-title">{taskId ? t.support.reportTitle : t.support.account}</h2>
      {id ? <p role="status">{t.support.success}<code>{id}</code></p> : <>
        <p className="muted">{taskId ? t.support.reportInfo : t.support.deletionInfo}</p>
        {!taskId && <p><a href="/privacy.html" target="_blank" rel="noreferrer" onClick={e => { if (openNativeBrowser(e.currentTarget.href)) e.preventDefault(); }}>{t.support.privacy}</a> · <a href="/account-deletion.html" target="_blank" rel="noreferrer" onClick={e => { if (openNativeBrowser(e.currentTarget.href)) e.preventDefault(); }}>{t.support.deletion}</a></p>}
        {!taskId && <p className="tiny muted">{t.support.limitations}</p>}
        <label className="field"><span>{t.support.note}</span><textarea autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder={t.support.noteHint} maxLength={2000} required rows={4}/></label>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="support-actions"><button className="ghost" type="button" disabled={busy} onClick={onClose}>{id ? t.support.close : t.support.cancel}</button>{!id && <button className="primary" disabled={busy || !note.trim()}>{busy ? t.support.sending : taskId ? t.support.send : t.support.deletion}</button>}</div>
    </form>
  </dialog>;
}

/** Account controls shared by member and owner configuration pages. */
export function AccountPrivacySettings() {
  const [open, setOpen] = useState(false);
  return <section className="settings-card" aria-label={t.support.account}>
    <div className="settings-section-head"><h3>{t.support.account}</h3><p>{t.support.settingsIntro}</p></div>
    <button type="button" className="ghost" onClick={() => setOpen(true)}>{t.support.account}</button>
    {open && <SupportDialog onClose={() => setOpen(false)}/>}
  </section>;
}

export function SupportSettings() {
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.supportQueue>>['requests']>([]);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.supportQueue().then(r => setRequests(r.requests)).catch(err => setError(String(err)));
  useEffect(() => { void load(); }, []);
  return <section className="settings-card support-settings" aria-label={t.support.queue}>
    <h3>{t.support.queue}</h3><p className="muted">{t.support.queueInfo}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!requests.length && <p className="muted">{t.support.empty}</p>}
    {requests.map(r => <article key={r.id} className="support-request">
      <strong>{t.support.kinds[r.kind]} · {r.account_username || r.username || r.id}</strong>
      <p className="tiny muted">{new Date(r.created_at).toLocaleString()} · {r.status === 'pending' ? t.support.pending : t.support.reviewed} · {r.account_email || r.email}</p>
      <p className="support-note">{r.note}</p>
      {r.content && <details><summary>{r.title}</summary><pre>{r.content}</pre></details>}
      {r.decision && <p className="support-note">{r.decision}</p>}
      <form onSubmit={e => {
        e.preventDefault(); if (busy) return; setBusy(r.id); setError('');
        void api.reviewSupport(r.id, notes[r.id] || '').then(load).catch(err => setError(String(err))).finally(() => setBusy(null));
      }}><label className="field"><span>{t.support.decision}</span><textarea value={notes[r.id] || ''} onChange={e => setNotes(old => ({...old,[r.id]:e.target.value}))} maxLength={2000} required/></label><button className="ghost" disabled={!!busy || !notes[r.id]?.trim()}>{t.support.review}</button></form>
    </article>)}
  </section>;
}
