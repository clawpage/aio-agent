import type { MouseEvent } from "react";
import { API_CREDENTIALS } from "./api";
import { t } from "./i18n";

/**
 * Saving a file from an iPhone or iPad home-screen web app. There a download is
 * not a download: the file replaces the whole app, which has no back button and
 * no swipe to leave it. So there the file goes to the share sheet instead, whose
 * "Save Image" / "Save to Files" leave the app where it was. Everywhere else the
 * browser's own download runs unchanged.
 */
export function savesBySharing(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true && typeof navigator.canShare === "function";
}

/** The download endpoint sends octet-stream; the share sheet offers "Save Image" only for an image type. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
};

function typeOf(name: string, blob: Blob): string {
  const known = TYPE_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  return known ?? (blob.type || "application/octet-stream");
}

/** One line above everything, optionally with a button; a newer one replaces it. */
function notice(text: string, action?: { label: string; run: () => void }): void {
  document.querySelector(".save-notice")?.remove();
  const bar = document.createElement("div");
  bar.className = `toast save-notice${action ? "" : " error"}`;
  bar.setAttribute("role", "status");
  bar.append(Object.assign(document.createElement("span"), { textContent: text }));
  if (action) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "primary tiny", textContent: action.label });
    button.addEventListener("click", () => { bar.remove(); action.run(); });
    bar.append(button);
  }
  document.body.append(bar);
  window.setTimeout(() => bar.remove(), action ? 20_000 : 4_000);
}

async function share(file: File, again: boolean): Promise<void> {
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    // A slow fetch outlives the tap that asked for it, and the share sheet needs
    // a fresh one: the file is ready now, so one more tap opens it.
    if (again && err instanceof DOMException && err.name === "NotAllowedError") {
      notice(t.files.save.ready(file.name), { label: t.files.save.save, run: () => void share(file, false) });
    }
    // AbortError: the sheet was dismissed, nothing to say.
  }
}

/**
 * Save a file (a URL to fetch, or bytes made here) through the share sheet.
 * Returns false when this device downloads normally: the caller does that.
 */
export function saveFile(source: string | Blob, name: string): boolean {
  if (!savesBySharing()) return false;
  void (async () => {
    let blob: Blob;
    try {
      if (typeof source === "string") {
        const res = await fetch(source, { credentials: API_CREDENTIALS });
        if (!res.ok) throw new Error(String(res.status));
        blob = await res.blob();
      } else {
        blob = source;
      }
    } catch {
      notice(t.files.save.failed(name));
      return;
    }
    await share(new File([blob], name, { type: typeOf(name, blob) }), true);
  })();
  return true;
}

/** For a download link's onClick: its own download, unless this device saves by sharing. */
export function onDownloadClick(event: MouseEvent<HTMLAnchorElement>): void {
  const link = event.currentTarget;
  const name = link.getAttribute("download") || decodeURIComponent(new URL(link.href).searchParams.get("path")?.split("/").pop() ?? "") || "download";
  if (saveFile(link.href, name)) event.preventDefault();
}
