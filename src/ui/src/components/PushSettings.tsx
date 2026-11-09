import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { NavIcon } from "./NavIcon";

type State = "loading" | "unsupported" | "install" | "off" | "on" | "denied";

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// A browser on iOS (its name carries "Safari/"), not an app's web view: only a browser can add the console to the home screen.
const iosBrowser = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent);

/** The iOS app's notification bridge (DeviceBrowser.swift): WKWebView has no Web Push, so the app registers with APNs. */
type AppAnswer = { permission: "granted" | "denied" | "default"; token?: string; environment?: string; error?: string };
type AppBridge = { postMessage(action: "status" | "enable" | "settings"): void };
const appBridge = () => (window as Window & { webkit?: { messageHandlers?: { aioPush?: AppBridge } } }).webkit?.messageHandlers?.aioPush;

/**
 * One question to the app, answered by its `aio-push` event. Enabling waits for the person at the
 * system prompt, and an answer to someone else's status question ("not asked yet") is not theirs.
 */
function askApp(action: "status" | "enable"): Promise<AppAnswer> {
  return new Promise((resolve, reject) => {
    const done = (event: Event) => {
      const answer = (event as CustomEvent<AppAnswer>).detail;
      if (action === "enable" && answer.permission === "default") return;
      clearTimeout(timer); removeEventListener("aio-push", done); resolve(answer);
    };
    const timer = setTimeout(() => { removeEventListener("aio-push", done); reject(new Error(t.app.push.enableFailed)); }, action === "enable" ? 300_000 : 15_000);
    addEventListener("aio-push", done);
    appBridge()!.postMessage(action);
  });
}
const appEndpoint = (answer: AppAnswer) => answer.token && answer.environment ? `apns:${answer.environment}:${answer.token}` : undefined;
let appDevice: Promise<string | undefined> | null = null;

/** This device's push address, if notifications can reach it here: the console's presence names it so only this device stays quiet while on screen. */
export async function devicePushEndpoint(): Promise<string | undefined> {
  if (appBridge()) {
    appDevice ??= askApp("status").then((answer) => answer.permission === "granted" ? appEndpoint(answer) : undefined).catch(() => undefined);
    return appDevice;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return undefined;
  const registration = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  return (await registration?.pushManager.getSubscription().catch(() => null))?.endpoint;
}

function keyBytes(base64url: string): ArrayBuffer {
  const raw = atob((base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Phone notifications for this account on this device. iOS offers Web Push only to
 * the console added to the home screen, and only asks for permission from a tap;
 * in the iOS app they go through the app's APNs registration instead.
 */
function usePush() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The system has never asked for notifications on this device. */
  const [unasked, setUnasked] = useState(false);
  const app = Boolean(appBridge());
  const refresh = useCallback(async () => {
    if (app) {
      // Only offered once the deployment can reach the app (it has an APNs key).
      if (!(await api.pushInfo()).apns) { setState("unsupported"); return; }
      const answer = await askApp("status");
      setUnasked(answer.permission === "default");
      if (answer.permission !== "granted") { setState(answer.permission === "denied" ? "denied" : "off"); return; }
      const endpoint = appEndpoint(answer);
      setState(endpoint && (await api.pushInfo(endpoint)).subscribed ? "on" : "off");
      return;
    }
    if (!supported()) { setState(iosBrowser() && !standalone() ? "install" : "unsupported"); return; }
    setUnasked(Notification.permission === "default");
    if (Notification.permission === "denied") { setState("denied"); return; }
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    setState(subscription && Notification.permission === "granted" ? "on" : "off");
  }, []);
  useEffect(() => {
    void refresh().catch(() => setState("unsupported"));
    // Back from Settings, where notifications may have just been allowed.
    const back = () => { if (document.visibilityState === "visible") void refresh().catch(() => undefined); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [refresh]);

  const enable = async () => {
    setBusy(true); setMessage(null);
    try {
      if (app) {
        const answer = await askApp("enable");
        setUnasked(false);
        if (answer.permission !== "granted") { setState(answer.permission === "denied" ? "denied" : "off"); return; }
        if (!answer.token || !answer.environment) throw new Error(t.app.push.enableFailed);
        await api.pushSubscribeApp(answer.token, answer.environment);
        appDevice = Promise.resolve(appEndpoint(answer));
        setState("on");
        return;
      }
      // Ask first, straight from the tap: iOS refuses a prompt that follows other awaits.
      const permission = await Notification.requestPermission();
      setUnasked(permission === "default");
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
      if (app) {
        const endpoint = await devicePushEndpoint();
        if (endpoint) await api.pushUnsubscribe(endpoint);
        setState("off");
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) { await api.pushUnsubscribe(subscription.endpoint); await subscription.unsubscribe(); }
      setState("off");
    } catch (err) { setMessage(err instanceof Error ? err.message : t.app.push.disableFailed); } finally { setBusy(false); }
  };
  return { state, busy, message, enable, disable, app, unasked };
}

/** The configuration page's switch; hidden where the device cannot receive notifications at all. */
export function PushSettings() {
  const { state, busy, message, enable, disable, app } = usePush();
  if (state === "loading" || state === "unsupported") return null;
  return (
    <section className="settings-card" aria-label={t.app.push.label}>
      <div className="settings-section-head">
        <h3>{t.app.push.label}</h3>
        <p>{t.app.push.description}</p>
      </div>
      {state === "install" && <p className="muted tiny">{t.app.push.install}</p>}
      {state === "denied" && <p className="muted tiny">{t.app.push.denied}</p>}
      {/* The app can open its own page in Settings, where a refusal is undone. */}
      {state === "denied" && app && <button type="button" onClick={() => appBridge()?.postMessage("settings")}>{t.app.push.openSettings}</button>}
      {(state === "on" || state === "off") && <label className="debug-toggle">
        <input type="checkbox" checked={state === "on"} disabled={busy} onChange={(event) => void (event.target.checked ? enable() : disable())} />
        <span>{state === "on" ? t.app.push.on : t.app.push.off}</span>
      </label>}
      {message && <span className="muted tiny" role="status">{message}</span>}
    </section>
  );
}

/** The hint to add the console to the home screen is shown once per device: nothing here can turn notifications on. */
const NUDGE_KEY = "aio.pushNudge";
function nudged(): boolean {
  try { return localStorage.getItem(NUDGE_KEY) === "1"; } catch { return false; }
}

/**
 * Under the feed after each message sent, on a device the system has never asked for notifications:
 * one tap brings up its prompt. "Not now" puts it away until the next message; once the system has
 * asked (allowed or refused), or notifications were turned off here on purpose, it is not offered again.
 */
export function PushNudge() {
  const { state, busy, message, enable, unasked } = usePush();
  const [done, setDone] = useState(false);
  const [installSeen, setInstallSeen] = useState(nudged);
  const later = () => {
    if (state === "install") {
      try { localStorage.setItem(NUDGE_KEY, "1"); } catch { /* storage unavailable: it goes away for this page only */ }
      setInstallSeen(true);
    }
    setDone(true);
  };
  if (done || !(state === "off" && (unasked || busy)) && !(state === "install" && !installSeen)) return null;
  return <div className="banner push-nudge" role="status">
    <NavIcon name="bell"/>
    <span>{state === "install" ? t.app.push.install : t.app.push.nudge}{message && <span className="muted tiny"> {message}</span>}</span>
    {state === "off" && <button type="button" disabled={busy} onClick={() => void enable()}>{t.app.push.nudgeEnable}</button>}
    <button type="button" onClick={later}>{state === "install" ? t.app.push.nudgeOk : t.app.push.nudgeLater}</button>
  </div>;
}
