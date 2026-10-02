import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { packFn, patchedPatchright, patchFn } from "../helpers/patchright.js";

// Real headless Chromium, like tab-server.test.ts: skipped where Playwright's Chromium is missing.
const hasChromium = fs.existsSync(chromium.executablePath());
const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/patchright-crash-read.cjs");
let patched = "";

beforeAll(async () => {
  patched = await patchedPatchright();
});
afterAll(() => {
  if (patched) fs.rmSync(patched, { recursive: true, force: true });
});

it.skipIf(!hasChromium)("fails a read of a page that crashed before anything read it, instead of spinning forever", async () => {
  // Unpatched, this child never prints: its event loop spins until the timeout kills it
  // (with SIGKILL: a spinning loop never runs Playwright's SIGTERM handler).
  const out = await new Promise<string>((resolve) => {
    execFile(process.execPath, [FIXTURE, patched], { timeout: 30_000, killSignal: "SIGKILL", cwd: path.resolve(import.meta.dirname, "../..") }, (_err, stdout) => resolve(stdout));
  });
  expect(JSON.parse(out.trim().split("\n").pop() || "{}")).toEqual({ result: expect.stringMatching(/^error: .*closed/) });
}, 40_000);

it("is idempotent and refuses a patchright-core it does not fit", async () => {
  const patch = await patchFn();
  const bundle = path.join(patched, "lib", "coreBundle.js");
  const once = fs.readFileSync(bundle, "utf8");
  patch(patched);
  expect(fs.readFileSync(bundle, "utf8")).toBe(once);
  expect(once.match(/aio: fail on a dead session/g)).toHaveLength(2);

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "patchright-other-"));
  try {
    fs.mkdirSync(path.join(other, "lib"));
    fs.writeFileSync(path.join(other, "lib", "coreBundle.js"), "async _context(world) { return this._mainWorld; }\n");
    expect(() => patch(other)).toThrow(/expected 2 context retries/);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

it("packs a tarball the sandbox user can load after root extracts it", async () => {
  const pack = await packFn();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patchright-pack-"));
  try {
    const tarball = path.join(dir, "patchright-core.tgz");
    pack(path.dirname(createRequire(import.meta.url).resolve("patchright-core/package.json")), tarball);
    // The root entry's mode becomes the extracted directory's mode (a 0700 one locked the tab server out).
    const listing = await new Promise<string>((resolve, reject) => execFile("tar", ["-tvzf", tarball], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))));
    const root = listing.split("\n").find((line) => / \.\/?$/.test(line))!;
    expect(root.slice(0, 10)).toBe("drwxr-xr-x");
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    await new Promise<void>((resolve, reject) => execFile("tar", ["-xzf", tarball, "-C", out], (err) => (err ? reject(err) : resolve())));
    expect(fs.readFileSync(path.join(out, "lib", "coreBundle.js"), "utf8").match(/aio: fail on a dead session/g)).toHaveLength(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
