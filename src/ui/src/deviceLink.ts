/**
 * The Mac app's phone link (src/ui/tauri, `mac` in lib.rs): the console asks the
 * app to link this Mac with a token its account just issued, or to unlink it,
 * and the app reports how its phone bridge is doing. Only the app's main frame on
 * the console origin has this handler; a browser never does.
 */
/** Messages are JSON strings, which the app reads without unpacking Objective-C objects. */
type LinkBridge = { postMessage(message: string): void };
type LinkWindow = Window & { webkit?: { messageHandlers?: { aioDeviceLink?: LinkBridge } } };

export type NativeLinkState = "off" | "preparing" | "starting" | "connecting" | "online" | "offline" | "error" | "revoked";

export interface NativeLink {
  state: NativeLinkState;
  /** The link this Mac holds, when it holds one. */
  linkId?: string;
  /** This Mac's name, offered as the link's name. */
  name?: string;
  /** While preparing: the step being downloaded; on error: what failed. */
  detail?: string;
}

function bridge(): LinkBridge | undefined {
  return (window as LinkWindow).webkit?.messageHandlers?.aioDeviceLink;
}

export function hasDeviceLink(): boolean {
  return Boolean(bridge());
}

/** Follow the app's state; asks for it at once. */
export function listenDeviceLink(callback: (link: NativeLink) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<NativeLink>).detail);
  window.addEventListener("aio-device-link", listener);
  bridge()?.postMessage(JSON.stringify({ type: "status" }));
  return () => window.removeEventListener("aio-device-link", listener);
}

export function linkThisMac(token: string, linkId: string): void {
  bridge()?.postMessage(JSON.stringify({ type: "link", token, linkId }));
}

export function unlinkThisMac(): void {
  bridge()?.postMessage(JSON.stringify({ type: "unlink" }));
}
