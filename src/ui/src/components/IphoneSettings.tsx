import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DeviceLink } from "../types";
import { locale, t } from "../i18n";
import { ABILITIES, appAtLeast, askDeviceTools, hasDeviceTools, listenDeviceTools, type Ability, type NativeTools } from "../deviceTools";

const day = (ms: number) => new Date(ms).toLocaleDateString(locale);

/** Whether the configuration page offers the iPhone entry: inside the iPhone app, or once the account linked one. */
export function useIphoneEntry(): boolean {
  const inApp = hasDeviceTools("ios");
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
 * links this iPhone to the signed-in account, the last one off removes the link. An app with a browser and
 * a folder of its own (0.1.5, docs/EXEC-ENVS.md), for an account that has the execution environments, has a
 * switch for them first, as the Android page has: it is the link, so on links this iPhone with nothing else
 * on, off removes the link and every ability with it, and the last ability off leaves it. Anywhere: the
 * iPhones this account linked, which it can remove. Hidden in a browser for an account that never linked one.
 */
export function IphoneSettings() {
  const inApp = hasDeviceTools("ios");
  const [native, setNative] = useState<NativeTools | null>(null);
  const [links, setLinks] = useState<DeviceLink[] | null>(null);
  const [envs, setEnvs] = useState(false);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await api.deviceLinks("ios");
      const listed = answer.links;
      setLinks(listed);
      setEnvs(answer.envs === true);
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
  /** The app's own browser and folder have a switch: the app has them, and the account's agent can reach them. */
  const ownBrowser = inApp && envs && appAtLeast(native?.app, "0.1.5");

  /** This iPhone's own link, for the account signed in here: what the app answers with it. */
  const linkThisPhone = async (name: string) => {
    const session = await api.session();
    if (!session.username) throw new Error(t.app.iphone.failed);
    const created = await api.createDeviceLink(name, "ios");
    const next = await askDeviceTools({ type: "link", token: created.token, linkId: created.link.id, account: session.username });
    await load();
    return next;
  };

  const toggleBrowser = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) { setNative(await linkThisPhone(native!.name)); return; }
      if (thisPhone) await api.deleteDeviceLink(thisPhone);
      setNative(await askDeviceTools({ type: "unlink" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.app.iphone.failed);
      refreshNative();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (ability: Ability, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let next = await askDeviceTools({ type: on ? "enable" : "disable", ability });
      // The first ability on: this iPhone gets a link of its own, for the account signed in here.
      if (on && next.abilities[ability]?.enabled && !thisPhone) next = await linkThisPhone(next.name);
      if (!on && !ownBrowser && thisPhone && ABILITIES.every((a) => !next.abilities[a]?.enabled)) {
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
        {ownBrowser && <li>
          <label className="debug-toggle">
            <input type="checkbox" checked={Boolean(thisPhone)} disabled={busy} onChange={(event) => void toggleBrowser(event.target.checked)} />
            <span>{t.app.iphone.browser}</span>
          </label>
          <span className="muted tiny">{t.app.iphone.browserHint}</span>
        </li>}
        {ABILITIES.map((ability) => {
          const { enabled, permission } = native.abilities[ability] ?? { enabled: false, permission: "notDetermined" as const };
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
