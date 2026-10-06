/**
 * Pictures kept on this device across restarts (IndexedDB), so reopening the
 * console does not download them again. Each account keeps its own; the least
 * recently shown go first once the store passes its size or count. Anything
 * IndexedDB refuses (a private window, storage blocked) quietly falls back to
 * the network: this store is only ever a shortcut.
 *
 * The bytes and what is known about them live in two stores, so choosing what to
 * drop reads only the small records, never the pictures.
 */
const DB = "aio-images";
const BYTES = "bytes";
const META = "meta";
/** Past either limit the least recently shown pictures are dropped. */
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_COUNT = 800;
/** A kept picture's last-shown time is written again at most this often. */
const TOUCH_MS = 60 * 60_000;

export interface StoredImage {
  key: string;
  account: string;
  /** The workspace file's version, to ask whether it changed; null for a web picture. */
  etag: string | null;
  type: string;
  savedAt: number;
  usedAt: number;
  size: number;
}

let account: string | null = null;
let opening: Promise<IDBDatabase | null> | null = null;

/** The signed-in account whose pictures are kept; null keeps nothing. */
export function setImageAccount(name: string | null): void {
  account = name;
}

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(BYTES);
        const meta = req.result.createObjectStore(META, { keyPath: "key" });
        meta.createIndex("usedAt", "usedAt");
        meta.createIndex("account", "account");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function stores(mode: IDBTransactionMode): Promise<{ bytes: IDBObjectStore; meta: IDBObjectStore } | null> {
  const db = await open();
  try {
    if (!db) return null;
    const tx = db.transaction([BYTES, META], mode);
    return { bytes: tx.objectStore(BYTES), meta: tx.objectStore(META) };
  } catch {
    return null;
  }
}

const keyOf = (owner: string | null, src: string): string | null => (owner ? `${owner}\n${src}` : null);

/** The kept copy of a picture (what is known about it and its object URL), if this device has one. */
export async function readImage(src: string): Promise<{ meta: StoredImage; url: () => string } | null> {
  const key = keyOf(account, src);
  if (!key) return null;
  try {
    const s = await stores("readonly");
    if (!s) return null;
    const [meta, bytes] = await Promise.all([done(s.meta.get(key)) as Promise<StoredImage | undefined>, done(s.bytes.get(key)) as Promise<unknown>]);
    if (!meta || !(bytes instanceof ArrayBuffer) || !bytes.byteLength) return null;
    return { meta, url: () => URL.createObjectURL(new Blob([bytes], { type: meta.type })) };
  } catch {
    return null;
  }
}

/** Mark a kept picture as just shown, so it is among the last to go. */
export async function touchImage(meta: StoredImage): Promise<void> {
  if (Date.now() - meta.usedAt < TOUCH_MS) return;
  try {
    const s = await stores("readwrite");
    if (s) await done(s.meta.put({ ...meta, usedAt: Date.now() }));
  } catch {
    /* only a shortcut */
  }
}

/** Keep a picture, then drop the least recently shown past the limits. */
export async function saveImage(src: string, blob: Blob, etag: string | null): Promise<void> {
  const owner = account;
  const key = keyOf(owner, src);
  if (!key || !owner || blob.size > MAX_BYTES / 4) return;
  try {
    // The bytes are read before the transaction opens: an await inside one lets it close.
    const bytes = await blob.arrayBuffer();
    const now = Date.now();
    const s = await stores("readwrite");
    if (!s) return;
    s.bytes.put(bytes, key);
    await done(s.meta.put({ key, account: owner, etag, type: blob.type, savedAt: now, usedAt: now, size: blob.size } satisfies StoredImage));
    await evict();
  } catch {
    /* only a shortcut */
  }
}

async function evict(): Promise<void> {
  const s = await stores("readwrite");
  if (!s) return;
  const kept = (await done(s.meta.index("usedAt").getAll())) as StoredImage[];
  let bytes = kept.reduce((sum, k) => sum + k.size, 0);
  let count = kept.length;
  for (const oldest of kept) {
    if (bytes <= MAX_BYTES && count <= MAX_COUNT) break;
    s.meta.delete(oldest.key);
    s.bytes.delete(oldest.key);
    bytes -= oldest.size;
    count -= 1;
  }
}

/** Drop every picture an account kept on this device (on signing out). */
export async function forgetImages(name: string | null): Promise<void> {
  if (!name) return;
  try {
    const s = await stores("readwrite");
    if (!s) return;
    const keys = await done(s.meta.index("account").getAllKeys(name));
    for (const key of keys) {
      s.meta.delete(key);
      s.bytes.delete(key);
    }
  } catch {
    /* only a shortcut */
  }
}
