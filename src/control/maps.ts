/**
 * Map images and geocoding for map cards in messages.
 *
 * The console's CSP only loads same-origin images, and a map server must not
 * learn who is looking where, so maps are fetched here and served to signed-in
 * sessions. With a Google Maps Platform key (`PA_GOOGLE_MAPS_API_KEY`) a card is
 * one Maps Static image, marker included, and addresses go to the Geocoding API;
 * Google draws the marker on its own (in China, offset) map data, so it lands
 * on the place. Static images are not kept here (Google's terms allow only the
 * browser's HTTP cache); coordinates are kept at most 30 days, which they allow.
 *
 * Without a key both upstreams are OpenStreetMap's public services, whose usage
 * policy asks for an identifying User-Agent, caching, and at most one geocoding
 * request per second; the caches and the queue below keep this console far
 * below that.
 */
const USER_AGENT = "AIO-Agent/0.1 (self-hosted console; map cards)";
const TILE_URL = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const GEOCODE_URL = (q: string) => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
const GOOGLE_GEOCODE_URL = (q: string, key: string) => `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&language=zh-CN&key=${encodeURIComponent(key)}`;
const GOOGLE_STATIC_URL = (m: StaticMapRequest, key: string) => {
  const at = `${m.lat},${m.lng}`;
  return `https://maps.googleapis.com/maps/api/staticmap?center=${at}&zoom=${m.zoom}&size=${m.width}x${m.height}&scale=2&markers=${at}&language=${m.lang}&key=${encodeURIComponent(key)}`;
};
const PLACE_TTL_MS = 30 * 86_400_000;
/** The console's languages, as Google names them. */
const GOOGLE_LANGUAGES: Record<string, string> = { zh: "zh-CN", "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en", es: "es" };

export type MapProvider = "google" | "osm";

export interface StaticMapRequest {
  lat: number;
  lng: number;
  zoom: number;
  /** CSS pixels; the image comes at twice that. */
  width: number;
  height: number;
  /** A Google language code. */
  lang: string;
}

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
  clear(): void {
    this.#map.clear();
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
  readonly #places = new Lru<{ at: number; value: GeocodeResult | null }>(500);
  #geocodeQueue: Promise<unknown> = Promise.resolve();
  #googleKey = "";

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly geocodeSpacingMs = 1100) {}

  /** Switch to Google Maps with this key; empty stays on OpenStreetMap. */
  useGoogle(key: string): void {
    if (key !== this.#googleKey) this.#places.clear();
    this.#googleKey = key;
  }

  get provider(): MapProvider {
    return this.#googleKey ? "google" : "osm";
  }

  /** A static map request from query values, or null when one is missing or out of range. */
  static staticRequest(q: Record<string, unknown>): StaticMapRequest | null {
    const n = (v: unknown) => (typeof v === "string" && /^-?\d{1,3}(\.\d{1,10})?$/.test(v) ? Number(v) : NaN);
    const lat = n(q.lat), lng = n(q.lng), zoom = n(q.zoom), width = n(q.w), height = n(q.h);
    if (!(Math.abs(lat) <= 85 && Math.abs(lng) <= 180)) return null;
    if (!Number.isInteger(zoom) || zoom < 3 || zoom > 18) return null;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 50 || height < 50 || width > 640 || height > 640) return null;
    const lang = GOOGLE_LANGUAGES[typeof q.lang === "string" ? q.lang : ""] ?? "zh-CN";
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, zoom, width, height, lang };
  }

  /** A Google static map of the place, marker included, or null when Google has none to give. */
  async staticMap(request: StaticMapRequest): Promise<Buffer | null> {
    if (!this.#googleKey) return null;
    const res = await this.fetchImpl(GOOGLE_STATIC_URL(request, this.#googleKey), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
    return Buffer.from(await res.arrayBuffer());
  }

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

  #place(key: string): GeocodeResult | null | undefined {
    const hit = this.#places.get(key);
    return hit && Date.now() - hit.at < PLACE_TTL_MS ? hit.value : undefined;
  }

  /** The best match for an address or place name, or null; on OpenStreetMap one upstream request at a time, spaced out. */
  async geocode(query: string): Promise<GeocodeResult | null> {
    const key = query.trim().toLowerCase();
    const cached = this.#place(key);
    if (cached !== undefined) return cached;
    if (this.#googleKey) return this.#googleGeocode(query.trim(), key);
    const run = this.#geocodeQueue.then(async () => {
      const again = this.#place(key);
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
        this.#places.set(key, { at: Date.now(), value: result });
        return result;
      } finally {
        await new Promise((resolve) => setTimeout(resolve, this.geocodeSpacingMs));
      }
    });
    this.#geocodeQueue = run.catch(() => undefined);
    return run;
  }

  async #googleGeocode(query: string, key: string): Promise<GeocodeResult | null> {
    const res = await this.fetchImpl(GOOGLE_GEOCODE_URL(query, this.#googleKey), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
    const body = (await res.json()) as { status?: string; results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }> };
    // A denied key or a spent quota is an outage, not "nowhere": not remembered.
    if (body.status !== "OK" && body.status !== "ZERO_RESULTS") throw new Error(`geocoder answered ${body.status}`);
    const hit = body.results?.[0];
    const lat = Number(hit?.geometry?.location?.lat), lng = Number(hit?.geometry?.location?.lng);
    const result = hit && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, label: String(hit.formatted_address ?? "").slice(0, 200) } : null;
    this.#places.set(key, { at: Date.now(), value: result });
    return result;
  }
}

/** One per process: every account shares the caches and the geocoding pace. */
export const maps = new MapService();
