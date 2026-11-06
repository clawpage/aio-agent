import type { MouseEvent } from "react";
import { API_CREDENTIALS } from "./api";
import { t } from "./i18n";

/**
 * Saving a file from an iPhone or iPad home-screen web app. There a download is
 * not a download: the file replaces the whole app, which has no back button and
 * no swipe to leave it. So there the file goes to the share sheet instead, whose
 * "Save Image" / "Save to Files" leave the app where it was. Everywhere else the
 * browser's own download runs unchanged.
 *
 * The iOS app (src/ui/tauri) is the same case: its web view ignores a download
 * link outright. Only a shell that declares the Photos permission behind "Save
 * Image" says so (the `aioSaveFiles` marker); an older one would be closed by iOS
 * on that tap, so it keeps the plain link.
 *
 * An image or video in the iOS or Android app skips the sheet: a shell with the
 * `aioSaveMedia` bridge writes the bytes the page already has straight into
 * Photos (the gallery on Android), and the page says 下载中… then 已存到相册.
 * An app without the bridge keeps the share sheet (iOS) or the plain link (Android).
 */
export function savesBySharing(): boolean {
  const shell = (window as ShellWindow).webkit?.messageHandlers?.aioSaveFiles;
  return ((navigator as Navigator & { standalone?: boolean }).standalone === true || Boolean(shell)) && typeof navigator.canShare === "function";
}

/** What both apps put in Photos / the gallery as they are; anything else keeps the way it was saved before. */
const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "video/mp4", "video/quicktime", "video/x-m4v"]);

type MediaMessage =
  | { type: "begin"; name: string; mime: string }
  | { type: "chunk"; id: string; data: string }
  | { type: "finish" | "cancel"; id: string }
  | { type: "settings" };
/** The app's answer: a transfer id for "begin"; `error` is "denied" (no Photos permission) or another code. */
type MediaReply = { id?: string; error?: string };
/** iOS: a reply handler whose promise is the answer. Android: a web message listener that answers with a message. */
type WebkitBridge = { postMessage(message: string): Promise<string> };
type AndroidBridge = { postMessage(message: string): void; addEventListener(type: "message", listener: (event: MessageEvent<string>) => void): void };
type ShellWindow = Window & { webkit?: { messageHandlers?: { aioSaveFiles?: unknown; aioSaveMedia?: WebkitBridge } }; aioSaveMedia?: AndroidBridge };

/** Android answers out of band, so each message carries a number its answer repeats. */
const androidWaiting = new Map<number, (reply: MediaReply) => void>();
let androidSeq = 0;
let androidListening = false;

function mediaBridge(): ((message: MediaMessage) => Promise<MediaReply>) | null {
  const shell = window as ShellWindow;
  const ios = shell.webkit?.messageHandlers?.aioSaveMedia;
  if (ios) return async (message) => JSON.parse(await ios.postMessage(JSON.stringify(message))) as MediaReply;
  const android = shell.aioSaveMedia;
  if (!android) return null;
  if (!androidListening) {
    androidListening = true;
    android.addEventListener("message", (event) => {
      const reply = JSON.parse(event.data) as MediaReply & { seq: number };
      androidWaiting.get(reply.seq)?.(reply);
      androidWaiting.delete(reply.seq);
    });
  }
  return (message) => new Promise((resolve) => {
    const seq = ++androidSeq;
    androidWaiting.set(seq, resolve);
    android.postMessage(JSON.stringify({ ...message, seq }));
  });
}

/** Bytes cross to the app in pieces this size (as base64), so a long video never becomes one huge message. */
const CHUNK = 512 * 1024;

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(",") + 1)); };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: API_CREDENTIALS });
  if (!res.ok) throw new Error(String(res.status));
  return res.blob();
}

