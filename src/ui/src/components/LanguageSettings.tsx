import { useEffect, useState } from "react";
import { AccountPrivacySettings } from "./Support";
import { PushSettings } from "./PushSettings";
import { IphoneSettings } from "./IphoneSettings";
import { api } from "../api";
import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";

/** The account remembers the choice too (scheduled runs and the voice gadget answer in it); the switch never waits on that. */
function chooseLocale(next: Locale) {
  if (next !== locale) void api.setAccountLocale(next).catch(() => undefined);
  setLocale(next);
}

/** Shared by owner and member configuration pages. */
export function LanguagePicker() {
  return <label className="field">
    <span>{t.settings.language.title}</span>
    <select aria-label={t.settings.language.title} value={locale} onChange={event => chooseLocale(event.target.value as Locale)}>
      {Object.entries(LOCALES).map(([id, messages]) => <option key={id} value={id} lang={id}>{messages.settings.language.name}</option>)}
    </select>
  </label>;
}

/** A member's share of today's tokens, as a share only; when used up, when it comes back (src/control/quota.ts). */
function QuotaSettings() {
  const [quota, setQuota] = useState<{ percent: number; resetsAt: number } | null>(null);
  useEffect(() => { void api.quota().then(q => { if (q.limited) setQuota(q); }, () => undefined); }, []);
  if (!quota) return null;
  return <section className="settings-card" aria-label={t.settings.quota.title}>
    <div className="settings-section-head"><h3>{t.settings.quota.title}</h3></div>
    <div className="quota-meter"><progress max={100} value={quota.percent} aria-label={t.settings.quota.title}/><strong>{quota.percent}%</strong></div>
    {quota.percent >= 100 && <p className="muted tiny" role="status">{t.settings.quota.exceeded(new Date(quota.resetsAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</p>}
  </section>;
}

/** Member account controls: this component never requests owner settings. */
export function MemberSettings({ onBack }: { onBack: () => void }) {
  return <section className="settings" aria-label={t.settings.page.title}>
    <header className="settings-head"><h2>{t.settings.page.title}</h2><span className="spacer"/><button type="button" className="ghost" onClick={onBack}>{t.settings.page.back}</button></header>
    <div className="settings-body"><QuotaSettings/><PushSettings/><IphoneSettings/><LanguageSettings/><AccountPrivacySettings/></div>
  </section>;
}

/** The console's language (this browser only): each choice is named in its own language. */
export function LanguageSettings() {
  return (
    <section className="settings-card" aria-label={t.settings.language.title}>
      <div className="settings-section-head">
        <h3>{t.settings.language.title}</h3>
        <p>{t.settings.language.description}</p>
      </div>
      <LanguagePicker />
    </section>
  );
}
