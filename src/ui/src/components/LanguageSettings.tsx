import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";

/** Available before sign-in and to members, without owner settings access. */
export function LanguagePicker({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  return <label className={compact ? "language-picker" : "field"}>
    <span>{t.settings.language.title}</span>
    <select aria-label={t.settings.language.title} value={locale} disabled={disabled} onChange={event => setLocale(event.target.value as Locale)}>
      {Object.entries(LOCALES).map(([id, messages]) => <option key={id} value={id} lang={id}>{messages.settings.language.name}</option>)}
    </select>
  </label>;
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
