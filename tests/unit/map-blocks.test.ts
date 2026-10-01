import { describe, expect, it, vi } from "vitest";
import { gcj02ToWgs84, navLinks, parsePlace, platformOf, splitMapBlocks, tilesFor, wgs84ToGcj02, worldPixel } from "../../src/web/src/mapBlocks.js";
import { MapService } from "../../src/server/maps.js";

const block = (json: string) => "```map\n" + json + "\n```";

describe("map blocks in a message", () => {
  it("splits text and map cards in order, and leaves other code blocks alone", () => {
    const source = `先去这里：\n${block('{"name":"金门大桥","lat":37.8199,"lng":-122.4783,"address":"Golden Gate Bridge"}')}\n然后吃饭。\n\`\`\`js\nconst a = 1;\n\`\`\``;
    const parts = splitMapBlocks(source);
    expect(parts.map((p) => p.kind)).toEqual(["text", "map", "text"]);
    expect(parts[1]).toMatchObject({ kind: "map", place: { name: "金门大桥", lat: 37.8199, lng: -122.4783, address: "Golden Gate Bridge", zoom: 15 } });
    expect((parts[2] as { text: string }).text).toContain("```js");
  });

  it("keeps a message without usable map blocks as one text part", () => {
    expect(splitMapBlocks("plain")).toEqual([{ kind: "text", text: "plain" }]);
    const broken = block("{not json");
    expect(splitMapBlocks(broken)).toEqual([{ kind: "text", text: broken }]);
    expect(splitMapBlocks(block("{}"))).toEqual([{ kind: "text", text: block("{}") }]);
  });

  it("accepts an address without coordinates, and drops impossible coordinates", () => {
    expect(parsePlace('{"address":"1 Infinite Loop, Cupertino"}')).toEqual({ name: "1 Infinite Loop, Cupertino", address: "1 Infinite Loop, Cupertino", lat: null, lng: null, zoom: 15 });
    expect(parsePlace('{"name":"x","lat":123,"lng":10}')).toMatchObject({ lat: null, lng: null });
    expect(parsePlace('{"name":"x","latitude":"31.2","longitude":"121.5","zoom":40}')).toMatchObject({ lat: 31.2, lng: 121.5, zoom: 18 });
  });

  it("converts 高德 (GCJ-02) coordinates back to WGS-84 inside China only", () => {
    const [gLat, gLng] = wgs84ToGcj02(39.9087, 116.3975);
    expect(Math.abs(gLat - 39.9087) + Math.abs(gLng - 116.3975)).toBeGreaterThan(0.002);
    const [lat, lng] = gcj02ToWgs84(gLat, gLng);
    expect(lat).toBeCloseTo(39.9087, 6);
    expect(lng).toBeCloseTo(116.3975, 6);
    expect(parsePlace(`{"name":"天安门","lat":${gLat},"lng":${gLng},"coord":"gcj02"}`)!.lat).toBeCloseTo(39.9087, 6);
    expect(wgs84ToGcj02(37.8199, -122.4783)).toEqual([37.8199, -122.4783]);
  });

  it("covers the whole view with tiles around the point", () => {
    const zoom = 15, width = 420, height = 150;
    const tiles = tilesFor(37.8199, -122.4783, zoom, width, height);
    const center = worldPixel(37.8199, -122.4783, zoom);
    for (const t of tiles) {
      expect(t.x * 256 - (center.x - width / 2)).toBeCloseTo(t.left, 6);
      expect(t.y * 256 - (center.y - height / 2)).toBeCloseTo(t.top, 6);
    }
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.left + 256))).toBeGreaterThanOrEqual(width);
    expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.top + 256))).toBeGreaterThanOrEqual(height);
  });
});

describe("navigation links", () => {
  const place = { name: "Café & Bar", address: "上海市黄浦区", lat: 31.2304, lng: 121.4737, zoom: 15 };

  it("offers the platform's own choice first: Android asks the system, iOS opens Apple Maps", () => {
    const android = navLinks(place, "android");
    expect(android[0]!.href).toBe("geo:31.2304,121.4737?q=31.2304,121.4737(Caf%C3%A9%20%26%20Bar)");
    expect(android.map((l) => l.id)).not.toContain("apple");
    const ios = navLinks(place, "ios");
    expect(ios[0]!.id).toBe("apple");
    expect(ios.map((l) => l.id)).toEqual(["apple", "amap", "baidu", "google", "waze"]);
    expect(ios.find((l) => l.id === "baidu")!.href).toMatch(/^baidumap:\/\/map\/direction\?/);
    expect(navLinks(place, "other").find((l) => l.id === "baidu")!.href).toMatch(/^https:\/\/api\.map\.baidu\.com\/marker\?/);
  });

  it("hands Chinese map apps GCJ-02 coordinates and encodes names", () => {
    const amap = navLinks(place, "ios").find((l) => l.id === "amap")!.href;
    const [gLat, gLng] = wgs84ToGcj02(place.lat, place.lng);
    expect(amap).toContain(`to=${gLng},${gLat},Caf%C3%A9%20%26%20Bar`);
    expect(amap).toContain("coordinate=gaode");
    expect(navLinks(place, "ios").find((l) => l.id === "google")!.href).toContain("destination=31.2304,121.4737");
  });

  it("searches by address when the place could not be located", () => {
    const links = navLinks({ ...place, lat: null, lng: null }, "ios");
    expect(links.find((l) => l.id === "apple")!.href).toBe(`https://maps.apple.com/?daddr=${encodeURIComponent("上海市黄浦区")}&dirflg=d`);
    expect(links.every((l) => !l.href.includes("null"))).toBe(true);
  });

  it("tells phones apart by user agent", () => {
    expect(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(platformOf("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe("other");
  });
});

describe("map tile and geocoding proxy", () => {
  const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

  it("accepts only real tiles", () => {
    expect(MapService.validTile(0, 0, 0)).toBe(true);
    expect(MapService.validTile(2, 3, 3)).toBe(true);
    expect(MapService.validTile(2, 4, 0)).toBe(false);
    expect(MapService.validTile(20, 0, 0)).toBe(false);
    expect(MapService.validTile(1.5, 0, 0)).toBe(false);
  });

  it("fetches each tile once with an identifying User-Agent, and refuses non-images", async () => {
    const fetchImpl = vi.fn(async () => png());
    const service = new MapService(fetchImpl as unknown as typeof fetch, 0);
    const [a, b] = await Promise.all([service.tile(15, 5241, 12663), service.tile(15, 5241, 12663)]);
    expect(a).toEqual(b);
    await service.tile(15, 5241, 12663);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tile.openstreetmap.org/15/5241/12663.png");
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(/AIO-Agent/);
    const html = new MapService((async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch, 0);
    expect(await html.tile(1, 0, 0)).toBeNull();
  });

  it("geocodes one request at a time and caches answers, including misses", async () => {
    let running = 0, peak = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return new Response(JSON.stringify(url.includes("nowhere") ? [] : [{ lat: "37.8199", lon: "-122.4783", display_name: "Golden Gate Bridge" }]));
    });
    const service = new MapService(fetchImpl as unknown as typeof fetch, 0);
    const [a, b, miss] = await Promise.all([service.geocode("Golden Gate Bridge"), service.geocode("Other place"), service.geocode("nowhere")]);
    expect(peak).toBe(1);
    expect(a).toEqual({ lat: 37.8199, lng: -122.4783, label: "Golden Gate Bridge" });
    expect(b).not.toBeNull();
    expect(miss).toBeNull();
    await service.geocode("golden gate bridge ");
    await service.geocode("nowhere");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
