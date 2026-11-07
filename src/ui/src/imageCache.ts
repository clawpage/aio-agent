import { api, API_CREDENTIALS } from "./api";
import { dropImage, readImage, saveImage, touchImage } from "./imageStore";

/**
 * Pictures shown from messages, shared across everywhere the same picture
 * appears: the main feed, a task's panel and the preview dialog all get the one
 * object URL instead of fetching the bytes again. A picture is a workspace path
 * ("/home/...", read through the document endpoint) or an https URL (fetched by
 * the account's sandbox). Only an image response is ever cached.
 *
 * Behind the in-memory cache is a copy kept on the device (imageStore), shown at
 * once on reopening without waiting for the network: answering for a workspace
 * picture means a trip to the account's sandbox, often a second or more. Behind
 * it, a workspace picture asks whether the file changed (304, no bytes) and, if
 * it did, the new picture replaces the copy wherever it shows; a file that is gone
 * takes its copy with it. A web picture is asked about again only after a week,
 * for the next opening. Offline or with the server failing, the copy stays.
 */
export type ImageSource = string;

interface Entry {
  promise: Promise<string>;
  url: string | null;
  failed: boolean;
  refs: number;
  used: number;
  /** Told when a picture shown from the device copy turns out to have changed. */
  listeners: Set<(url: string) => void>;
}

/** Pictures kept once nothing shows them; past this the least recently used go. */
const KEEP = 120;
/** A picture that failed is tried again after this long, not on every mount. */
const RETRY_MS = 30_000;

const entries = new Map<ImageSource, Entry>();
let clock = 0;

/** A kept web picture is shown without asking for this long. */
const WEB_KEEP_MS = 7 * 24 * 3600_000;

function fetchImage(src: ImageSource, replace: (url: string) => void): Promise<string> {
  return (async () => {
    const web = !src.startsWith("/");
    const kept = await readImage(src);
    if (!kept) return URL.createObjectURL((await download(src, null))!);
    void touchImage(kept.meta);
    if (!web || Date.now() - kept.meta.savedAt >= WEB_KEEP_MS) {
      // A changed web picture is kept for the next opening; swapping it now would only flicker.
      void download(src, kept.meta.etag).then((blob) => { if (blob && !web) replace(URL.createObjectURL(blob)); }, () => undefined);
    }
    return kept.url();
  })();
}

/** A picture's bytes from the server, kept on the device; null when the kept version is still current. */
async function download(src: ImageSource, known: string | null): Promise<Blob | null> {
  const web = !src.startsWith("/");
  const res = await fetch(web ? api.webImageUrl(src) : `${api.documentImageUrl(src)}${known ? `&known=${encodeURIComponent(known)}` : ""}`, { credentials: API_CREDENTIALS });
  if (known && res.status === 304) return null;
  if (res.status === 404) void dropImage(src);
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("unavailable");
  const blob = await res.blob();
  if (!blob.size) throw new Error("empty");
  void saveImage(src, blob, web ? null : res.headers.get("etag"));
  return blob;
}

function evict(): void {
  if (entries.size <= KEEP) return;
  const idle = [...entries].filter(([, e]) => e.refs === 0 && e.url).sort((a, b) => a[1].used - b[1].used);
  for (const [src, e] of idle.slice(0, entries.size - KEEP)) {
    entries.delete(src);
    URL.revokeObjectURL(e.url!);
  }
}

/** The object URL of a picture already fetched, to draw it at once with no loading state. */
export function cachedImage(src: ImageSource | null): string | null {
  return (src && entries.get(src)?.url) || null;
}

/**
 * Hold a picture while something shows it: resolves to its object URL, fetched
 * once however many places ask. `changed` gets the new URL when the copy shown
 * from the device turns out to be out of date. Call the returned release when it
 * is no longer shown; the URL stays cached for the next one.
 */
export function holdImage(src: ImageSource, changed?: (url: string) => void): { promise: Promise<string>; release: () => void } {
  let entry = entries.get(src);
  if (!entry) {
    const created: Entry = { promise: Promise.resolve(""), url: null, failed: false, refs: 0, used: 0, listeners: new Set() };
    created.promise = fetchImage(src, (url) => {
      if (entries.get(src) !== created) { URL.revokeObjectURL(url); return; }
      const old = created.url;
      created.url = url;
      created.promise = Promise.resolve(url);
      for (const listener of created.listeners) listener(url);
      if (old) URL.revokeObjectURL(old);
    });
    created.promise.then(
      (url) => { created.url = url; evict(); },
      () => { created.failed = true; window.setTimeout(() => { if (entries.get(src) === created) entries.delete(src); }, RETRY_MS); },
    );
    entries.set(src, created);
    entry = created;
  }
  const held = entry;
  held.refs += 1;
  held.used = ++clock;
  if (changed) held.listeners.add(changed);
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      if (changed) held.listeners.delete(changed);
      held.refs -= 1;
      held.used = ++clock;
      evict();
    },
  };
}

/** A picture this device already has (one just uploaded): shown from it, not fetched back. */
export function primeImage(src: ImageSource, blob: Blob): void {
  const known = entries.get(src);
  if (known && !known.failed) return;
  const url = URL.createObjectURL(blob);
  entries.set(src, { promise: Promise.resolve(url), url, failed: false, refs: 0, used: ++clock, listeners: new Set() });
  evict();
}

/**
 * Forget every picture when the signed-in account changes: workspace paths are the same in every
 * account's sandbox, so a kept URL would show the previous account's file. One still shown keeps its URL.
 */
export function forgetCachedImages(): void {
  for (const e of entries.values()) if (e.refs === 0 && e.url) URL.revokeObjectURL(e.url);
  entries.clear();
}

/** Forget that a picture failed, so an explicit retry fetches it again now. */
export function retryImage(src: ImageSource): void {
  if (entries.get(src)?.failed) entries.delete(src);
}
