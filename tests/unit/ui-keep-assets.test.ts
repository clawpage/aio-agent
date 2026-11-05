import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const script = path.resolve(import.meta.dirname, "../../deploy/ui-keep-assets.mjs");
const build = (root: string, names: string[]) => {
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(root, "assets", n), n);
};
const keep = (fresh: string, previous: string, version: string, n = 3) => execFileSync(process.execPath, [script, fresh, previous, version, String(n)], { encoding: "utf8" });
const assets = (root: string) => fs.readdirSync(path.join(root, "assets")).sort();
const recorded = (root: string) => fs.readdirSync(path.join(root, ".builds")).sort();

it("keeps the last few builds' files beside a new UI build, so a console opened before a deploy still loads its own", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-keep-"));
  try {
    // The image serving now predates the records: its files count as one build.
    const v1 = path.join(dir, "v1");
    build(v1, ["index-A.js", "mermaid.core-A.js", "shared.css"]);
    const v2 = path.join(dir, "v2");
    build(v2, ["index-B.js", "mermaid.core-B.js", "shared.css"]);
    expect(keep(v2, v1, "v2")).toContain("keeps 2 build(s): v2, previous; 2 earlier file(s) carried over");
    expect(assets(v2)).toEqual(["index-A.js", "index-B.js", "mermaid.core-A.js", "mermaid.core-B.js", "shared.css"]);
    // A file of the new build is never replaced by an older one of the same name.
    expect(fs.readFileSync(path.join(v2, "assets", "shared.css"), "utf8")).toBe("shared.css");

    // From then on each build is recorded; only the newest `keep` builds' files stay.
    let previous = v2;
    for (const v of ["v3", "v4", "v5"]) {
      const next = path.join(dir, v);
      build(next, [`index-${v}.js`, `mermaid.core-${v}.js`]);
      keep(next, previous, v);
      previous = next;
    }
    expect(recorded(previous)).toEqual(["v3.json", "v4.json", "v5.json"]);
    expect(assets(previous)).toEqual(["index-v3.js", "index-v4.js", "index-v5.js", "mermaid.core-v3.js", "mermaid.core-v4.js", "mermaid.core-v5.js"]);

    // Without a previous image (a first install) the build stands alone; rebuilding a version replaces its record.
    const alone = path.join(dir, "alone");
    build(alone, ["index-Z.js"]);
    expect(keep(alone, alone, "z")).toContain("keeps 1 build(s): z; 0 earlier file(s)");
    // As the Dockerfile builds without one: the "previous" stage is a copy of this very build.
    const copy = path.join(dir, "copy");
    build(copy, ["index-Z.js"]);
    expect(keep(alone, copy, "z")).toContain("keeps 1 build(s): z; 0 earlier file(s)");
    const again = path.join(dir, "again");
    build(again, ["index-v5b.js"]);
    keep(again, previous, "v5");
    expect(recorded(again)).toEqual(["v3.json", "v4.json", "v5.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(again, ".builds", "v5.json"), "utf8")).assets).toEqual(["index-v5b.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
