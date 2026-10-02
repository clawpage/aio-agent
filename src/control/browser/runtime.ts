/**
 * Container-side adapter for the sandbox browser lifecycle.
 *
 * The control plane never signals a process itself: it writes the managed helper
 * into the persistent tool directory and invokes it, one subcommand per call.
 * The helper is the only thing that touches `/proc`, the pid files and the
 * upstream supervisor, so the ownership checks live next to the signal.
 *
 * Three properties matter more than throughput here:
 *  - `status()` is read-only. It never starts, wakes or extends anything, so a
 *    health poll cannot keep a browser awake.
 *  - A browser whose ownership cannot be *proved* is reported as `null` running
 *    with `browserAttribution: "unknown"`, never as "not running". Verified real
 *    case: this sandbox's Chromium flattens its command line into one token.
 *  - Every failure message is redacted before it leaves this module, because a
 *    runtime error can quote a page URL or a serialized storage value.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SandboxContainer } from "../docker/sandbox.js";
import type { BrowserRuntimeLike, RuntimeStatus, SnapshotOutcome, StopOutcome, WakeOutcome } from "./lifecycle.js";
import type { SnapshotWarning } from "./types.js";

/** Bundled files written into the sandbox's persistent tool directory. */
const SCRIPT_NAME = "browser-runtime.py";
const MARKER_NAME = ".browser-runtime.sha256";
/**
 * The node storage helper and its vendored patchright-core (Playwright without
 * the CDP traces sites use to flag automation). They live beside the
 * python helper so the container never has to download a package: the tree is
 * shipped as one version-pinned tarball and extracted through the managed tool dir.
 */
const STORAGE_HELPER_NAME = "browser-storage.cjs";
const STORAGE_VENDOR_DIR = "patchright-core";
const STORAGE_VENDOR_TGZ = "patchright-core.tgz";
const STORAGE_MARKER_NAME = ".browser-storage.sha256";

