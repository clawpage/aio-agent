import { useEffect, useState } from "react";
import { api } from "../api";
import type { TaskTab, VaultEntry } from "../types";
import { t } from "../i18n";

const OUTCOME: Record<string, string> = t.vault.prompt.outcome;

/**
 * A task's agent reached a sign-in form and asked the password vault. The
 * person picks a saved account or types one here; it goes straight into the
 * page, and the agent is only told that the form was submitted. Skipping hands
 * them the page to type into themselves, as before the vault existed.
 */
export function VaultPrompt({ taskId, tab, busy, onDone, onManual }: { taskId: string; tab: TaskTab; busy: boolean; onDone: () => void; onManual: () => void }) {
  const site = tab.request?.site ?? "";
  const [saved, setSaved] = useState<VaultEntry[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.vault(site).then((r) => { if (alive) setSaved(r.entries); }).catch(() => undefined);
    return () => { alive = false; };
  }, [site]);

  const send = async (account: { entryId: string } | { username: string; password: string; save: boolean } | { method: "google"; username: string; save: boolean }) => {
    setSending(true);
    setMessage(null);
    try {
      const { result, error } = await api.taskBrowserLogin(taskId, tab.id, account);
      setPassword("");
      setMessage(result === "failed" && error ? t.vault.prompt.failedWith(error) : OUTCOME[result] ?? null);
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const off = busy || sending;
  return (
    <div className="vault-prompt" data-testid="vault-prompt">
      <p className="task-browser-reason">{t.vault.prompt.reasonBefore}<strong>{site}</strong>{t.vault.prompt.reasonAfter}</p>
      {saved.length > 0 && <div className="vault-saved">
        {saved.map((e) => <button key={e.id} type="button" className="primary tiny" disabled={off} onClick={() => void send({ entryId: e.id })}>{e.method === "google" ? (e.username ? t.vault.prompt.useGoogleAs(e.username) : t.vault.prompt.useGoogle) : t.vault.prompt.useAccount(e.username || t.vault.prompt.savedAccount)}</button>)}
      </div>}
      <form className="vault-form" onSubmit={(e) => { e.preventDefault(); if (password) void send({ username, password, save }); }}>
        <label className="field"><span>{t.vault.form.account}</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={t.vault.form.accountPlaceholder} /></label>
        <label className="field"><span>{t.vault.form.password}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={t.vault.prompt.passwordPlaceholder} /></label>
        <label className="vault-save tiny"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {t.vault.prompt.saveToVault}</label>
        <div className="task-actions">
          <button type="submit" className="primary tiny" disabled={off || !password}>{sending ? t.vault.prompt.filling : t.vault.prompt.fillAndSignIn}</button>
          <button type="button" className="ghost tiny" disabled={off} onClick={() => void send({ method: "google", username: username.trim(), save })} title={t.vault.prompt.googleHint}>{t.vault.prompt.useGoogle}</button>
          <button type="button" className="ghost tiny" disabled={off} onClick={onManual}>{t.vault.prompt.manual}</button>
        </div>
      </form>
      {message && <p className="task-browser-hint" role="status">{message}</p>}
    </div>
  );
}
