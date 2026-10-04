import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Invite } from "../types";

const day = (ms: number) => new Date(ms).toLocaleDateString();

function stateOf(i: Invite): string {
  if (i.usedAt !== null) return `已被 ${i.usedBy ?? "已删除账号"} 使用 · ${day(i.usedAt)}`;
  if (i.revokedAt !== null) return `已作废 · ${day(i.revokedAt)}`;
  return `未使用 · ${day(i.createdAt)} 生成`;
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
    catch (err) { setError(err instanceof Error ? err.message : "读取失败"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(code); }
    catch { setError("复制失败，请手动选中邀请码"); }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createInvite(note);
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setError(null);
    try { await api.revokeInvite(code); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "作废失败"); }
  };

  return (
    <section className="settings-card invite-settings" aria-label="邀请码">
      <div className="settings-section-head">
        <h3>邀请码</h3>
        <p>别人在登录页用邀请码注册普通账号，每个邀请码只能注册一个。备注可以写申请人的邮箱，方便对上是谁用的。</p>
      </div>
      <form className="invite-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选），例如申请人邮箱" maxLength={200} aria-label="备注" />
        <button type="submit" className="primary" disabled={busy}>{busy ? "生成中…" : "生成邀请码"}</button>
      </form>
      {error && <p className="banner error" role="alert">{error}</p>}
      {invites && invites.length === 0 && <p className="muted tiny">还没有生成过邀请码。</p>}
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
                    <button type="button" className="ghost" onClick={() => void copy(i.code)}>{copied === i.code ? "已复制" : "复制"}</button>
                    <button type="button" className="link danger-text" onClick={() => void revoke(i.code)}>作废</button>
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
