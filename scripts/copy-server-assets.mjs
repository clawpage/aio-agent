// The document and browser tools are shell/python assets, not TypeScript, so
// `tsc` does not emit them. Copy them next to the compiled service so
// `dist/control` is a complete, runnable artifact (each service reads its assets
// relative to its own directory).
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { packPatchright } from "./patchright-patch.mjs";

const root = path.resolve(import.meta.dirname, "..");

/** [source directory, dist directory] pairs, kept in the same tree layout. */
const assetTrees = [
  ["src/control/documents/scripts", "dist/control/documents/scripts"],
  ["src/control/browser/scripts", "dist/control/browser/scripts"],
];

for (const [from, to] of assetTrees) {
  const target = path.join(root, to);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, from), target, { recursive: true, filter: source => !source.includes("__pycache__") && !source.endsWith(".pyc") });
  console.log(`copied server assets -> ${to}`);
}

// Build the offline runtime dependency from the exact lockfile dependency.
// No registry request, browser download, or checked-in generated archive.
// It is patched in a staging copy (see patchright-patch.mjs); node_modules stays as installed.
const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve("patchright-core/package.json"));
const vendor = path.join(root, "dist/control/browser/vendor");
await mkdir(vendor, { recursive: true });
packPatchright(packageDir, path.join(vendor, "patchright-core.tgz"));
console.log("packaged offline patchright-core runtime (patched)");
