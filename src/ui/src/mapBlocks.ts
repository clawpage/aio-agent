/**
 * Map cards in messages. An executor writes a fenced block:
 *
 *   ```map
 *   {"name": "金门大桥", "lat": 37.8199, "lng": -122.4783, "address": "Golden Gate Bridge, San Francisco"}
 *   ```
 *
 * Coordinates are WGS-84 unless `"coord": "gcj02"` (copied from 高德/腾讯). With
 * no coordinates the address (or name) is geocoded by the control plane. A block
 * that does not parse stays an ordinary code block.
 */

import { t } from "./i18n";

export interface MapPlace {
  name: string;
  address: string | null;
  /** WGS-84, after any conversion; null until geocoded. */
  lat: number | null;
  lng: number | null;
  /** The zoom the card opens at. */
  zoom: number;
}

export type MessagePart = { kind: "text"; text: string } | { kind: "map"; place: MapPlace };

const FENCE = /^```map[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The place a block describes, or null when it is not a usable map block. */
export function parsePlace(raw: string): MapPlace | null {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = text(data.name ?? data.title, 80);
  const address = text(data.address, 200);
  let lat = num(data.lat ?? data.latitude);
  let lng = num(data.lng ?? data.lon ?? data.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) lat = lng = null;
  if (lat !== null && lng !== null && String(data.coord ?? "").toLowerCase() === "gcj02") [lat, lng] = gcj02ToWgs84(lat, lng);
  if (lat === null && !address && !name) return null;
  const zoom = num(data.zoom);
  return { name: name ?? address ?? t.cards.map.defaultName, address, lat, lng, zoom: zoom === null ? 15 : Math.min(18, Math.max(3, Math.round(zoom))) };
}

/** Split a message into text and map cards, in order. */
export function splitMapBlocks(source: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const place = parsePlace(match[1]!);
    if (!place) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "map", place });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "map" || p.text.trim() !== "");
}

// ---------------------------------------------------------------- coordinates

const outOfChina = (lat: number, lng: number) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

function gcjOffset(lat: number, lng: number): [number, number] {
  const a = 6378245.0, ee = 0.00669342162296594323;
  const x = lng - 105, y = lat - 35;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  dLat += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  dLat += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  let dLng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  dLng += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  dLng += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  const radLat = (lat / 180) * Math.PI;
  const magic = 1 - ee * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  return [(dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI), (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI)];
}

/** WGS-84 to GCJ-02 (the offset Chinese maps use); unchanged outside China. */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  const [dLat, dLng] = gcjOffset(lat, lng);
  return [lat + dLat, lng + dLng];
}

/** GCJ-02 back to WGS-84, iterated to well under a metre. */
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let wLat = lat, wLng = lng;
  for (let i = 0; i < 5; i += 1) {
    const [gLat, gLng] = wgs84ToGcj02(wLat, wLng);
    wLat += lat - gLat;
    wLng += lng - gLng;
  }
  return [wLat, wLng];
}

// ---------------------------------------------------------------- tiles

export const TILE = 256;

/** Web-Mercator world pixel of a point at a zoom. */
export function worldPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return { x: ((lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

/** The tiles covering a `width`×`height` view centred on a point, with their offsets in the view. */
export function tilesFor(lat: number, lng: number, zoom: number, width: number, height: number) {
  const center = worldPixel(lat, lng, zoom);
  const left = center.x - width / 2, top = center.y - height / 2;
  const count = 2 ** zoom;
  const tiles: Array<{ key: string; z: number; x: number; y: number; left: number; top: number }> = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty += 1) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx += 1) {
      const wrapped = ((tx % count) + count) % count;
      tiles.push({ key: `${zoom}/${tx}/${ty}`, z: zoom, x: wrapped, y: ty, left: tx * TILE - left, top: ty * TILE - top });
    }
  }
  return tiles;
}

// ---------------------------------------------------------------- map apps

export type Platform = "ios" | "android" | "other";

export function platformOf(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

export interface MapLink {
  id: string;
  label: string;
  href: string;
}

/**
 * Links that show the place in a map app; the person starts directions there
 * if they want them. Web pages cannot see which apps are installed, so every
 * common one is offered, the platform's own first; on Android `geo:` lets the
 * system ask which installed app to use. The https forms open the app when it
 * is installed and the web map otherwise.
 */
export function mapLinks(place: MapPlace, platform: Platform): MapLink[] {
  const name = place.name;
  const query = place.address ?? place.name;
  const e = encodeURIComponent;
  const links: MapLink[] = [];
  if (place.lat !== null && place.lng !== null) {
    const { lat, lng } = place;
    const [gLat, gLng] = wgs84ToGcj02(lat, lng);
    if (platform === "android") links.push({ id: "system", label: t.cards.map.apps.system, href: `geo:${lat},${lng}?q=${lat},${lng}(${e(name)})` });
    if (platform !== "android") links.push({ id: "apple", label: t.cards.map.apps.apple, href: `https://maps.apple.com/?ll=${lat},${lng}&q=${e(name)}` });
    links.push({ id: "amap", label: t.cards.map.apps.amap, href: `https://uri.amap.com/marker?position=${gLng},${gLat}&name=${e(name)}&coordinate=gaode&callnative=1&src=yizhan` });
    links.push({
      id: "baidu",
      label: t.cards.map.apps.baidu,
      href: platform === "other"
        ? `https://api.map.baidu.com/marker?location=${gLat},${gLng}&title=${e(name)}&content=${e(query)}&coord_type=gcj02&output=html&src=yizhan`
        : `baidumap://map/marker?location=${gLat},${gLng}&title=${e(name)}&content=${e(query)}&coord_type=gcj02&src=yizhan`,
    });
    links.push({ id: "google", label: t.cards.map.apps.google, href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` });
    links.push({ id: "waze", label: "Waze", href: `https://waze.com/ul?ll=${lat},${lng}` });
  } else {
    // Not located: every app can still search the address itself.
    if (platform === "android") links.push({ id: "system", label: t.cards.map.apps.system, href: `geo:0,0?q=${e(query)}` });
    if (platform !== "android") links.push({ id: "apple", label: t.cards.map.apps.apple, href: `https://maps.apple.com/?q=${e(query)}` });
    links.push({ id: "amap", label: t.cards.map.apps.amap, href: `https://uri.amap.com/search?keyword=${e(query)}&callnative=1&src=yizhan` });
    links.push({ id: "baidu", label: t.cards.map.apps.baidu, href: `https://api.map.baidu.com/geocoder?address=${e(query)}&output=html&src=yizhan` });
    links.push({ id: "google", label: t.cards.map.apps.google, href: `https://www.google.com/maps/search/?api=1&query=${e(query)}` });
    links.push({ id: "waze", label: "Waze", href: `https://waze.com/ul?q=${e(query)}` });
  }
  return links;
}
