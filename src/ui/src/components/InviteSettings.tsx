import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Invite } from "../types";
import { t } from "../i18n";

const day = (ms: number) => new Date(ms).toLocaleDateString();

function stateOf(i: Invite): string {
  if (i.usedAt !== null) return t.settings.invite.usedBy(i.usedBy ?? t.settings.invite.deletedAccount, day(i.usedAt));
  if (i.revokedAt !== null) return t.settings.invite.revoked(day(i.revokedAt));
  return t.settings.invite.unused(day(i.createdAt));
}

/** One-time register codes: generate one per request mailed in, send it back, and see who used which. */
export function InviteSettings() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setInvites((await api.invites()).invites); }
    catch (err) { setError(err instanceof Error ? err.message : t.settings.invite.loadFailed); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(code); }
    catch { setError(t.settings.invite.copyFailed); }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createInvite(note);
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.invite.createFailed);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setError(null);
    try { await api.revokeInvite(code); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : t.settings.invite.revokeFailed); }
  };

  return (
    <section className="settings-card invite-settings" aria-label={t.settings.invite.title}>
      <div className="settings-section-head">
        <h3>{t.settings.invite.title}</h3>
        <p>{t.settings.invite.intro}</p>
      </div>
      <form className="invite-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.settings.invite.notePlaceholder} maxLength={200} aria-label={t.settings.invite.noteLabel} />
        <button type="submit" className="primary" disabled={busy}>{busy ? t.settings.invite.creating : t.settings.invite.create}</button>
      </form>
      {error && <p className="banner error" role="alert">{error}</p>}
      {invites && invites.length === 0 && <p className="muted tiny">{t.settings.invite.empty}</p>}
      {invites && invites.length > 0 && (
        <ul className="invite-list">
          {invites.map((i) => {
            const open = i.usedAt === null && i.revokedAt === null;
            return (
              <li key={i.code} className={open ? "" : "done"}>
                <div className="invite-main">
                  <code>{i.code}</code>
                  <span className="muted tiny">{stateOf(i)}{i.note ? ` · ${i.note}` : ""}</span>
                </div>
                {open && (
                  <div className="invite-actions">
                    <button type="button" className="ghost" onClick={() => void copy(i.code)}>{copied === i.code ? t.settings.invite.copied : t.settings.invite.copy}</button>
                    <button type="button" className="link danger-text" onClick={() => void revoke(i.code)}>{t.settings.invite.revoke}</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
