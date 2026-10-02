import fs from "node:fs";
import path from "node:path";

/** The release this process runs: stamped into images as AIO_VERSION, else the repository's package.json. */
export function appVersion(): string {
  if (process.env.AIO_VERSION) return process.env.AIO_VERSION;
  try {
    return (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "dev";
  }
}
