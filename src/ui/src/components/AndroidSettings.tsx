import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DeviceLink } from "../types";
import { locale, t } from "../i18n";
import { askDeviceTools, hasDeviceTools, listenDeviceTools, type NativeTools } from "../deviceTools";

const day = (ms: number) => new Date(ms).toLocaleDateString(locale);

/** Whether the configuration page offers the Android entry: inside the Android app, or once the account linked one. */
export function useAndroidEntry(): boolean {
  const inApp = hasDeviceTools("android");
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    if (inApp) return;
    let live = true;
    api.deviceLinks("android").then((r) => { if (live) setLinked(r.links.length > 0); }, () => undefined);
    return () => { live = false; };
  }, [inApp]);
  return inApp || linked;
}

/**
 * The configuration page's Android phone (DeviceTools.kt in the app): its browser and the app's folder for
 * the agent. Inside the Android app: one switch; on links this phone to the signed-in account, off removes
 * the link. Anywhere: the Android phones this account linked, which it can remove. Hidden in a browser for
 * an account that never linked one.
 */
export function AndroidSettings() {
  const inApp = hasDeviceTools("android");
  const [native, setNative] = useState<NativeTools | null>(null);
  const [links, setLinks] = useState<DeviceLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setLinks((await api.deviceLinks("android")).links); } catch { setLinks((l) => l ?? []); }
  }, []);
  useEffect(() => {
    void load();
    if (inApp) void askDeviceTools({ type: "status" }).then(setNative, () => undefined);
  }, [inApp, load]);
  useEffect(() => inApp ? listenDeviceTools((next) => {
    setNative(next);
    if (next.state === "online" || next.state === "revoked") void load();
  }) : undefined, [inApp, load]);

  const thisPhone = native?.linked && native.linkId && links?.some((l) => l.id === native.linkId) ? native.linkId : null;

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) {
        const session = await api.session();
        if (!session.username || !native) throw new Error(t.app.android.failed);
        const created = await api.createDeviceLink(native.name, "android");
        setNative(await askDeviceTools({ type: "link", token: created.token, linkId: created.link.id, account: session.username }));
      } else {
        if (thisPhone) await api.deleteDeviceLink(thisPhone);
        setNative(await askDeviceTools({ type: "unlink" }));
      }
      await load();
    } catch {
      setError(t.app.android.failed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api.deleteDeviceLink(id);
      if (id === thisPhone) setNative(await askDeviceTools({ type: "unlink" }));
      await load();
    } catch {
      setError(t.app.android.failed);
    }
  };

  if (!inApp && !links?.length) return null;
  if (inApp && !native) return null;
  const others = (links ?? []).filter((l) => l.id !== thisPhone);

  return (
    <section className="settings-card" aria-label={t.app.android.label}>
      <div className="settings-section-head">
        <h3>{t.app.android.label}</h3>
        <p>{inApp ? t.app.android.description : t.app.android.descriptionWeb}</p>
      </div>
      {inApp && native && <ul className="iphone-abilities">
        <li>
          <label className="debug-toggle">
            <input type="checkbox" checked={Boolean(thisPhone)} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />
            <span>{t.app.android.toggle}</span>
          </label>
          <span className="muted tiny">{t.app.android.hint}</span>
        </li>
      </ul>}
      {inApp && thisPhone && native && <p className="muted tiny" role="status">{t.app.android.state[native.state]} · {t.app.android.foreground}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {others.length > 0 && <ul className="invite-list">
        {others.map((l) => (
          <li key={l.id}>
            <div className="invite-main">
              <strong>{l.name || t.app.android.unnamed}</strong>
              <span className="muted tiny" role="status">
                {l.online ? t.app.android.online : l.lastSeenAt ? t.app.android.lastSeen(day(l.lastSeenAt)) : t.app.android.neverSeen} · {t.app.android.linkedOn(day(l.createdAt))}
              </span>
            </div>
            <div className="invite-actions">
              <button type="button" className="link danger-text" onClick={() => void remove(l.id)}>{t.app.android.remove}</button>
            </div>
          </li>
        ))}
      </ul>}
    </section>
  );
}
