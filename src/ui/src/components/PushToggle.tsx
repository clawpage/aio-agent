import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";

type State = "loading" | "unsupported" | "install" | "off" | "on" | "denied";

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function keyBytes(base64url: string): ArrayBuffer {
  const raw = atob((base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Phone notifications for this account. iOS offers them only to the console
 * added to the home screen, and only asks for permission from a tap.
 */
export function PushToggle() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!supported()) { setState(isIOS() && !standalone() ? "install" : "unsupported"); return; }
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
      setMessage(t.app.push.enabled);
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
  const test = async () => {
    setBusy(true); setMessage(null);
    try { const { sent } = await api.pushTest(); setMessage(sent ? t.app.push.testSent : t.app.push.testNotSent); }
    catch (err) { setMessage(err instanceof Error ? err.message : t.app.push.sendFailed); } finally { setBusy(false); }
  };

  if (state === "loading" || state === "unsupported") return null;
  return <div className="push-toggle" aria-label={t.app.push.label}>
    {state === "install" && <span className="muted tiny">{t.app.push.install}</span>}
    {state === "denied" && <span className="muted tiny">{t.app.push.denied}</span>}
    {state === "off" && <button className="ghost block" disabled={busy} onClick={() => void enable()}>{t.app.push.enable}</button>}
    {state === "on" && <div className="push-on"><span className="tiny">{t.app.push.on}</span><button className="ghost tiny" disabled={busy} onClick={() => void test()}>{t.common.test}</button><button className="ghost tiny" disabled={busy} onClick={() => void disable()}>{t.common.close}</button></div>}
    {message && <span className="muted tiny" role="status">{message}</span>}
  </div>;
}
