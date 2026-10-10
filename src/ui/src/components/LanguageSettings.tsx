import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";

/** The console's language (this browser only): each choice is named in its own language. */
export function LanguageSettings() {
  return (
    <section className="settings-card" aria-label={t.settings.language.title}>
      <div className="settings-section-head">
        <h3>{t.settings.language.title}</h3>
        <p>{t.settings.language.description}</p>
      </div>
      <label className="field">
        <span>{t.settings.language.title}</span>
        <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          {Object.entries(LOCALES).map(([id, messages]) => <option key={id} value={id} lang={id}>{messages.settings.language.name}</option>)}
        </select>
      </label>
    </section>
  );
}
