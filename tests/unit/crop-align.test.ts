import { describe, expect, it } from "vitest";
import { locateCrop, type Sampler } from "../../src/ui/src/cropAlign";

/** A made-up photo: soft blobs on a slope, as brightness at a point in its 0–1 square. */
function scene(seed: number) {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const blobs = Array.from({ length: 14 }, () => ({ x: rand(), y: rand(), r: 0.04 + rand() * 0.1, v: rand() - 0.5 }));
  return (x: number, y: number) => 0.3 + 0.2 * y + blobs.reduce((sum, b) => sum + b.v * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r)), 0);
}

/** Samples part of a scene (x0, y0, w, h in its fractions) at w × h pixels, with a tone change on top. */
function sampler(f: (x: number, y: number) => number, box = { x: 0, y: 0, w: 1, h: 1 }, tone = (v: number) => v): Sampler {
  return (w, h) => {
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = tone(f(box.x + ((i + 0.5) / w) * box.w, box.y + ((j + 0.5) / h) * box.h));
    return out;
  };
}

describe("locateCrop", () => {
  const photo = scene(7);

  it("finds a 4:5 crop of a 3:4 photo even after a tone change", () => {
    // Original 3000 × 4000; the edit keeps 2400 × 3000 from (300, 700): the empty top is gone.
    const kept = { x: 0.1, y: 0.175, w: 0.8, h: 0.75 };
    const found = locateCrop(sampler(photo), 3 / 4, sampler(photo, kept, (v) => 0.15 + 0.7 * v * v), 4 / 5)!;
    expect(found).not.toBeNull();
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(found[k] - kept[k])).toBeLessThan(0.03);
  });

  it("finds a portrait crop of a landscape photo", () => {
    const kept = { x: 0.5, y: 0, w: 0.4, h: 1 };
    // 1600 × 900 original; the crop is 640 × 900.
    const found = locateCrop(sampler(photo), 16 / 9, sampler(photo, kept), 640 / 900)!;
    expect(found).not.toBeNull();
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(found[k] - kept[k])).toBeLessThan(0.03);
  });

  it("finds nothing when the edit is not cut from the original", () => {
    expect(locateCrop(sampler(photo), 3 / 4, sampler(scene(99)), 4 / 5)).toBeNull();
  });
});
