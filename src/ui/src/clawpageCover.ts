import { useEffect, useState } from "react";
import { api, API_CREDENTIALS } from "./api";

/**
 * Clawpage covers (a picture of each published page, rendered in the sandbox),
 * fetched with the console's credentials and kept as object URLs: the list, the
 * sheet and every card in the conversation share one copy. A cover named with its
 * version is fetched once; one asked for without (a card that only has the link)
 * is the latest, asked again after a minute so a page just republished shows its
 * new cover; a page without a cover is likewise asked about again after a minute.
 */
const covers = new Map<string, { promise: Promise<string | null>; at: number }>();
/** How long a miss, or the latest cover of a page named without a version, is taken as it is. */
const RECHECK_MS = 60_000;

function load(page: string, version: number | null): Promise<string | null> {
  const key = `${page}@${version ?? "latest"}`;
  const known = covers.get(key);
  if (known) return known.promise;
  const promise = fetch(api.clawpageCoverUrl(page, version), { credentials: API_CREDENTIALS })
    .then(async (res) => {
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
      return URL.createObjectURL(await res.blob());
    })
    .catch(() => null)
    .then((url) => {
      // A miss is asked again later (the cover may be rendering right now), and so is a latest cover (it may be replaced).
      if (!url || version === null) setTimeout(() => { if (covers.get(key)?.promise === promise) covers.delete(key); }, RECHECK_MS);
      return url;
    });
  covers.set(key, { promise, at: Date.now() });
  return promise;
}

/** The cover of one of the account's clawpages, or null (none, or not loaded yet). */
export function useClawpageCover(page: string | null, version: number | null = null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!page) return;
    let live = true;
    void load(page, version).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [page, version]);
  return url;
}
