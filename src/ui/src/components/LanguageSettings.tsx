import { useEffect, useState } from "react";
import { AccountPrivacySettings } from "./Support";
import { PushSettings } from "./PushSettings";
import { IphoneSettings, useIphoneEntry } from "./IphoneSettings";
import { SettingsPages, type SettingsSection } from "./SettingsLayout";
import { ProfileSettings } from "./ProfileSettings";
import type { Profile } from "../types";
import { api } from "../api";
import { InlineLoading } from "./Brand";
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

/**
 * A member's share of today's tokens, as a share only; when used up, when it comes back (src/control/quota.ts).
 * The card is there from the start; only its figure waits on the answer (a dash if none comes).
 */
function QuotaSettings() {
  const [quota, setQuota] = useState<{ percent: number; resetsAt: number } | null | undefined>(undefined);
  useEffect(() => { void api.quota().then(q => setQuota(q.limited ? q : null), () => setQuota(null)); }, []);
  return <section className="settings-card" aria-label={t.settings.quota.title}>
    <div className="settings-section-head"><h3>{t.settings.quota.title}</h3></div>
    <div className="quota-meter"><progress max={100} value={quota?.percent ?? 0} aria-label={t.settings.quota.title}/>
      {quota === undefined ? <InlineLoading label={t.common.loading}/> : <strong>{quota ? `${quota.percent}%` : "—"}</strong>}</div>
    {quota && quota.percent >= 100 && <p className="muted tiny" role="status">{t.settings.quota.exceeded(new Date(quota.resetsAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</p>}
  </section>;
}

/** Member account controls: this component never requests owner settings. */
export function MemberSettings({ section, onOpen, onBack, onProfile }: { section?: string; onOpen: (section?: string) => void; onBack: () => void; onProfile?: (profile: Profile) => void }) {
  const iphone = useIphoneEntry();
  const sections: SettingsSection[] = [
    { id: "profile", title: t.profile.title, page: () => <ProfileSettings onSaved={onProfile}/> },
    ...(iphone ? [{ id: "iphone", title: t.app.iphone.label, page: () => <IphoneSettings/> }] : []),
    { id: "account", title: t.support.account, page: () => <AccountPrivacySettings/> },
  ];
  return <SettingsPages sections={sections} section={section} onOpen={onOpen} onBack={onBack} top={<QuotaSettings/>} switches={<><PushSettings/><LanguageSettings/></>}/>;
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
