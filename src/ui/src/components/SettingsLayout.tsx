import { useRef, type ReactNode } from "react";
import { t } from "../i18n";
import { useSwipeBack } from "../useSwipeBack";

/** One configuration page behind an entry: its title, its content, and the way back to the entries. */
export interface SettingsSection {
  id: string;
  title: string;
  /** A word after the title in the entry, such as the file it edits. */
  note?: string;
  page: () => ReactNode;
}

/**
 * The configuration page: its entries, each opening a page of its own at `/settings/<id>`, and the
 * switches that need no page (`switches`), then signing out and the console's version. An unknown
 * section shows the entries.
 */
export function SettingsPages({ sections, section, onOpen, onBack, onLogout, top, switches }: {
  sections: SettingsSection[];
  section?: string;
  onOpen: (section?: string) => void;
  onBack: () => void;
  onLogout: () => void;
  /** Above the entries (a member's share of today's tokens). */
  top?: ReactNode;
  switches: ReactNode;
}) {
  const open = sections.find((s) => s.id === section);
  const page = useRef<HTMLElement>(null);
  // On a phone the page behind an entry goes back the way an app's page does.
  useSwipeBack({ enabled: !!open && matchMedia("(max-width: 900px)").matches, page, onBack: () => onOpen() });
  if (open) {
    // Not a named region: the card inside already is, under the same name.
    return <section ref={page} className="settings settings-subpage">
      <header className="settings-head"><h2>{open.title}</h2><span className="spacer"/><button type="button" className="ghost" onClick={() => onOpen()}>{t.settings.page.backToSettings}</button></header>
      <div className="settings-body">{open.page()}</div>
    </section>;
  }
  return <section className="settings" aria-label={t.settings.page.title}>
    <header className="settings-head"><h2>{t.settings.page.title}</h2><span className="spacer"/><button type="button" className="ghost" onClick={onBack}>{t.settings.page.back}</button></header>
    <div className="settings-body">
      {top}
      <nav className="settings-card settings-entries" aria-label={t.settings.page.entries}>
        {sections.map((s) => <button type="button" key={s.id} className="settings-entry" onClick={() => onOpen(s.id)}>
          <span>{s.title}{s.note && <span className="settings-file-label">{s.note}</span>}</span>
          <span className="settings-entry-chevron" aria-hidden="true">›</span>
        </button>)}
      </nav>
      {switches}
      <div className="settings-card settings-entries"><button type="button" className="settings-entry settings-logout" onClick={onLogout}>{t.nav.logout}</button></div>
      <p className="settings-version muted tiny">{t.settings.page.version(String(import.meta.env.VITE_AIO_UI_VERSION ?? "dev"))}</p>
    </div>
  </section>;
}
