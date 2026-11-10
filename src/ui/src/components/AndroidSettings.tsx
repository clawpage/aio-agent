import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DeviceLink } from "../types";
import { locale, t } from "../i18n";
import { ANDROID_ABILITIES, askDeviceTools, hasDeviceTools, listenDeviceTools, type Ability, type NativeTools, type PhoneControl, type SharedPhoto } from "../deviceTools";

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
 * The configuration page's Android phone (DeviceTools.kt in the app). Inside the Android app: a switch for its
 * browser and the app's folder, which links this phone to the signed-in account (off removes the link and turns
 * everything off), and one per ability, as on the iPhone: the calendar (Android asks for the permission then)
 * and the photos the person picks for the agent in the system photo picker, listed here to add to or remove
 * from. An ability turned on before the phone is linked links it. Anywhere: the Android phones this account
 * linked, which it can remove. Hidden in a browser for an account that never linked one.
 */
export function AndroidSettings() {
  const inApp = hasDeviceTools("android");
  const [native, setNative] = useState<NativeTools | null>(null);
  const [links, setLinks] = useState<DeviceLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<SharedPhoto[] | null>(null);

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

  const refreshNative = useCallback(() => { if (inApp) void askDeviceTools({ type: "status" }).then(setNative, () => undefined); }, [inApp]);
  // Back from the phone's settings, where the calendar may have just been allowed.
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") refreshNative(); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [refreshNative]);

  const thisPhone = native?.linked && native.linkId && links?.some((l) => l.id === native.linkId) ? native.linkId : null;
  const sharing = Boolean(native?.abilities.photos?.enabled);
  useEffect(() => {
    if (!sharing) { setPhotos(null); return; }
    void askDeviceTools({ type: "photosShared" }).then((next) => setPhotos(next.photos ?? []), () => undefined);
  }, [sharing, native?.abilities.photos?.shared]);

  /** This phone's own link, for the account signed in here: what the app answers with it. */
  const linkThisPhone = async (name: string) => {
    const session = await api.session();
    if (!session.username) throw new Error(t.app.android.failed);
    const created = await api.createDeviceLink(name, "android");
    const next = await askDeviceTools({ type: "link", token: created.token, linkId: created.link.id, account: session.username });
    await load();
    return next;
  };

  /** Runs one change and shows the state after it; anything that fails says so and reads the app's state again. */
  const change = async (work: () => Promise<NativeTools>) => {
    setBusy(true);
    setError(null);
    try {
      setNative(await work());
    } catch {
      setError(t.app.android.failed);
      refreshNative();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (on: boolean) => change(async () => {
    if (on) return linkThisPhone(native!.name);
    if (thisPhone) await api.deleteDeviceLink(thisPhone);
    const next = await askDeviceTools({ type: "unlink" });
    await load();
    return next;
  });

  const toggleAbility = (ability: Ability, on: boolean) => change(async () => {
    const next = await askDeviceTools({ type: on ? "enable" : "disable", ability });
    return on && next.abilities[ability]?.enabled && !thisPhone ? linkThisPhone(next.name) : next;
  });

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
          <span className="muted tiny">{t.app.android.filesApp}</span>
        </li>
        {ANDROID_ABILITIES.map((ability) => {
          const { enabled = false, permission = "notDetermined", shared = 0 } = native.abilities[ability] ?? {};
          const label = ability === "photos" ? t.app.android.abilities.photos : t.app.android.abilities.calendar;
          return <li key={ability}>
            <label className="debug-toggle">
              <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => void toggleAbility(ability, event.target.checked)} />
              <span>{label}</span>
            </label>
            <span className="muted tiny">{ability === "photos" ? t.app.android.hints.photos : t.app.android.hints.calendar}</span>
            {ability === "calendar" && (enabled || permission === "denied") && <span className="muted tiny" role="status">{t.app.android.permission[permission === "authorized" || permission === "denied" ? permission : "notDetermined"]}</span>}
            {ability === "calendar" && permission === "denied" && <button type="button" onClick={() => void askDeviceTools({ type: "settings" })}>{t.app.android.openSettings}</button>}
            {ability === "photos" && enabled && <>
              <span className="muted tiny" role="status">{shared ? t.app.android.photosShared(shared) : t.app.android.photosNone}</span>
              {photos && photos.length > 0 && <ul className="android-photos">
                {photos.map((p) => <li key={p.id}>
                  {p.thumb ? <img src={p.thumb} alt={p.video ? t.app.android.videoAlt : t.app.android.photoAlt} /> : <span className="android-photo-blank" />}
                  <button type="button" className="link danger-text" disabled={busy} onClick={() => void change(() => askDeviceTools({ type: "photosRemove", ids: [p.id] }))}>{t.app.android.photosRemove}</button>
                </li>)}
              </ul>}
              <button type="button" disabled={busy} onClick={() => void change(() => askDeviceTools({ type: "photosAdd" }))}>{t.app.android.photosAdd}</button>
            </>}
          </li>;
        })}
        {native.control && <PhoneControlItem control={native.control} busy={busy} act={(action) => void change(() => askDeviceTools({ type: "control", action }))} />}
      </ul>}
      {inApp && thisPhone && native && <p className="muted tiny" role="status">{t.app.android.state[native.state]}{native.control?.state === "running" ? "" : ` · ${t.app.android.foreground}`}</p>}
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

/**
 * The side-loaded app's other apps and screen (PhoneControl.kt): paired once with the phone's own wireless debugging
 * (the code goes into the app's notification), then started and stopped here or from that notification. The Play
 * app has none, and says nothing of it.
 */
function PhoneControlItem({ control, busy, act }: { control: PhoneControl; busy: boolean; act: (action: "pair" | "start" | "stop") => void }) {
  const words = t.app.android.control;
  const running = control.state === "running";
  return (
    <li aria-label={words.title}>
      <strong>{words.title}</strong>
      <span className="muted tiny">{words.description}</span>
      {!control.paired && <span className="muted tiny">{words.steps}</span>}
      <span className="muted tiny" role="status">{words.state[control.state]}</span>
      {control.error && <p className="banner error" role="alert">{words.errors[control.error]}</p>}
      <div className="invite-actions">
        {!control.paired && <button type="button" disabled={busy || control.state === "connecting"} onClick={() => act("pair")}>{words.pair}</button>}
        {control.paired && !running && <button type="button" disabled={busy || control.state === "connecting"} onClick={() => act("start")}>{words.start}</button>}
        {running && <button type="button" disabled={busy} onClick={() => act("stop")}>{words.stop}</button>}
      </div>
    </li>
  );
}
