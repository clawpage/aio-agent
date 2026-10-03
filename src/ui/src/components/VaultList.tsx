import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { VaultEntry } from "../types";

interface Draft { id: string | null; site: string; method: "password" | "google"; username: string; password: string; wasGoogle: boolean }

/**
 * The password vault: the accounts the agent may sign in with. A password is
 * shown only after the person asks for that one, and is forgotten again when the
 * page is hidden or left.
 */
export function VaultList({ active, onExpired }: { active: boolean; onExpired: () => void }) {
  const [items, setItems] = useState<VaultEntry[] | null>(null);
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
    try { setItems((await api.vault()).entries); setError(null); }
    catch (err) { fail(err, "读取失败"); }
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
    catch (err) { fail(err, "读取失败"); }
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
    } catch (err) { fail(err, "保存失败"); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try { await api.vaultDelete(id); setConfirm(null); await load(); }
    catch (err) { fail(err, "删除失败"); }
    finally { setBusy(false); }
  };

  return <section className="schedule-page vault-page" aria-label="密码器">
    <header className="chat-head"><div className="chat-title"><h2>密码器</h2><span className="task-list-sub muted tiny">{items ? `${items.length} 个账号` : "正在读取…"}</span></div></header>
    <div className="task-list-scroll">
      <p className="schedule-hint muted tiny">AI 遇到登录页时会用这里保存的账号登录：密码由系统直接填进对应网站的页面，AI 看不到；记成「Google 登录」的网站不存密码，AI 会点网站的 Google 登录按钮，用浏览器里已登录的 Google 账号。没保存过的网站会在任务卡片上请你填一次，也可以跳过、自己在浏览器里输入。一个账号只会填进它保存时的网站及其子域名。</p>
      {error && <p className="banner error" role="alert">{error}</p>}
      {!draft && <div className="schedule-actions vault-add"><button type="button" className="ghost tiny" onClick={() => setDraft({ id: null, site: "", method: "password", username: "", password: "", wasGoogle: false })}>添加账号</button></div>}
      {draft && <form className="vault-form vault-edit" aria-label={draft.id ? "修改账号" : "添加账号"} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field"><span>网站</span><input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} autoCapitalize="none" spellCheck={false} placeholder="例如 github.com" /></label>
        <label className="field"><span>登录方式</span><select value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as Draft["method"] })}><option value="password">账号密码</option><option value="google">用 Google 登录</option></select></label>
        <label className="field"><span>{draft.method === "google" ? "Google 账号（可不填）" : "账号"}</span><input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={draft.method === "google" ? "例如 max@gmail.com，不填就用浏览器里登录的" : "用户名 / 邮箱 / 手机号"} /></label>
        {draft.method === "password" && <label className="field"><span>密码</span><input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} autoComplete="new-password" placeholder={draft.id && !draft.wasGoogle ? "不改就留空" : ""} /></label>}
        <div className="schedule-actions">
          <button type="submit" className="primary tiny" disabled={busy || !draft.site.trim() || (draft.method === "password" && (!draft.id || draft.wasGoogle) && !draft.password)}>保存</button>
          <button type="button" className="ghost tiny" onClick={() => setDraft(null)}>取消</button>
        </div>
      </form>}
      {items && !items.length && !draft && <div className="empty"><h3>还没有保存账号</h3><p>在这里添加，或等 AI 遇到登录页时在任务卡片上填写。</p></div>}
      <ul className="task-list">{(items ?? []).map((e) => <li key={e.id} data-vault-id={e.id}>
        <div className="task-list-item schedule-item">
          <div className="task-list-top"><strong>{e.site}</strong><span className="muted tiny">{e.lastUsedAt ? `上次使用 ${new Date(e.lastUsedAt).toLocaleDateString("zh-CN")}` : "还没用过"}</span></div>
          {e.method === "google"
            ? <p className="vault-row"><span className="muted tiny">方式</span><span className="vault-value vault-google">用 Google 登录{e.username ? `（${e.username}）` : "（浏览器里已登录的账号）"}</span></p>
            : <>
              <p className="vault-row"><span className="muted tiny">账号</span><span className="vault-value">{e.username || "（未填）"}</span></p>
              <p className="vault-row"><span className="muted tiny">密码</span><span className="vault-value" data-testid="vault-password">{shown[e.id] ?? "••••••••"}</span></p>
            </>}
          {confirm === e.id
            ? <div className="schedule-actions" role="alert"><span className="tiny">删除后 AI 不能再用它登录。</span><button className="ghost tiny" onClick={() => setConfirm(null)}>取消</button><button className="danger tiny" disabled={busy} onClick={() => void remove(e.id)}>确认删除</button></div>
            : <div className="schedule-actions">
              {e.method === "password" && <button className="ghost tiny" onClick={() => void toggle(e)}>{shown[e.id] !== undefined ? "隐藏密码" : "显示密码"}</button>}
              <button className="ghost tiny" onClick={() => setDraft({ id: e.id, site: e.site, method: e.method, username: e.username, password: "", wasGoogle: e.method === "google" })}>修改</button>
              <button className="ghost tiny" onClick={() => setConfirm(e.id)}>删除</button>
            </div>}
        </div>
      </li>)}</ul>
    </div>
  </section>;
}
