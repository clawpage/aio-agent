import { api, API_CREDENTIALS } from "./api";
import { readImage, saveImage, touchImage } from "./imageStore";

/**
 * Pictures shown from messages, shared across everywhere the same picture
 * appears: the main feed, a task's panel and the preview dialog all get the one
 * object URL instead of fetching the bytes again. A picture is a workspace path
 * ("/home/...", read through the document endpoint) or an https URL (fetched by
 * the account's sandbox). Only an image response is ever cached.
 *
 * Behind the in-memory cache is a copy kept on the device (imageStore): a web
 * picture is shown from it for a week without asking; a workspace picture asks
 * only whether the file changed (304, no bytes) and is shown from the copy if not.
 * Offline or with the server briefly failing, the kept copy is shown.
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

/** A kept web picture is shown without asking for this long. */
const WEB_KEEP_MS = 7 * 24 * 3600_000;

function fetchImage(src: ImageSource): Promise<string> {
  return (async () => {
    const web = !src.startsWith("/");
    const kept = await readImage(src);
    const fromKept = () => { void touchImage(kept!.meta); return kept!.url(); };
    if (kept && web && Date.now() - kept.meta.savedAt < WEB_KEEP_MS) return fromKept();
    let res: Response;
    try {
      const url = web ? api.webImageUrl(src) : `${api.documentImageUrl(src)}${kept?.meta.etag ? `&known=${encodeURIComponent(kept.meta.etag)}` : ""}`;
      res = await fetch(url, { credentials: API_CREDENTIALS });
    } catch (err) {
      if (kept) return fromKept();
      throw err;
    }
    if (kept && (res.status === 304 || res.status >= 500)) return fromKept();
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("unavailable");
    const blob = await res.blob();
    if (!blob.size) throw new Error("empty");
    void saveImage(src, blob, web ? null : res.headers.get("etag"));
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

/** A picture this device already has (one just uploaded): shown from it, not fetched back. */
export function primeImage(src: ImageSource, blob: Blob): void {
  const known = entries.get(src);
  if (known && !known.failed) return;
  const url = URL.createObjectURL(blob);
  entries.set(src, { promise: Promise.resolve(url), url, failed: false, refs: 0, used: ++clock });
  evict();
}

/** Forget that a picture failed, so an explicit retry fetches it again now. */
export function retryImage(src: ImageSource): void {
  if (entries.get(src)?.failed) entries.delete(src);
}
