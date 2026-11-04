/**
 * Where a cropped edit sits in its original (```compare blocks whose two photos differ in shape).
 * Both pictures are shrunk to a few dozen pixels and compared by their edges, not their colours,
 * since the edit is usually retouched as well: tone and colour change the values, the edges stay
 * where they were. A coarse pass tries every size and place the edit could have been cut from,
 * a finer one settles the best of them. A weak best match means the edit is not a plain crop
 * (reframed, expanded, rotated), and then there is nothing to point out.
 */

/** The kept part, in fractions of the original's width and height. */
export type CropBox = { x: number; y: number; w: number; h: number };

/** A picture scaled to w × h, as brightness 0–1, row by row. */
export type Sampler = (w: number, h: number) => Float32Array;

type Plane = { data: Float32Array; w: number; h: number };

const COARSE = 48;
const MIN_SCORE = 0.7;

/** Edge strength at each pixel (none on the rim, which has no neighbours on one side). */
function edges(luma: Float32Array, w: number, h: number): Plane {
  const data = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      data[i] = Math.abs(luma[i + 1]! - luma[i - 1]!) + Math.abs(luma[i + w]! - luma[i - w]!);
    }
  }
  return { data, w, h };
}

/** How alike the edit's edges are to the original's at (ox, oy): normalised cross-correlation over the edit's inside. */
function score(edit: Plane, base: Plane, ox: number, oy: number): number {
  let n = 0, se = 0, sb = 0, see = 0, sbb = 0, seb = 0;
  for (let y = 1; y < edit.h - 1; y++) {
    const er = y * edit.w, br = (y + oy) * base.w + ox;
    for (let x = 1; x < edit.w - 1; x++) {
      const a = edit.data[er + x]!, b = base.data[br + x]!;
      se += a; sb += b; see += a * a; sbb += b * b; seb += a * b; n++;
    }
  }
  if (!n) return -1;
  const ve = see - (se * se) / n, vb = sbb - (sb * sb) / n;
  return ve > 1e-9 && vb > 1e-9 ? (seb - (se * sb) / n) / Math.sqrt(ve * vb) : -1;
}

type Match = { s: number; x: number; y: number; w: number; h: number };

/** The best place for the edit at each width in `widths`, trying the offsets `offsets(w, h)` gives. */
function search(base: Plane, edit: Sampler, ratio: number, widths: number[], offsets: (w: number, h: number) => [number, number][]): Match {
  let best: Match = { s: -1, x: 0, y: 0, w: 0, h: 0 };
  for (const w of widths) {
    const h = Math.round(w / ratio);
    if (w < 6 || h < 6 || w > base.w || h > base.h) continue;
    const plane = edges(edit(w, h), w, h);
    for (const [x, y] of offsets(w, h)) {
      if (x < 0 || y < 0 || x + w > base.w || y + h > base.h) continue;
      const s = score(plane, base, x, y);
      if (s > best.s) best = { s, x, y, w, h };
    }
  }
  return best;
}

/**
 * The part of the original the edit kept, or null when the edit is not a crop of it that can be
 * told apart. `originalRatio` and `editRatio` are width / height.
 */
export function locateCrop(original: Sampler, originalRatio: number, edit: Sampler, editRatio: number): CropBox | null {
  const ch = Math.max(6, Math.round(COARSE / originalRatio));
  const coarse = search(edges(original(COARSE, ch), COARSE, ch), edit, editRatio,
    Array.from({ length: COARSE - Math.round(COARSE * 0.35) + 1 }, (_, i) => COARSE - i),
    (w, h) => Array.from({ length: (COARSE - w + 1) * (ch - h + 1) }, (_, i) => [i % (COARSE - w + 1), Math.floor(i / (COARSE - w + 1))]));
  if (coarse.s < 0) return null;
  const fw = COARSE * 2, fh = Math.max(12, Math.round(fw / originalRatio));
  const near: [number, number][] = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) near.push([coarse.x * 2 + dx, coarse.y * 2 + dy]);
  const fine = search(edges(original(fw, fh), fw, fh), edit, editRatio,
    [-2, -1, 0, 1, 2].map((d) => coarse.w * 2 + d), () => near);
  if (fine.s < MIN_SCORE) return null;
  return { x: fine.x / fw, y: fine.y / fh, w: fine.w / fw, h: fine.h / fh };
}

/** A sampler over a loaded picture: shrunk once to a small copy, so each sample is cheap and smooth. */
export function imageSampler(img: HTMLImageElement): Sampler {
  const ratio = img.naturalWidth / img.naturalHeight;
  const small = document.createElement("canvas");
  small.width = Math.min(img.naturalWidth, 256);
  small.height = Math.max(1, Math.round(small.width / ratio));
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(img, 0, 0, small.width, small.height);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return (w, h) => {
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const luma = new Float32Array(w * h);
    for (let i = 0; i < luma.length; i++) luma[i] = (0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!) / 255;
    return luma;
  };
}
