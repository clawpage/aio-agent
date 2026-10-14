import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DeviceLink } from "../types";
import { t } from "../i18n";
import { hasDeviceLink, linkThisMac, listenDeviceLink, unlinkThisMac, type NativeLink } from "../deviceLink";

const day = (ms: number) => new Date(ms).toLocaleDateString();

/**
 * Phones on a Mac: the Macs this account linked, and, inside the Mac app, the
 * switch that links this one. Every account sees only its own links.
 */
export function DeviceLinkSettings() {
  const inApp = hasDeviceLink();
  const [links, setLinks] = useState<DeviceLink[] | null>(null);
  const [native, setNative] = useState<NativeLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setLinks((await api.deviceLinks()).links); }
    catch (err) { setError(err instanceof Error ? err.message : t.settings.devices.loadFailed); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The app reports its bridge; a change in the connection shows in the list too.
  useEffect(() => inApp ? listenDeviceLink((next) => { setNative(next); if (next.state === "online" || next.state === "revoked") void load(); }) : undefined, [inApp, load]);

  const thisMac = native?.linkId && links?.some((l) => l.id === native.linkId) ? native.linkId : null;

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createDeviceLink(native?.name ?? "");
      linkThisMac(created.token, created.link.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.devices.linkFailed);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.devices.removeFailed);
    }
  };

  const stateText = (l: DeviceLink) => {
    if (l.id === thisMac && native) return t.settings.devices.state[native.state] + (native.detail ? ` · ${native.detail}` : "");
    return l.online ? t.settings.devices.online : l.lastSeenAt ? t.settings.devices.lastSeen(day(l.lastSeenAt)) : t.settings.devices.neverSeen;
  };

  return (
    <section className="settings-card invite-settings" aria-label={t.settings.devices.title}>
      <div className="settings-section-head">
        <h3>{t.settings.devices.title}</h3>
        <p>{inApp ? t.settings.devices.introApp : t.settings.devices.introWeb}</p>
      </div>
      {inApp && !thisMac && (
        <div className="invite-new">
          <button type="button" className="primary" disabled={busy || !native} onClick={() => void link()}>{busy ? t.settings.devices.linking : t.settings.devices.link}</button>
        </div>
      )}
      {inApp && thisMac && <p className="muted tiny" role="note">{t.settings.devices.usbHint}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {links && links.length === 0 && <p className="muted tiny">{t.settings.devices.empty}</p>}
      {links && links.length > 0 && (
        <ul className="invite-list">
          {links.map((l) => (
            <li key={l.id}>
              <div className="invite-main">
                <strong>{l.name || t.settings.devices.unnamed}{l.id === thisMac ? ` ${t.settings.devices.thisMac}` : ""}</strong>
                <span className="muted tiny" role="status">{stateText(l)} · {t.settings.devices.linkedOn(day(l.createdAt))}</span>
              </div>
              <div className="invite-actions">
                <button type="button" className="link danger-text" onClick={() => void remove(l.id)}>{t.settings.devices.remove}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
