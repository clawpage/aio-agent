import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DeviceLink } from "../types";
import { locale, t } from "../i18n";
import { hasDeviceLink, linkThisMac, listenDeviceLink, unlinkThisMac, type NativeLink } from "../deviceLink";

const day = (ms: number) => new Date(ms).toLocaleDateString(locale);

/**
 * Phones and Chrome on a Mac (the workspace's Phone app): the Macs this account linked, and,
 * inside the Mac app, the switch that links this one. Every account sees only its
 * own links. `onChange` is told when a link appears, connects or goes.
 */
export function MacPhoneLinks({ onChange }: { onChange?: () => void }) {
  const inApp = hasDeviceLink();
  const [links, setLinks] = useState<DeviceLink[] | null>(null);
  const [native, setNative] = useState<NativeLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setLinks((await api.deviceLinks()).links); }
    catch (err) { setError(err instanceof Error ? err.message : t.phone.link.loadFailed); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The app reports its bridge; a change in the connection shows in the list too.
  useEffect(() => inApp ? listenDeviceLink((next) => {
    setNative(next);
    if (next.state === "online" || next.state === "revoked") { void load(); onChange?.(); }
  }) : undefined, [inApp, load, onChange]);

  const thisMac = native?.linkId && links?.some((l) => l.id === native.linkId) ? native.linkId : null;

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createDeviceLink(native?.name ?? "");
      linkThisMac(created.token, created.link.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.phone.link.linkFailed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api.deleteDeviceLink(id);
      if (id === native?.linkId) unlinkThisMac();
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.phone.link.removeFailed);
    }
  };

  const stateText = (l: DeviceLink) => {
    if (l.id === thisMac && native) return t.phone.link.state[native.state] + (native.detail ? ` · ${native.detail}` : "");
    return l.online ? t.phone.link.online : l.lastSeenAt ? t.phone.link.lastSeen(day(l.lastSeenAt)) : t.phone.link.neverSeen;
  };

  return (
    <section className="phone-links invite-settings" aria-label={t.phone.link.title}>
      <div className="settings-section-head">
        <h3>{t.phone.link.title}</h3>
        <p>{inApp ? t.phone.link.introApp : t.phone.link.introWeb}</p>
      </div>
      {inApp && !thisMac && (
        <div className="invite-new">
          <button type="button" className="primary" disabled={busy || !native} onClick={() => void link()}>{busy ? t.phone.link.linking : t.phone.link.link}</button>
        </div>
      )}
      {inApp && thisMac && <p className="muted tiny" role="note">{t.phone.link.usbHint}</p>}
      {inApp && thisMac && <p className="muted tiny" role="note">{t.phone.link.browserHint}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {links && links.length === 0 && <p className="muted tiny">{t.phone.link.empty}</p>}
      {links && links.length > 0 && (
        <ul className="invite-list">
          {links.map((l) => (
            <li key={l.id}>
              <div className="invite-main">
                <strong>{l.name || t.phone.link.unnamed}{l.id === thisMac ? ` ${t.phone.link.thisMac}` : ""}</strong>
                <span className="muted tiny" role="status">{stateText(l)} · {t.phone.link.linkedOn(day(l.createdAt))}</span>
              </div>
              <div className="invite-actions">
                <button type="button" className="link danger-text" onClick={() => void remove(l.id)}>{t.phone.link.remove}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
