/**
 * Map tiles and geocoding for map cards in messages.
 *
 * The console's CSP only loads same-origin images, and a tile server must not
 * learn who is looking where, so tiles are fetched here and served to signed-in
 * sessions. Both upstreams are OpenStreetMap's public services, whose usage
 * policy asks for an identifying User-Agent, caching, and at most one geocoding
 * request per second; the caches and the queue below keep this console far
 * below that.
 */
const USER_AGENT = "AIO-Agent/0.1 (self-hosted console; map cards)";
const TILE_URL = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const GEOCODE_URL = (q: string) => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;

export interface GeocodeResult {
  lat: number;
  lng: number;
  label: string;
}

class Lru<V> {
  #map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.max) this.#map.delete(this.#map.keys().next().value!);
  }
}

export class MapService {
  readonly #tiles = new Lru<Buffer>(1500);
  readonly #inflight = new Map<string, Promise<Buffer | null>>();
  readonly #places = new Lru<GeocodeResult | null>(500);
  #geocodeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly geocodeSpacingMs = 1100) {}

  /** Whether z/x/y names a real tile. */
  static validTile(z: number, x: number, y: number): boolean {
    return Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= 0 && z <= 19 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
  }

  async tile(z: number, x: number, y: number): Promise<Buffer | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.#tiles.get(key);
    if (cached) return cached;
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const res = await this.fetchImpl(TILE_URL(z, x, y), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
        const body = Buffer.from(await res.arrayBuffer());
        this.#tiles.set(key, body);
        return body;
      })().finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  /** The best match for an address or place name, or null; one upstream request at a time, spaced out. */
  async geocode(query: string): Promise<GeocodeResult | null> {
    const key = query.trim().toLowerCase();
    const cached = this.#places.get(key);
    if (cached !== undefined) return cached;
    const run = this.#geocodeQueue.then(async () => {
      const again = this.#places.get(key);
      if (again !== undefined) return again;
      try {
        const res = await this.fetchImpl(GEOCODE_URL(query.trim()), {
          headers: { "user-agent": USER_AGENT, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
        const [hit] = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
        const lat = Number(hit?.lat), lng = Number(hit?.lon);
        const result = hit && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, label: String(hit.display_name ?? "").slice(0, 200) } : null;
        this.#places.set(key, result);
        return result;
      } finally {
        await new Promise((resolve) => setTimeout(resolve, this.geocodeSpacingMs));
      }
    });
    this.#geocodeQueue = run.catch(() => undefined);
    return run;
  }
}

/** One per process: every account shares the caches and the geocoding pace. */
export const maps = new MapService();
