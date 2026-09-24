// The document tools are shell/python assets, not TypeScript, so `tsc` does not
// emit them. Copy them next to the compiled service so `dist/server` is a
// complete, runnable artifact (the service reads them relative to its own dir).
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const from = path.join(root, "src", "server", "documents", "scripts");
const to = path.join(root, "dist", "server", "documents", "scripts");

await mkdir(path.dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied server document assets -> ${path.relative(root, to)}`);
