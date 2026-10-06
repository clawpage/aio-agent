import { api, API_CREDENTIALS } from "./api";

/**
 * Pictures shown from messages, shared across everywhere the same picture
 * appears: the main feed, a task's panel and the preview dialog all get the one
 * object URL instead of fetching the bytes again. A picture is a workspace path
 * ("/home/...", read through the document endpoint) or an https URL (fetched by
 * the account's sandbox). Only an image response is ever cached.
 */
export type ImageSource = string;

interface Entry {
  promise: Promise<string>;
  url: string | null;
  failed: boolean;
  refs: number;
  used: number;
}

/** Pictures kept once nothing shows them; past this the least recently used go. */
const KEEP = 120;
/** A picture that failed is tried again after this long, not on every mount. */
const RETRY_MS = 30_000;

const entries = new Map<ImageSource, Entry>();
let clock = 0;

function fetchImage(src: ImageSource): Promise<string> {
  return (async () => {
    const res = await fetch(src.startsWith("/") ? api.documentImageUrl(src) : api.webImageUrl(src), { credentials: API_CREDENTIALS });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("unavailable");
    const blob = await res.blob();
    if (!blob.size) throw new Error("empty");
    return URL.createObjectURL(blob);
  })();
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
 * once however many places ask. Call the returned release when it is no longer
 * shown; the URL stays cached for the next one.
 */
export function holdImage(src: ImageSource): { promise: Promise<string>; release: () => void } {
  let entry = entries.get(src);
  if (!entry) {
    const created: Entry = { promise: fetchImage(src), url: null, failed: false, refs: 0, used: 0 };
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
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      held.used = ++clock;
      evict();
    },
  };
}

/** Forget that a picture failed, so an explicit retry fetches it again now. */
export function retryImage(src: ImageSource): void {
  if (entries.get(src)?.failed) entries.delete(src);
}
