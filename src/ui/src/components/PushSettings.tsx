import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { NavIcon } from "./NavIcon";

type State = "loading" | "unsupported" | "install" | "off" | "on" | "denied";

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// A browser on iOS (its name carries "Safari/"), not an app's web view: only a browser can add the console to the home screen.
const iosBrowser = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent);

function keyBytes(base64url: string): ArrayBuffer {
  const raw = atob((base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Phone notifications for this account on this device. iOS offers them only to
 * the console added to the home screen, and only asks for permission from a tap.
 */
function usePush() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!supported()) { setState(iosBrowser() && !standalone() ? "install" : "unsupported"); return; }
    if (Notification.permission === "denied") { setState("denied"); return; }
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    setState(subscription && Notification.permission === "granted" ? "on" : "off");
  }, []);
  useEffect(() => { void refresh().catch(() => setState("unsupported")); }, [refresh]);

  const enable = async () => {
    setBusy(true); setMessage(null);
    try {
      // Ask first, straight from the tap: iOS refuses a prompt that follows other awaits.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState(permission === "denied" ? "denied" : "off"); return; }
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushInfo();
      if (!publicKey) throw new Error(t.app.push.unavailable);
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await api.pushSubscribe(subscription.toJSON());
      setState("on");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t.app.push.enableFailed);
    } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true); setMessage(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) { await api.pushUnsubscribe(subscription.endpoint); await subscription.unsubscribe(); }
      setState("off");
    } catch (err) { setMessage(err instanceof Error ? err.message : t.app.push.disableFailed); } finally { setBusy(false); }
  };
  return { state, busy, message, enable, disable };
}

/** The configuration page's switch; hidden where the device cannot receive notifications at all. */
export function PushSettings() {
  const { state, busy, message, enable, disable } = usePush();
  if (state === "loading" || state === "unsupported") return null;
  return (
    <section className="settings-card" aria-label={t.app.push.label}>
      <div className="settings-section-head">
        <h3>{t.app.push.label}</h3>
        <p>{t.app.push.description}</p>
      </div>
      {state === "install" && <p className="muted tiny">{t.app.push.install}</p>}
      {state === "denied" && <p className="muted tiny">{t.app.push.denied}</p>}
      {(state === "on" || state === "off") && <label className="debug-toggle">
        <input type="checkbox" checked={state === "on"} disabled={busy} onChange={(event) => void (event.target.checked ? enable() : disable())} />
        <span>{state === "on" ? t.app.push.on : t.app.push.off}</span>
      </label>}
      {message && <span className="muted tiny" role="status">{message}</span>}
    </section>
  );
}

/** Asked once per device: after the person's first message, while notifications could still be turned on here. */
const NUDGE_KEY = "aio.pushNudge";
function nudged(): boolean {
  try { return localStorage.getItem(NUDGE_KEY) === "1"; } catch { return false; }
}

/** Under the feed after a message is sent: one tap turns notifications on; either answer puts it away for good. */
export function PushNudge() {
  const { state, busy, message, enable } = usePush();
  const [done, setDone] = useState(nudged);
  const finish = () => {
    try { localStorage.setItem(NUDGE_KEY, "1"); } catch { /* storage unavailable: it goes away for this page only */ }
    setDone(true);
  };
  useEffect(() => { if (state === "on" || state === "denied") finish(); }, [state]);
  if (done || (state !== "off" && state !== "install")) return null;
  return <div className="banner push-nudge" role="status">
    <NavIcon name="bell"/>
    <span>{state === "install" ? t.app.push.install : t.app.push.nudge}{message && <span className="muted tiny"> {message}</span>}</span>
    {state === "off" && <button type="button" disabled={busy} onClick={() => void enable()}>{t.app.push.nudgeEnable}</button>}
    <button type="button" onClick={finish}>{state === "install" ? t.app.push.nudgeOk : t.app.push.nudgeLater}</button>
  </div>;
}
