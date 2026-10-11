import { isWebLink } from "./sandboxLink";

type BrowserBridge = { postMessage(url: string): void };
type BrowserWindow = Window & {
  aioDeviceBrowser?: BrowserBridge;
  webkit?: { messageHandlers?: { aioDeviceBrowser?: BrowserBridge } };
};

function nativeBridge(): BrowserBridge | undefined {
  const native = window as BrowserWindow;
  return native.aioDeviceBrowser ?? native.webkit?.messageHandlers?.aioDeviceBrowser;
}

export function hasNativeBrowser(): boolean { return Boolean(nativeBridge()); }

/** Install the listener before notifying Android, which may hold a cold-start callback. */
export function listenGoogleReturn(callback: (detail: {ticket?: string; error?: string}) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<{ticket?: string; error?: string}>).detail ?? {});
  window.addEventListener("aio-google-return", listener);
  nativeBridge()?.postMessage("aioagent-auth-ready");
  return () => window.removeEventListener("aio-google-return", listener);
}

/** Opens synchronously in the click/tap gesture, so browsers allow the new tab. */
export function openDeviceBrowser(url: string): void {
  if (!isWebLink(url)) return;
  const bridge = nativeBridge();
  if (bridge) bridge.postMessage(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Let web anchors keep their native modifier-click and popup semantics. */
export function openNativeBrowser(url: string): boolean {
  const bridge = nativeBridge();
  if (!bridge || !isWebLink(url)) return false;
  bridge.postMessage(url);
  return true;
}
