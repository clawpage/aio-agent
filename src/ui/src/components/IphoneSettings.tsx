import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DeviceLink } from "../types";
import { locale, t } from "../i18n";
import { ABILITIES, askDeviceTools, hasDeviceTools, listenDeviceTools, type Ability, type NativeTools } from "../deviceTools";

const day = (ms: number) => new Date(ms).toLocaleDateString(locale);

/** Whether the configuration page offers the iPhone entry: inside the iPhone app, or once the account linked one. */
export function useIphoneEntry(): boolean {
  const inApp = hasDeviceTools();
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    if (inApp) return;
    let live = true;
    api.deviceLinks("ios").then((r) => { if (live) setLinked(r.links.length > 0); }, () => undefined);
    return () => { live = false; };
  }, [inApp]);
  return inApp || linked;
}
type Remote = Awaited<ReturnType<typeof api.iosDevice>>;

/**
 * The configuration page's iPhone abilities (iosDevice.ts on the server, DeviceTools.swift in the app).
 * Inside the iPhone app: a switch per ability, which is when iOS asks for the permission; the first one on
 * links this iPhone to the signed-in account, the last one off removes the link. Anywhere: the iPhones
 * this account linked, which it can remove. Hidden in a browser for an account that never linked one.
 */
export function IphoneSettings() {
  const inApp = hasDeviceTools();
  const [native, setNative] = useState<NativeTools | null>(null);
  const [links, setLinks] = useState<DeviceLink[] | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listed = (await api.deviceLinks("ios")).links;
      setLinks(listed);
      if (!inApp && listed.length) setRemote(await api.iosDevice());
    } catch { setLinks((l) => l ?? []); }
  }, [inApp]);
  const refreshNative = useCallback(() => { if (inApp) void askDeviceTools({ type: "status" }).then(setNative, () => undefined); }, [inApp]);
  useEffect(() => { void load(); refreshNative(); }, [load, refreshNative]);
  useEffect(() => inApp ? listenDeviceTools((next) => {
    setNative(next);
    if (next.state === "online" || next.state === "revoked") void load();
  }) : undefined, [inApp, load]);
  // Back from iOS Settings, where a permission may have just been allowed.
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") refreshNative(); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [refreshNative]);

  const thisPhone = native?.linked && native.linkId && links?.some((l) => l.id === native.linkId) ? native.linkId : null;

  const toggle = async (ability: Ability, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let next = await askDeviceTools({ type: on ? "enable" : "disable", ability });
      if (on && next.abilities[ability].enabled && !thisPhone) {
        // The first ability on: this iPhone gets a link of its own, for the account signed in here.
        const session = await api.session();
        if (!session.username) throw new Error(t.app.iphone.failed);
        const created = await api.createDeviceLink(next.name, "ios");
        next = await askDeviceTools({ type: "link", token: created.token, linkId: created.link.id, account: session.username });
        await load();
      }
      if (!on && thisPhone && ABILITIES.every((a) => !next.abilities[a].enabled)) {
        // Nothing left on: the agent loses this iPhone altogether.
        await api.deleteDeviceLink(thisPhone);
        next = await askDeviceTools({ type: "unlink" });
        await load();
      }
      setNative(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.app.iphone.failed);
      refreshNative();
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t.app.iphone.failed);
    }
  };

  if (!inApp && !links?.length) return null;
  if (inApp && !native) return null;
  const others = (links ?? []).filter((l) => l.id !== thisPhone);
  const enabledNames = remote?.abilities ? ABILITIES.filter((a) => remote.abilities![a].enabled).map((a) => t.app.iphone.abilities[a]).join(t.app.iphone.separator) : "";

  return (
    <section className="settings-card iphone-settings" aria-label={t.app.iphone.label}>
      <div className="settings-section-head">
        <h3>{t.app.iphone.label}</h3>
        <p>{inApp ? t.app.iphone.description : t.app.iphone.descriptionWeb}</p>
      </div>
      {inApp && native && <ul className="iphone-abilities">
        {ABILITIES.map((ability) => {
          const { enabled, permission } = native.abilities[ability];
          const refused = permission === "denied" || permission === "writeOnly";
          return <li key={ability}>
            <label className="debug-toggle">
              <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => void toggle(ability, event.target.checked)} />
              <span>{t.app.iphone.abilities[ability]}</span>
            </label>
            <span className="muted tiny">{t.app.iphone.hints[ability]}</span>
            {(enabled || refused || permission === "limited") && <span className="muted tiny" role="status">{t.app.iphone.permission[permission]}</span>}
            {refused && <button type="button" onClick={() => void askDeviceTools({ type: "settings" })}>{t.app.iphone.openSettings}</button>}
          </li>;
        })}
      </ul>}
      {inApp && thisPhone && native && <p className="muted tiny" role="status">{t.app.iphone.state[native.state]} · {t.app.iphone.background}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {others.length > 0 && <ul className="invite-list">
        {others.map((l) => (
          <li key={l.id}>
            <div className="invite-main">
              <strong>{l.name || t.app.iphone.unnamed}</strong>
              <span className="muted tiny" role="status">
                {l.online ? t.app.iphone.online : l.lastSeenAt ? t.app.iphone.lastSeen(day(l.lastSeenAt)) : t.app.iphone.neverSeen} · {t.app.iphone.linkedOn(day(l.createdAt))}
                {l.online && remote?.reachable && enabledNames ? ` · ${t.app.iphone.enabled(enabledNames)}` : ""}
              </span>
            </div>
            <div className="invite-actions">
              <button type="button" className="link danger-text" onClick={() => void remove(l.id)}>{t.app.iphone.remove}</button>
            </div>
          </li>
        ))}
      </ul>}
    </section>
  );
}
