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
