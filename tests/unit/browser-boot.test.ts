import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BOOT_RELEASED_MARKER, patchGemInit } from "../../src/control/sandbox/browserBoot.js";

// /opt/gem/gem_init.sh exactly as the pinned image (1.11.0) ships it.
const source = fs.readFileSync(new URL("../fixtures/aio-gem-init-1.11.0.sh", import.meta.url), "utf8");

describe("a released browser is not started at boot", () => {
  it("adds one check after the image's own switch, once", () => {
    const patched = patchGemInit(source)!;
    expect(patched).toContain(`if [ -e "${BOOT_RELEASED_MARKER}" ]; then`);
    expect(patched.indexOf(BOOT_RELEASED_MARKER)).toBeGreaterThan(patched.indexOf("DISABLE_BROWSER"));
    expect(patched.indexOf(BOOT_RELEASED_MARKER)).toBeLessThan(patched.indexOf('python3 "${HELPER_SCRIPT}"'));
    expect(patchGemInit(patched)).toBe(patched);
    expect(patchGemInit("#!/bin/bash\nexit 0\n")).toBeNull();
  });

  it("skips the supervisor while the marker exists, and goes on as before without it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gem-init-"));
    const marker = path.join(dir, "boot-released");
    // The same script, with the marker and the image's runtime paths moved somewhere writable.
    const script = path.join(dir, "gem_init.sh");
    // (and the image's environment helper, which only exists in the image, left out).
    const runnable = patchGemInit(source)!.replace(". /opt/gem/gem_env.sh\ngem_env_prepare_defaults\n", "");
    fs.writeFileSync(script, runnable.replaceAll(BOOT_RELEASED_MARKER, marker).replaceAll("/var/run/gem", path.join(dir, "run")));
    const run = () => spawnSync("bash", [script], { env: { PATH: process.env.PATH, LOG_DIR: path.join(dir, "log") }, encoding: "utf8" });
    fs.writeFileSync(marker, "released\n");
    const released = run();
    expect(released.status).toBe(0);
    expect(released.stdout).toContain("browser was released before the stop");
    fs.rmSync(marker);
    const normal = run();
    // Past the check: it now looks for the image's supervisor (absent here) instead of skipping.
    expect(normal.stdout + normal.stderr).not.toContain("browser was released before the stop");
    expect(normal.stdout + normal.stderr).toContain("browser supervisor");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
