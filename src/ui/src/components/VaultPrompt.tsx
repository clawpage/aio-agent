import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Task, TaskTab, VaultEntry } from "../types";
import { t } from "../i18n";

const OUTCOME: Record<string, string> = t.vault.prompt.outcome;

/** The tab whose sign-in form the agent handed to the vault, if any. */
function signInTab(tabs: TaskTab[]): TaskTab | null {
  return tabs.find((tab) => tab.request?.kind === "login" && tab.holder === "ai") ?? null;
}

/**
 * A task's agent reached a sign-in form and asked the password vault: a card of
 * its own, beside the task's browser. The person picks a saved account or types
 * one here; it goes straight into the page, and the agent is only told that the
 * form was submitted. Typing it into the page themselves is the browser card's
 * take-over, as for any other request.
 */
export function VaultPrompt({ task }: { task: Task }) {
  const request = task.browser?.request ?? null;
  const [tab, setTab] = useState<TaskTab | null>(null);
  const [saved, setSaved] = useState<VaultEntry[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const site = tab?.request?.site ?? "";

  // The feed only says that the task waits for the person; the tabs say whether it is a sign-in.
  const load = useCallback(async () => {
    try { setTab(signInTab((await api.taskBrowser(task.id)).tabs)); }
    catch { /* A transient failure keeps the last known state. */ }
  }, [task.id]);
  useEffect(() => {
    if (request) void load();
    else setTab(null);
  }, [request, load]);

  useEffect(() => {
    if (!site) return;
    let alive = true;
    api.vault(site).then((r) => { if (alive) setSaved(r.entries); }).catch(() => undefined);
    return () => { alive = false; };
  }, [site]);

  if (!tab) return null;

  const send = async (account: { entryId: string } | { username: string; password: string; save: boolean } | { method: "google"; username: string; save: boolean }) => {
    setSending(true);
    setMessage(null);
    try {
      const { result, error } = await api.taskBrowserLogin(task.id, tab.id, account);
      setPassword("");
      setMessage(result === "failed" && error ? t.vault.prompt.failedWith(error) : OUTCOME[result] ?? null);
      void load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="vault-card" role="group" aria-label={t.vault.prompt.cardLabel(site)} data-testid="vault-prompt">
      <div className="vault-card-head">
        <span className="vault-card-state">{t.vault.prompt.title}</span>
        <span className="vault-card-site">{site}</span>
      </div>
      <p className="vault-card-reason">{t.vault.prompt.reasonBefore}<strong>{site}</strong>{t.vault.prompt.reasonAfter}</p>
      {saved.length > 0 && <div className="vault-saved">
        {saved.map((e) => <button key={e.id} type="button" className="primary tiny" disabled={sending} onClick={() => void send({ entryId: e.id })}>{e.method === "google" ? (e.username ? t.vault.prompt.useGoogleAs(e.username) : t.vault.prompt.useGoogle) : t.vault.prompt.useAccount(e.username || t.vault.prompt.savedAccount)}</button>)}
      </div>}
      <form className="vault-form" onSubmit={(e) => { e.preventDefault(); if (password) void send({ username, password, save }); }}>
        <label className="field"><span>{t.vault.form.account}</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={t.vault.form.accountPlaceholder} /></label>
        <label className="field"><span>{t.vault.form.password}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={t.vault.prompt.passwordPlaceholder} /></label>
        <label className="vault-save tiny"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {t.vault.prompt.saveToVault}</label>
        <div className="task-actions">
          <button type="submit" className="primary tiny" disabled={sending || !password}>{sending ? t.vault.prompt.filling : t.vault.prompt.fillAndSignIn}</button>
          <button type="button" className="ghost tiny" disabled={sending} onClick={() => void send({ method: "google", username: username.trim(), save })} title={t.vault.prompt.googleHint}>{t.vault.prompt.useGoogle}</button>
        </div>
      </form>
      {message && <p className="vault-card-hint" role="status">{message}</p>}
    </div>
  );
}
