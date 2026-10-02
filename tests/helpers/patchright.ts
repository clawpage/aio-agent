import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PATCH = path.resolve(import.meta.dirname, "../../scripts/patchright-patch.mjs");

/** A temporary copy of the installed patchright-core with the build's patch applied, as the sandbox runs it. */
export async function patchedPatchright(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patchright-core-"));
  fs.cpSync(path.dirname(require.resolve("patchright-core/package.json")), dir, { recursive: true });
  const { patchPatchright } = (await import(PATCH)) as { patchPatchright: (dir: string) => void };
  patchPatchright(dir);
  return dir;
}

export async function patchFn(): Promise<(dir: string) => void> {
  return ((await import(PATCH)) as { patchPatchright: (dir: string) => void }).patchPatchright;
}
