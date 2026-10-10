import { useDebugMode } from "../debugMode";
import { t } from "../i18n";

/** Owner-only debug switch (this browser only): shows the dispatch log of each message in the main session. */
export function DebugSettings() {
  const [on, setOn] = useDebugMode();
  return (
    <section className="settings-card debug-settings" aria-label={t.app.debug.title}>
      <div className="settings-section-head">
        <h3>{t.app.debug.title}</h3>
        <p>{t.app.debug.description}</p>
      </div>
      <label className="debug-toggle">
        <input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} />
        <span>{on ? t.app.debug.on : t.app.debug.off}</span>
      </label>
    </section>
  );
}
