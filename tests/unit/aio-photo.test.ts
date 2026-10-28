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
                              background=bg, color=ap.STUDIO, subject="people", engine="basic", manual=False, auto=False, look=None, develop=None, soften=0.0)
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

  it("softens skin only: the people's skin takes the softer development, eyes, clothes and the background do not", () => {
    const r = py(`
import argparse, os
h, w = 400, 300
rgb = np.zeros((h, w, 3), np.uint8)
rgb[:] = (40, 120, 200)                    # a blue background
rgb[60:340, 60:240] = (60, 60, 160)        # dark blue clothes
rgb[60:200, 90:210] = (205, 150, 120)      # skin: a face
rgb[110:125, 115:140] = (30, 25, 25)       # an eye
rgb = np.clip(rgb.astype(int) + rng.normal(0, 6, rgb.shape), 0, 255).astype(np.uint8)
src = os.path.join(${JSON.stringify(dir)}, "skin.png"); Image.fromarray(rgb).save(src)
people = np.zeros((h, w), np.float32); people[55:345, 55:245] = 1.0
ap.subject_mask = lambda path, size, subject="people": people
ap.faces_in = lambda img: []
calls = []
def fake_develop(src_, dest, auto, settings, nudges=None):
    # Stands in for LightCraft: the softer development is a blur, the plain one the photo as it is.
    calls.append({"auto": auto, "settings": settings, "nudges": nudges})
    img = np.asarray(Image.open(src_).convert("RGB"))
    Image.fromarray(cv2.GaussianBlur(img, (0, 0), 3) if "effects.texture" in settings else img).save(dest)
    return {"exposure": 0.25} if auto else None
ap.develop = fake_develop
out = os.path.join(${JSON.stringify(dir)}, "skin-out.png")
args = argparse.Namespace(input=src, output=out, light=None, exposure=0.2, warmth=0.3, contrast=0.0, saturation=0.0,
                          background="keep", color=ap.STUDIO, subject="people", engine="lightcraft", manual=False, auto=False,
                          look=None, develop=["light.shadows=30"], soften=0.5)
ap.cmd_retouch(args)
res = np.asarray(Image.open(out)).astype(int)
diff = lambda a, b, c, d: float(np.abs(res[a:b, c:d] - rgb[a:b, c:d].astype(int)).mean())
print(json.dumps({"face": diff(150, 190, 100, 200), "eye": diff(112, 123, 118, 137), "clothes": diff(260, 330, 70, 230),
                  "background": diff(0, 40, 0, 300), "calls": calls, "light": args.light}))
`);
    // The face is softened, the eye beside it, the clothes and the background are untouched.
    expect(r.face).toBeGreaterThan(2);
    expect(r.eye).toBeLessThan(1);
    expect(r.clothes).toBeLessThan(1);
    expect(r.background).toBeLessThan(1);
    // LightCraft does all of the light and color: auto by default, the asked controls, the simple nudges in its own units;
    // one development as asked and one softer on top of the same.
    const nudges = { "light.exposure": 0.2, "wb.temp": 750 };
    expect(r.calls).toEqual([
      { auto: true, settings: { "light.shadows": 30 }, nudges },
      { auto: true, settings: { "light.shadows": 30, "effects.texture": -30, "effects.clarity": -6 }, nudges },
    ]);
    expect(r.light).toBe("none");
  });

  it("takes LightCraft's control ids and numbers, and refuses anything else before running it", () => {
    const r = py(`
import subprocess
ok = ap.develop_values(["light.shadows=40", "mixer.orange.sat=-5", "effects.dehaze=12.5"])
bad = []
for pair in ["rm -rf /=1", "light.shadows=a lot", "--set=1", "light=3"]:
    res = subprocess.run([sys.executable, "-I", "-c", "import importlib.util; s=importlib.util.spec_from_file_location('ap', %r); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.develop_values([%r])" % (spec.origin, pair)], capture_output=True, text=True)
    bad.append(json.loads(res.stdout)["ok"])
import argparse, contextlib, io, os
# The plain even adjustment (only when LightCraft cannot run) refuses what only LightCraft does, before reading anything.
src = os.path.join(${JSON.stringify(dir)}, "basic.png"); Image.fromarray(photo(60, 80)).save(src)
said = io.StringIO()
try:
    with contextlib.redirect_stdout(said):
        ap.cmd_retouch(argparse.Namespace(input=src, output=src + ".jpg", light=None, exposure=0.0, warmth=0.0, contrast=0.0, saturation=0.0,
                                          background="keep", color=ap.STUDIO, subject="people", engine="basic", manual=False, auto=False,
                                          look=None, develop=None, soften=0.3))
except SystemExit:
    pass
print(json.dumps({"ok": ok, "bad": bad, "looks": sorted(ap.LOOKS), "basic": json.loads(said.getvalue())}))
`);
    expect(r.ok).toEqual({ "light.shadows": 40, "mixer.orange.sat": -5, "effects.dehaze": 12.5 });
    expect(r.bad).toEqual([false, false, false, false]);
    expect(r.looks).toEqual(["bright", "clear", "sky"]);
    expect(r.basic).toEqual({ ok: false, error: expect.stringMatching(/need LightCraft/) });
  });
});
