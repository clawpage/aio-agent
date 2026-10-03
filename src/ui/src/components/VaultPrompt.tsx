import { useEffect, useState } from "react";
import { api } from "../api";
import type { TaskTab, VaultEntry } from "../types";

const OUTCOME: Record<string, string> = {
  no_form: "页面上没找到账号密码输入框，AI 会先把登录表单打开。",
  username_only: "账号已填入，等密码框出现后会再问一次。",
  failed: "没能填进这个页面，可以改为自己输入。",
};

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

  const send = async (account: { entryId: string } | { username: string; password: string; save: boolean }) => {
    setSending(true);
    setMessage(null);
    try {
      const { result } = await api.taskBrowserLogin(taskId, tab.id, account);
      setPassword("");
      setMessage(OUTCOME[result] ?? null);
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
      <p className="task-browser-reason">需要登录 <strong>{site}</strong>。在密码器里填一次，AI 只负责把它填进页面，看不到密码。</p>
      {saved.length > 0 && <div className="vault-saved">
        {saved.map((e) => <button key={e.id} type="button" className="primary tiny" disabled={off} onClick={() => void send({ entryId: e.id })}>用 {e.username || "已保存的账号"} 登录</button>)}
      </div>}
      <form className="vault-form" onSubmit={(e) => { e.preventDefault(); if (password) void send({ username, password, save }); }}>
        <label className="field"><span>账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="用户名 / 邮箱 / 手机号" /></label>
        <label className="field"><span>密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="只发给这个网站的登录页" /></label>
        <label className="vault-save tiny"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> 存进密码器，下次自动登录</label>
        <div className="task-actions">
          <button type="submit" className="primary tiny" disabled={off || !password}>{sending ? "正在填入…" : "填入并登录"}</button>
          <button type="button" className="ghost tiny" disabled={off} onClick={onManual}>跳过，自己在浏览器里输入</button>
        </div>
      </form>
      {message && <p className="task-browser-hint" role="status">{message}</p>}
    </div>
  );
}
