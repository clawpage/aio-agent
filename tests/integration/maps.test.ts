import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { maps } from "../../src/control/maps.js";

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.shutdown(); });

describe("map card endpoints", () => {
  it("serves proxied tiles only to signed-in sessions, and only real tiles", async () => {
    const tile = vi.spyOn(maps, "tile").mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    try {
      expect((await h.request("/api/map/tiles/15/5241/12663")).status).toBe(401);
      expect(tile).not.toHaveBeenCalled();
      const { cookie } = await login(h);
      const res = await h.request("/api/map/tiles/15/5241/12663", { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("private, max-age=604800");
      expect(tile).toHaveBeenCalledWith(15, 5241, 12663);
      for (const bad of ["/api/map/tiles/2/4/0", "/api/map/tiles/20/0/0", "/api/map/tiles/a/0/0", "/api/map/tiles/1/-1/0"]) {
        expect((await h.request(bad, { headers: { cookie } })).status).toBe(400);
      }
      tile.mockResolvedValueOnce(null);
      expect((await h.request("/api/map/tiles/1/0/0", { headers: { cookie } })).status).toBe(502);
    } finally { tile.mockRestore(); }
  });

  it("tells the console which map it draws, and serves Google static maps only when configured", async () => {
    const staticMap = vi.spyOn(maps, "staticMap").mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    const query = "lat=31.24&lng=121.49&zoom=15&w=480&h=150&lang=en";
    try {
      expect((await h.request("/api/map")).status).toBe(401);
      expect((await h.request(`/api/map/static?${query}`)).status).toBe(401);
      const { cookie } = await login(h);
      expect(await (await h.request("/api/map", { headers: { cookie } })).json()).toEqual({ provider: "osm" });
      expect((await h.request(`/api/map/static?${query}`, { headers: { cookie } })).status).toBe(404);
      maps.useGoogle("test-key");
      expect(await (await h.request("/api/map", { headers: { cookie } })).json()).toEqual({ provider: "google" });
      const res = await h.request(`/api/map/static?${query}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
      expect(staticMap).toHaveBeenCalledWith({ lat: 31.24, lng: 121.49, zoom: 15, width: 480, height: 150, lang: "en" });
      expect((await h.request("/api/map/static?lat=31.24&lng=121.49&zoom=15&w=9999&h=150", { headers: { cookie } })).status).toBe(400);
      staticMap.mockResolvedValueOnce(null);
      expect((await h.request(`/api/map/static?${query}`, { headers: { cookie } })).status).toBe(502);
    } finally { staticMap.mockRestore(); maps.useGoogle(""); }
  });

  it("geocodes an address for a signed-in session", async () => {
    const geocode = vi.spyOn(maps, "geocode").mockResolvedValue({ lat: 37.8199, lng: -122.4783, label: "Golden Gate Bridge" });
    try {
      expect((await h.request("/api/map/geocode?q=x")).status).toBe(401);
      const { cookie } = await login(h);
      expect((await h.request("/api/map/geocode", { headers: { cookie } })).status).toBe(400);
      expect((await h.request(`/api/map/geocode?q=${"a".repeat(201)}`, { headers: { cookie } })).status).toBe(400);
      const res = await h.request(`/api/map/geocode?q=${encodeURIComponent("金门大桥")}`, { headers: { cookie } });
      expect(await res.json()).toEqual({ place: { lat: 37.8199, lng: -122.4783, label: "Golden Gate Bridge" } });
      expect(geocode).toHaveBeenCalledWith("金门大桥");
      geocode.mockRejectedValueOnce(new Error("down"));
      expect((await h.request("/api/map/geocode?q=y", { headers: { cookie } })).status).toBe(502);
    } finally { geocode.mockRestore(); }
  });
});
