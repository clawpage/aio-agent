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

/** Strip URLs and long opaque blobs; mirrors the container-side redaction. */
export function redact(text: string, limit = 200): string {
  return text
    .replace(/[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s"'`)]+/g, "<url>")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
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
      const { body, digest } = this.#script();
      const marker = path.posix.join(this.#cfg.browser.toolDir, MARKER_NAME);
      const current = await this.#container.execInSandbox(["cat", marker], { timeoutMs: 15_000, user: "root" });
      if (current.code === 0 && current.stdout.trim() === digest) return;
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
      await this.#container.writeFileInSandbox(marker, `${digest}\n`, { user: "root" });
      this.#log.info("browser runtime helper provisioned", { path: this.scriptPath });
    })().catch((err) => {
      // A failed provision must be retried by the next call rather than cached.
      this.#provisioned = null;
      throw err;
    });
    return this.#provisioned;
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
    return { ok: res.ok, message: typeof res.message === "string" ? redact(res.message) : null };
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