/** Into Photos through the app: permission first (iOS asks once), then the bytes, then one line for how it went. */
async function saveToPhotos(ask: (message: MediaMessage) => Promise<MediaReply>, source: string | Blob, name: string, mime: string): Promise<void> {
  notice(t.files.save.saving, { keep: true });
  let id: string | undefined;
  try {
    const begun = await ask({ type: "begin", name, mime });
    if (begun.error === "denied") {
      notice(t.files.save.denied, { error: true, action: { label: t.files.save.settings, run: () => void ask({ type: "settings" }).catch(() => undefined) } });
      return;
    }
    if (!begun.id) throw new Error(begun.error ?? "begin");
    id = begun.id;
    let blob: Blob;
    try {
      blob = typeof source === "string" ? await fetchBlob(source) : source;
    } catch {
      void ask({ type: "cancel", id }).catch(() => undefined);
      notice(t.files.save.failed(name), { error: true });
      return;
    }
    for (let at = 0; at < blob.size; at += CHUNK) {
      const sent = await ask({ type: "chunk", id, data: await base64(blob.slice(at, at + CHUNK)) });
      if (sent.error) throw new Error(sent.error);
    }
    const done = await ask({ type: "finish", id });
    id = undefined;
    if (done.error) throw new Error(done.error);
    notice(t.files.save.saved);
  } catch {
    if (id) void ask({ type: "cancel", id }).catch(() => undefined);
    notice(t.files.save.saveFailed(name), { error: true });
  }
}

/** The download endpoint sends octet-stream; the share sheet offers "Save Image" only for an image type. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
};

function typeOf(name: string, blob?: Blob): string {
  const known = TYPE_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  return known ?? (blob?.type || "application/octet-stream");
}

/** One line above everything, optionally with a button; a newer one replaces it. `keep`: until a newer one. */
function notice(text: string, opts: { error?: boolean; keep?: boolean; action?: { label: string; run: () => void } } = {}): void {
  const { action } = opts;
  document.querySelector(".save-notice")?.remove();
  const bar = document.createElement("div");
  bar.className = `toast save-notice${opts.error ? " error" : ""}`;
  bar.setAttribute("role", "status");
  bar.append(Object.assign(document.createElement("span"), { textContent: text }));
  if (action) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "primary tiny", textContent: action.label });
    button.addEventListener("click", () => { bar.remove(); action.run(); });
    bar.append(button);
  }
  document.body.append(bar);
  if (!opts.keep) window.setTimeout(() => bar.remove(), action ? 20_000 : 4_000);
}

async function share(file: File, again: boolean): Promise<void> {
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    // A slow fetch outlives the tap that asked for it, and the share sheet needs
    // a fresh one: the file is ready now, so one more tap opens it.
    if (again && err instanceof DOMException && err.name === "NotAllowedError") {
      notice(t.files.save.ready(file.name), { action: { label: t.files.save.save, run: () => void share(file, false) } });
    }
    // AbortError: the sheet was dismissed, nothing to say.
  }
}

/**
 * Save a file (a URL to fetch, or bytes made here): an image or video into Photos
 * in the app, otherwise through the share sheet where that is how files are saved.
 * Returns false when this device downloads normally: the caller does that.
 */
export function saveFile(source: string | Blob, name: string): boolean {
  const ask = mediaBridge();
  const mime = typeOf(name, typeof source === "string" ? undefined : source);
  if (ask && PHOTO_TYPES.has(mime)) {
    void saveToPhotos(ask, source, name, mime);
    return true;
  }
  if (!savesBySharing()) return false;
  void (async () => {
    let blob: Blob;
    try {
      blob = typeof source === "string" ? await fetchBlob(source) : source;
    } catch {
      notice(t.files.save.failed(name), { error: true });
      return;
    }
    await share(new File([blob], name, { type: typeOf(name, blob) }), true);
  })();
  return true;
}

/** Save a file at a URL from a control that is not a link: the share sheet where that is how files are saved, otherwise a download. */
export function downloadFile(url: string, name: string): void {
  if (saveFile(url, name)) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** For a download link's onClick: its own download, unless this device saves by sharing. */
export function onDownloadClick(event: MouseEvent<HTMLAnchorElement>): void {
  const link = event.currentTarget;
  const name = link.getAttribute("download") || decodeURIComponent(new URL(link.href).searchParams.get("path")?.split("/").pop() ?? "") || "download";
  if (saveFile(link.href, name)) event.preventDefault();
}