/** Strip URLs and long opaque blobs; mirrors the container-side redaction. */
export function redact(text: string, limit = 200): string {
  return text
    .replace(/[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s"'`)]+/g, "<url>")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Read the content-free storage counts a helper result may carry. */
function readStorageCounts(
  raw: unknown,
): { cookies: number; origins: number; localStorageEntries: number; indexedDbDatabases: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const num = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : 0);
  return {
    cookies: num("cookies"),
    origins: num("origins"),
    localStorageEntries: num("localStorageEntries"),
    indexedDbDatabases: num("indexedDbDatabases"),
  };
}

interface HelperResult {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
}

export class BrowserRuntime implements BrowserRuntimeLike {
  #cfg: Config;
  #log: Logger;
  #container: SandboxContainer;
  #provisioned: Promise<void> | null = null;

  constructor(cfg: Config, log: Logger, container: SandboxContainer) {
    this.#cfg = cfg;
    this.#log = log;
    this.#container = container;
  }

  get scriptPath(): string {
    return path.posix.join(this.#cfg.browser.toolDir, SCRIPT_NAME);
  }

  get snapshotPath(): string {
    return this.#cfg.browser.snapshotPath;
  }

  /** Bundled helper source + its content hash, so a stale copy is replaced. */
  #script(): { body: string; digest: string } {
    const body = fs.readFileSync(path.join(import.meta.dirname, "scripts", SCRIPT_NAME), "utf8");
    return { body, digest: createHash("sha256").update(body).digest("hex") };
  }

  /** The storage helper's source and the vendored dependency tarball, hashed together. */
  #storageAssets(): { body: string; vendor: Buffer; digest: string } {
    const body = fs.readFileSync(path.join(import.meta.dirname, "scripts", STORAGE_HELPER_NAME), "utf8");
    const bundled = path.join(import.meta.dirname, "vendor", STORAGE_VENDOR_TGZ);
    const vendor = fs.readFileSync(fs.existsSync(bundled) ? bundled :
      path.resolve(import.meta.dirname, "../../../dist/control/browser/vendor", STORAGE_VENDOR_TGZ));
    const digest = createHash("sha256").update(body).update(vendor).digest("hex");
    return { body, vendor, digest };
  }

  /**
   * Write the helper into the persistent tool directory once per process, and
   * only when its digest changed. A normal call is then a single cheap `cat`.
   *
   * It runs as root (the sandbox user cannot be allowed to edit what root
   * executes) and is idempotent, so a crashed control plane simply rewrites it.
   */
  async ensureScripts(): Promise<void> {
    if (this.#provisioned) return this.#provisioned;
    this.#provisioned = (async () => {
      // Root must not execute scripts below sandbox-user-writable ancestors.
      const secure = await this.#container.execInSandbox(["python3", "-c", `
import os, pathlib, stat, sys
p = pathlib.Path(sys.argv[1])
if not p.is_absolute() or ".." in p.parts: sys.exit(1)
for part in [p, *p.parents]:
    if part.is_symlink(): sys.exit(1)
    if not part.exists(): continue
    s = part.stat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0: sys.exit(1)
    if s.st_mode & 0o022 and not (part != p and s.st_mode & stat.S_ISVTX): sys.exit(1)
p.mkdir(parents=True, exist_ok=True, mode=0o755)
`, this.#cfg.browser.toolDir], { timeoutMs: 15_000, user: "root" });
      if (secure.code !== 0) throw new Error("浏览器工具目录必须由 root 管理且不可由沙盒用户替换");
      const { body, digest } = this.#script();
      const marker = path.posix.join(this.#cfg.browser.toolDir, MARKER_NAME);
      const current = await this.#container.execInSandbox(["cat", marker], { timeoutMs: 15_000, user: "root" });
      if (current.code === 0 && current.stdout.trim() === digest) {
        await this.#provisionStorage();
        return;
      }
      const mkdir = await this.#container.execInSandbox(["mkdir", "-p", this.#cfg.browser.toolDir], {
        timeoutMs: 15_000,
        user: "root",
      });
      if (mkdir.code !== 0) {
        throw new Error(`无法创建浏览器工具目录：${redact(mkdir.stderr || mkdir.stdout)}`);
      }
      await this.#container.writeFileInSandbox(this.scriptPath, body, { user: "root" });
      const chmod = await this.#container.execInSandbox(["chmod", "0755", this.scriptPath], {
        timeoutMs: 15_000,
        user: "root",
      });
      if (chmod.code !== 0) {
        throw new Error(`无法设置浏览器工具脚本权限：${redact(chmod.stderr || chmod.stdout)}`);
      }
      await this.#provisionStorage();
      await this.#container.writeFileInSandbox(marker, `${digest}\n`, { user: "root" });
      this.#log.info("browser runtime helper provisioned", { path: this.scriptPath });
    })().catch((err) => {
      // A failed provision must be retried by the next call rather than cached.
      this.#provisioned = null;
      throw err;
    });
    return this.#provisioned;
  }

  /**
   * Install the node storage helper and its vendored patchright-core. A missing
   * dependency is a hard failure for the caller: a snapshot without cookies /
   * localStorage / IndexedDB is not a complete snapshot and must never authorise
   * a release. The tarball is extracted as root into a managed directory, never
   * into the owner's profile or a global node prefix.
   */
  async #provisionStorage(): Promise<void> {
    const { body, vendor, digest } = this.#storageAssets();
    const marker = path.posix.join(this.#cfg.browser.toolDir, STORAGE_MARKER_NAME);
    const current = await this.#container.execInSandbox(["cat", marker], { timeoutMs: 15_000, user: "root" });
    if (current.code === 0 && current.stdout.trim() === digest) return;
    const helperPath = path.posix.join(this.#cfg.browser.toolDir, STORAGE_HELPER_NAME);
    await this.#container.writeFileInSandbox(helperPath, body, { user: "root" });
    const chmod = await this.#container.execInSandbox(["chmod", "0755", helperPath], {
      timeoutMs: 15_000,
      user: "root",
    });
    if (chmod.code !== 0) {
      throw new Error(`无法设置浏览器存储脚本权限：${redact(chmod.stderr || chmod.stdout)}`);
    }
    // The dependency already exists on an unchanged sandbox; the marker digest
    // above is what decides reuse, so a re-extract only happens on a real change.
    const vendorDir = path.posix.join(this.#cfg.browser.toolDir, STORAGE_VENDOR_DIR);
    const extract = await this.#container.execInSandbox(
      ["bash", "-lc", 'mkdir -p "$1" && base64 -d | tar -xz -C "$1"', "browser-storage", vendorDir],
      { timeoutMs: 120_000, user: "root", stdin: vendor.toString("base64") },
    );
    if (extract.code !== 0) {
      throw new Error(`无法安装浏览器存储依赖：${redact(extract.stderr || extract.stdout)}`);
    }
    await this.#container.writeFileInSandbox(marker, `${digest}\n`, { user: "root" });
    this.#log.info("browser storage helper provisioned", { dir: vendorDir });
  }

  /** Run one helper subcommand and parse its single-line JSON result. */
  async #run(argv: string[], timeoutMs: number): Promise<HelperResult> {
    await this.ensureScripts();
    const result = await this.#container.execInSandbox(["python3", this.scriptPath, ...argv], {
      timeoutMs,
      user: "root",
    });
    const text = (result.stdout || "").trim();
    if (!text) {
      return { ok: false, message: `浏览器运行时无输出（exit ${result.code}）：${redact(result.stderr)}` };
    }
    try {
      const parsed = JSON.parse(text.split("\n").pop() ?? text) as HelperResult;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") {
        return { ok: false, message: "浏览器运行时返回了无法识别的结果" };
      }
      return parsed;
    } catch {
      return { ok: false, message: `浏览器运行时返回了非 JSON 结果：${redact(text)}` };
    }
  }

  /** Shared read-only argument set. */
  #baseArgs(): string[] {
    return [`--snapshot`, this.snapshotPath];
  }

  async status(opts: { timeoutMs?: number } = {}): Promise<RuntimeStatus> {
    const res = await this.#run(["status", ...this.#baseArgs()], opts.timeoutMs ?? this.#cfg.browser.helperTimeoutMs);
    const attribution = (res.browserAttribution ?? null) as RuntimeStatus["browserAttribution"];
    const running =
      typeof res.browserRunning === "boolean" ? res.browserRunning : res.browserRunning === null ? null : null;
    return {
      ok: res.ok,
      browserRunning: running,
      browserAttribution: attribution,
      supervisorRunning: res.supervisorRunning === true,
      pid: typeof res.pid === "number" ? res.pid : null,
      starttime: typeof res.starttime === "number" ? res.starttime : null,
      version: typeof res.version === "string" ? res.version : null,
      message: typeof res.message === "string" ? redact(res.message) : null,
      snapshotAt: typeof res.snapshotAt === "number" ? res.snapshotAt : null,
      restoredSnapshotAt: typeof res.restoredSnapshotAt === "number" ? res.restoredSnapshotAt : null,
      restorePending: res.restorePending === true,
      pendingBrowserPid: typeof res.pendingBrowserPid === "number" ? res.pendingBrowserPid : null,
      pendingBrowserStarttime: typeof res.pendingBrowserStarttime === "number" ? res.pendingBrowserStarttime : null,
      snapshotSchema: typeof res.snapshotSchema === "number" ? res.snapshotSchema : null,
      // Absent means "cannot prove it has storage", which is the conservative
      // reading: the core must never release on a snapshot it cannot vouch for.
      snapshotHasStorage: res.snapshotHasStorage === true,
      storageCounts: readStorageCounts(res.storageCounts),
      transitionBusy: res.transitionBusy === true,
    };
  }

  async snapshot(opts: { timeoutMs?: number } = {}): Promise<SnapshotOutcome> {
    const res = await this.#run(
      ["snapshot", ...this.#baseArgs(), "--policy", this.#cfg.browser.dirtyInputPolicy],
      opts.timeoutMs ?? this.#cfg.browser.helperTimeoutMs,
    );
    return {
      ok: res.ok,
      savedAt: typeof res.savedAt === "number" ? res.savedAt : null,
      tabs: typeof res.tabs === "number" ? res.tabs : undefined,
      skipped: typeof res.skipped === "number" ? res.skipped : 0,
      warnings: Array.isArray(res.warnings) ? (res.warnings as SnapshotWarning[]) : [],
      blocked: res.blocked === true,
      orderVerified: res.orderVerified === true,
      storageCounts: readStorageCounts(res.storageCounts),
      reason: typeof res.reason === "string" ? res.reason : null,
      message: typeof res.message === "string" ? redact(res.message) : null,
    };
  }

  async stop(opts: { timeoutMs?: number; sourcePid?: number | null; sourceStarttime?: number | null } = {}): Promise<StopOutcome> {
    const argv = ["stop", ...this.#baseArgs()];
    // Hand the helper the identity the control plane verified, so it re-checks
    // ownership against the same process rather than trusting the pid file alone.
    if (typeof opts.sourcePid === "number") argv.push("--source-pid", String(opts.sourcePid));
    if (typeof opts.sourceStarttime === "number") argv.push("--source-starttime", String(opts.sourceStarttime));
    const res = await this.#run(argv, opts.timeoutMs ?? this.#cfg.browser.stopTimeoutMs);
    return { ok: res.ok, message: typeof res.message === "string" ? redact(res.message) : null,
      reason: typeof res.reason === "string" ? res.reason : null };
  }

  async wake(opts: { timeoutMs?: number } = {}): Promise<WakeOutcome> {
    const timeoutMs = opts.timeoutMs ?? this.#cfg.browser.wakeTimeoutMs;
    // The helper's own wait budget must fit inside the exec timeout.
    const res = await this.#run(
      ["wake", ...this.#baseArgs(), "--wait-ms", String(Math.max(1_000, timeoutMs - 5_000))],
      timeoutMs,
    );
    return {
      ok: res.ok,
      restoredTabs: typeof res.restoredTabs === "number" ? res.restoredTabs : null,
      message: typeof res.message === "string" ? redact(res.message) : null,
    };
  }
}
