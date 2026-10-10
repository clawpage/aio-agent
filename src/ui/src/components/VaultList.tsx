import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { VaultEntry, VaultScript } from "../types";
import { locale, t } from "../i18n";

interface Draft { id: string | null; site: string; method: "password" | "google"; username: string; password: string; wasGoogle: boolean }

/**
 * The password vault: the accounts the agent may sign in with. A password is
 * shown only after the person asks for that one, and is forgotten again when the
 * page is hidden or left.
 */
export function VaultList({ active, onExpired }: { active: boolean; onExpired: () => void }) {
  const [items, setItems] = useState<VaultEntry[] | null>(null);
  const [scripts, setScripts] = useState<VaultScript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const fail = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) onExpired();
    setError(err instanceof Error ? err.message : fallback);
  }, [onExpired]);
  const load = useCallback(async () => {
    try { const r = await api.vault(); setItems(r.entries); setScripts(r.scripts ?? []); setError(null); }
    catch (err) { fail(err, t.vault.list.loadFailed); }
  }, [fail]);
  useEffect(() => {
    if (active) void load();
    // Leaving the page takes every shown password off the screen and out of memory.
    else { setShown({}); setDraft(null); setConfirm(null); }
  }, [active, load]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState !== "visible") setShown({}); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  const toggle = async (e: VaultEntry) => {
    if (shown[e.id] !== undefined) { setShown(({ [e.id]: _gone, ...rest }) => rest); return; }
    try { const { password } = await api.vaultReveal(e.id); setShown((s) => ({ ...s, [e.id]: password })); setError(null); }
    catch (err) { fail(err, t.vault.list.loadFailed); }
  };
  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const password = draft.method === "password" && draft.password ? { password: draft.password } : {};
      if (draft.id) await api.vaultUpdate(draft.id, { site: draft.site, method: draft.method, username: draft.username, ...password });
      else await api.vaultCreate({ site: draft.site, method: draft.method, username: draft.username, ...password });
      setDraft(null);
      setShown({});
      await load();
    } catch (err) { fail(err, t.vault.list.saveFailed); }
    finally { setBusy(false); }
  };
  const forget = async (site: string) => {
    try { await api.vaultForgetScript(site); await load(); }
    catch (err) { fail(err, t.vault.list.clearFailed); }
  };
  /** The kept steps for an entry's site (its own host, or a parent domain), as the server matches them. */
  const scriptFor = (site: string) => scripts.filter((s) => site === s.site || site.endsWith(`.${s.site}`) || s.site.endsWith(`.${site}`)).sort((a, b) => b.site.length - a.site.length)[0];
  const remove = async (id: string) => {
    setBusy(true);
    try { await api.vaultDelete(id); setConfirm(null); await load(); }
    catch (err) { fail(err, t.vault.list.deleteFailed); }
    finally { setBusy(false); }
  };

  // Editing happens where the account is in the list; a new account is added at the top.
  const form = draft && <form className="vault-form vault-edit" aria-label={draft.id ? t.vault.list.edit : t.vault.list.add} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="field"><span>{t.vault.form.site}</span><input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} autoCapitalize="none" spellCheck={false} placeholder={t.vault.form.sitePlaceholder} /></label>
      <label className="field"><span>{t.vault.form.method}</span><select value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as Draft["method"] })}><option value="password">{t.vault.form.methodPassword}</option><option value="google">{t.vault.form.methodGoogle}</option></select></label>
      <label className="field"><span>{draft.method === "google" ? t.vault.form.googleAccount : t.vault.form.account}</span><input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={draft.method === "google" ? t.vault.form.googlePlaceholder : t.vault.form.accountPlaceholder} /></label>
      {draft.method === "password" && <label className="field"><span>{t.vault.form.password}</span><input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} autoComplete="new-password" placeholder={draft.id && !draft.wasGoogle ? t.vault.form.keepPassword : ""} /></label>}
      <div className="schedule-actions">
        <button type="submit" className="primary tiny" disabled={busy || !draft.site.trim() || (draft.method === "password" && (!draft.id || draft.wasGoogle) && !draft.password)}>{t.vault.form.save}</button>
        <button type="button" className="ghost tiny" onClick={() => setDraft(null)}>{t.vault.form.cancel}</button>
      </div>
    </form>;

  return <section className="schedule-page vault-page" aria-label={t.vault.list.title}>
    <header className="chat-head"><div className="chat-title"><h2>{t.vault.list.title}</h2><span className="task-list-sub muted tiny">{items ? t.vault.list.count(items.length) : t.vault.list.loading}</span></div></header>
    <div className="task-list-scroll">
      <p className="schedule-hint muted tiny">{t.vault.list.hint}</p>
      {error && <p className="banner error" role="alert">{error}</p>}
      {!draft && <div className="schedule-actions vault-add"><button type="button" className="ghost tiny" onClick={() => setDraft({ id: null, site: "", method: "password", username: "", password: "", wasGoogle: false })}>{t.vault.list.add}</button></div>}
      {draft && !draft.id && form}
      {items && !items.length && !draft && <div className="empty"><h3>{t.vault.list.emptyTitle}</h3><p>{t.vault.list.emptyBody}</p></div>}
      <ul className="task-list">{(items ?? []).map((e) => <li key={e.id} data-vault-id={e.id}>
        {draft?.id === e.id ? form : <div className="task-list-item schedule-item">
          <div className="task-list-top"><strong>{e.site}</strong><span className="muted tiny">{e.lastUsedAt ? t.vault.list.lastUsed(new Date(e.lastUsedAt).toLocaleDateString(locale)) : t.vault.list.neverUsed}</span></div>
          {e.method === "google"
            ? <p className="vault-row"><span className="muted tiny">{t.vault.list.method}</span><span className="vault-value vault-google">{t.vault.form.methodGoogle}{e.username ? t.vault.list.googleWith(e.username) : t.vault.list.googleBrowserAccount}</span></p>
            : <>
              <p className="vault-row"><span className="muted tiny">{t.vault.form.account}</span><span className="vault-value">{e.username || t.vault.list.notFilled}</span></p>
              <p className="vault-row"><span className="muted tiny">{t.vault.form.password}</span><span className="vault-value" data-testid="vault-password">{shown[e.id] ?? "••••••••"}</span></p>
              {(() => { const s = scriptFor(e.site); return <p className="vault-row" data-testid="vault-script"><span className="muted tiny">{t.vault.list.steps}</span><span className="vault-script">{s
                ? <>{t.vault.list.scriptKept(s.steps, s.successes, s.failures, s.lastNote)}<button type="button" className="link tiny" onClick={() => void forget(s.site)}>{t.vault.list.clear}</button></>
                : <span className="muted">{t.vault.list.noScript}</span>}</span></p>; })()}
            </>}
          {confirm === e.id
            ? <div className="schedule-actions" role="alert"><span className="tiny">{t.vault.list.deleteWarning}</span><button className="ghost tiny" onClick={() => setConfirm(null)}>{t.vault.form.cancel}</button><button className="danger tiny" disabled={busy} onClick={() => void remove(e.id)}>{t.vault.list.confirmDelete}</button></div>
            : <div className="schedule-actions">
              {e.method === "password" && <button className="ghost tiny" onClick={() => void toggle(e)}>{shown[e.id] !== undefined ? t.vault.list.hidePassword : t.vault.list.showPassword}</button>}
              <button className="ghost tiny" onClick={() => setDraft({ id: e.id, site: e.site, method: e.method, username: e.username, password: "", wasGoogle: e.method === "google" })}>{t.vault.list.modify}</button>
              <button className="ghost tiny" onClick={() => setConfirm(e.id)}>{t.vault.list.delete}</button>
            </div>}
        </div>}
      </li>)}</ul>
    </div>
  </section>;
}
