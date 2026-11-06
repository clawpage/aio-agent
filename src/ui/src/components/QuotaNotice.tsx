import { useEffect, useState } from "react";
import { api } from "../api";
import { locale, t } from "../i18n";

/** Shown from this share of a member's daily tokens on (src/control/quota.ts). */
const NEAR = 90;
const DISMISS_KEY = "aio.quotaNotice";

/**
 * Above the main session's composer once a member has used 90% of the day's free tokens, and again
 * once they are used up: how much, and when the day turns over. Put away, it stays away for that
 * day and level. Asked again whenever `checkKey` changes (a task finishing spends tokens).
 */
export function QuotaNotice({ checkKey }: { checkKey: string }) {
  const [quota, setQuota] = useState<{ percent: number; resetsAt: number } | null>(null);
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISS_KEY); } catch { return null; } });
  useEffect(() => { void api.quota().then(q => setQuota(q.limited ? q : null), () => undefined); }, [checkKey]);
  if (!quota || quota.percent < NEAR) return null;
  const level = `${quota.resetsAt}:${quota.percent >= 100 ? "used" : "near"}`;
  if (dismissed === level) return null;
  const at = new Date(quota.resetsAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, level); } catch { /* storage unavailable: it goes away for this page only */ }
    setDismissed(level);
  };
  return <div className="banner quota-notice" role="status">
    <span>{quota.percent >= 100 ? t.feed.quota.used(at) : t.feed.quota.near(quota.percent, at)}</span>
    <button type="button" onClick={dismiss}>{t.feed.quota.ok}</button>
  </div>;
}
