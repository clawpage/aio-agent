import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PHOTO_CLI_PY } from "../../src/control/sandbox/seed.js";

// The CLI's image code needs numpy, OpenCV and Pillow (the sandbox has them); without them here these checks are skipped.
const hasLibraries = spawnSync("python3", ["-I", "-c", "import numpy, cv2, PIL"]).status === 0;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-aio-photo-"));
fs.writeFileSync(path.join(dir, "aio-photo.py"), PHOTO_CLI_PY);

/** Run a Python snippet with the CLI loaded as module `ap` (rembg and the face model replaced by fakes). */
const py = (body: string) => JSON.parse(execFileSync("python3", ["-I", "-c", `
import importlib.util, json, sys
import numpy as np, cv2
from PIL import Image
spec = importlib.util.spec_from_file_location("ap", ${JSON.stringify(path.join(dir, "aio-photo.py"))})
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)
rng = np.random.default_rng(3)
def photo(w=600, h=800):
    # A textured "photo": smooth light falloff plus fine detail everywhere, as skin and fabric have.
    y, x = np.mgrid[0:h, 0:w]
    base = np.stack([120 + 60 * np.sin(x / 90.0), 110 + 50 * np.cos(y / 70.0), 100 + 40 * np.sin((x + y) / 110.0)], axis=2)
    return np.clip(base + rng.normal(0, 18, (h, w, 3)), 0, 255).astype(np.uint8)
${body}
`], { encoding: "utf8", timeout: 60_000 }).trim().split("\n").at(-1)!);

describe.skipIf(!hasLibraries)("aio-photo", () => {
  it("keeps the people's pixels exactly: inside the cut-out the result is the original with the same color change as everywhere", () => {
    const r = py(`
import argparse, os
rgb = photo()
src = os.path.join(${JSON.stringify(dir)}, "in.png"); Image.fromarray(rgb).save(src)
h, w = rgb.shape[:2]
yy, xx = np.mgrid[0:h, 0:w]
person = (((xx - 300) / 150.0) ** 2 + ((yy - 420) / 300.0) ** 2 <= 1).astype(np.float32)
ap.subject_mask = lambda path, size, subject="people": person
ap.faces_in = lambda img: []
results = {}
for bg in ("studio", "smooth"):
    out = os.path.join(${JSON.stringify(dir)}, "out-%s.png" % bg)
    args = argparse.Namespace(input=src, output=out, light="auto", exposure=0.0, warmth=0.3, contrast=0.15, saturation=0.0,
                              background=bg, color=ap.STUDIO, subject="people")
    ap.cmd_retouch(args)
    res = np.asarray(Image.open(out))
    probe = cv2.resize(rgb, (384, 512), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    weight = cv2.resize(person, (384, 512), interpolation=cv2.INTER_AREA)
    tables = ap.tone_tables(probe, "auto", 0.0, 0.3, 0.15, weight)
    expected = ap.adjust(rgb, tables, 0.0)
    inner = cv2.erode(person.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    outside = person == 0
    results[bg] = {"size": list(res.shape[:2]), "inner_max_diff": int(np.abs(res[inner].astype(int) - expected[inner].astype(int)).max()),
                   "background_changed": float(np.abs(res[outside].astype(int) - expected[outside].astype(int)).mean()),
                   "cutout": os.path.exists(os.path.splitext(out)[0] + "-cutout.jpg")}
print(json.dumps(results))
`);
    for (const bg of ["studio", "smooth"]) {
      expect(r[bg].size).toEqual([800, 600]);
      // Not one pixel inside the person differs from the evenly adjusted original.
      expect(r[bg].inner_max_diff).toBe(0);
      expect(r[bg].background_changed).toBeGreaterThan(5);
      expect(r[bg].cutout).toBe(true);
    }
  });

  it("tells a retouched face from a redrawn one, however strong the light and color change", () => {
    const r = py(`
rgb = photo(400, 400)
f = rgb.astype(np.float32) / 255.0
graded = [ap.detail_similarity(f, ap.adjust(rgb, ap.tone_tables(f, "auto", e, w, c), s).astype(np.float32) / 255.0)
          for e, w, c, s in ((0.2, 0.4, 0.2, 0.1), (0.5, 0.8, 0.4, 0.2), (-0.3, -0.5, -0.2, -0.15))]
redrawn = ap.detail_similarity(f, photo(400, 400).astype(np.float32) / 255.0)
print(json.dumps({"graded": graded, "redrawn": redrawn, "threshold": ap.SIMILAR}))
`);
    for (const g of r.graded) expect(g).toBeGreaterThan(r.threshold + 0.05);
    expect(r.redrawn).toBeLessThan(0.3);
  });

  it("warns when the cut-out keeps a head without its body, or leaves a face out", () => {
    const r = py(`
img = Image.fromarray(photo())
ap.faces_in = lambda im: [[250, 150, 100, 120]]
body = np.zeros((800, 600), np.float32); body[140:780, 180:420] = 1
head = np.zeros((800, 600), np.float32); head[140:280, 240:360] = 1
none = np.zeros((800, 600), np.float32)
print(json.dumps({"body": ap.cutout_warnings(img, body), "head": ap.cutout_warnings(img, head), "none": ap.cutout_warnings(img, none)}))
`);
    expect(r.body).toEqual([]);
    expect(r.head[0]).toContain("cut off below the head");
    expect(r.none[0]).toContain("not in the cut-out");
  });

  it("never writes over the original", () => {
    const src = path.join(dir, "same.png");
    const r = spawnSync("python3", ["-I", "-c", `
import importlib.util, argparse, numpy as np
from PIL import Image
spec = importlib.util.spec_from_file_location("ap", ${JSON.stringify(path.join(dir, "aio-photo.py"))})
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)
Image.fromarray(np.zeros((10, 10, 3), np.uint8)).save(${JSON.stringify(src)})
ap.cmd_retouch(argparse.Namespace(input=${JSON.stringify(src)}, output=${JSON.stringify(src)}))
`], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("the original stays");
  });
});
