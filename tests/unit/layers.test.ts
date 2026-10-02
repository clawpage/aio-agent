import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The three layers are built, packaged and deployed on their own. Code may only
 * be shared through src/common, so a layer never imports another layer, and
 * common never imports any of them. The UI bundle runs in a browser (and later a
 * native shell), so it may only use common modules that need no Node APIs.
 */
const ROOT = path.resolve(import.meta.dirname, "..", "..", "src");
const LAYERS = ["ui", "control", "sandbox", "common"] as const;
const UI_SAFE_COMMON = new Set(["version.ts"]);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(full);
    return /\.(ts|tsx|mjs|cjs)$/.test(e.name) ? [full] : [];
  });
}

it("keeps every layer to itself and to src/common", () => {
  const problems: string[] = [];
  for (const layer of LAYERS) {
    for (const file of files(path.join(ROOT, layer))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from\s+|\bimport\s+|import\s*\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.relative(ROOT, path.resolve(path.dirname(file), m[1]!));
        const [targetLayer, ...rest] = target.split(path.sep);
        if (targetLayer === layer) continue;
        const where = `${path.relative(ROOT, file)} -> ${target}`;
        if (targetLayer !== "common" || layer === "common") problems.push(where);
        else if (layer === "ui" && !UI_SAFE_COMMON.has(rest.join("/").replace(/\.js$/, ".ts"))) problems.push(`${where} (not browser-safe)`);
      }
    }
  }
  expect(problems).toEqual([]);
});
