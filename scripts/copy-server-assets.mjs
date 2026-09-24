// The document and browser tools are shell/python assets, not TypeScript, so
// `tsc` does not emit them. Copy them next to the compiled service so
// `dist/server` is a complete, runnable artifact (each service reads its assets
// relative to its own directory).
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** [source directory, dist directory] pairs, kept in the same tree layout. */
const assetTrees = [
  ["src/server/documents/scripts", "dist/server/documents/scripts"],
  ["src/server/browser/scripts", "dist/server/browser/scripts"],
];

for (const [from, to] of assetTrees) {
  const target = path.join(root, to);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, from), target, { recursive: true });
  console.log(`copied server assets -> ${to}`);
}
