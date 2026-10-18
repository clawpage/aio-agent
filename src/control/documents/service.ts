import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { SandboxContainer } from "../sandbox/container.js";
import { looksLikeSvg } from "../../common/svg.js";
import { t, type Messages } from "../i18n/index.js";
import {
  documentKind,
  mediaSignatureMatches,
  extensionOf,
  isInsideWorkspace,
  isRenderableKind,
  quoteArg,
  splitPath,
  withExtension,
  type DocumentKind,
} from "./paths.js";

/** Formats the sandbox is allowed to convert *to*. */
const CONVERT_TARGETS = new Set(["pdf", "docx", "xlsx", "pptx", "csv", "txt", "odt", "ods", "odp", "html"]);

/** Absolute bounds shared with the container-side scripts. */
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_RENDER_PAGES = 50;
/** A single raster page above this is refused before it enters the cache. */
/** An image served inline is bounded too, so a huge "image" cannot be streamed. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** A web picture in a message (a product photo, say): fetched by the sandbox, bounded, cached. */
const MAX_WEB_IMAGE_BYTES = 6 * 1024 * 1024;
const WEB_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const WEB_IMAGE_TTL_MS = 24 * 3600_000;
const WEB_IMAGE_FAILED_TTL_MS = 5 * 60_000;
/** Runs in the sandbox with the URL as its only argument; prints the bytes as base64. */
const WEB_IMAGE_SCRIPT = `import base64, sys, urllib.request
limit = ${MAX_WEB_IMAGE_BYTES}
req = urllib.request.Request(sys.argv[1], headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36", "Accept": "image/webp,image/png,image/jpeg,image/*;q=0.8"})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read(limit + 1)
except Exception as e:
    sys.stderr.write(type(e).__name__)
    sys.exit(2)
if len(data) > limit:
    sys.exit(3)
sys.stdout.write(base64.b64encode(data).decode())
`;

/**
 * Identify an image by its leading bytes. The extension already said "image";
 * this is what stops a file that merely *ends* in `.png` from being served with
 * an image content type.
 */
function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand.startsWith("avif") || brand.startsWith("avis") || brand.startsWith("mif1")) return "image/avif";
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return null;
}

/**
 * Sandbox document service: readiness probing, bounded conversion, and a
 * memory cache of rendered page rasters.
 *
 * Division of labour: the sandbox parses the document (LibreOffice/poppler); the
 * control plane only runs fixed argv, fetches the produced PNGs, and serves them
 * as authenticated images. The control plane never parses Office/PDF bytes and
 * never returns a host file.
 */

export interface DocumentReadiness {
  enabled: boolean;
  ready: boolean;
  previewReady: boolean;
  authoringReady: boolean;
  version: string | null;
  tools: Record<string, boolean>;
  python: Record<string, boolean>;
  missing: string[];
  /** Populated when provisioning failed; shown to the user, never a secret. */
  error: string | null;
  checkedAt: number;
}

export interface RenderPage {
  index: number;
  bytes: Buffer;
}

export interface RenderResult {
  kind: DocumentKind;
  pageCount: number;
  totalPages: number;
  truncated: boolean;
  size: number;
  pages: RenderPage[];
  /** Identity of the source revision the cache entry was built from. */
  signature: string;
}

export type DocumentErrorCode =
  | "disabled"
  | "outside_workspace"
  | "not_found"
  | "not_a_file"
  | "too_large"
  | "empty_file"
  | "unsupported"
  | "tools_not_ready"
  | "convert_failed"
  | "render_failed"
  | "missing_tool"
  | "timeout"
  | "busy"
  | "sandbox_unreachable"
  | "bad_request"
  | "page_unavailable"
  | "fetch_failed";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly status: number;
  constructor(code: DocumentErrorCode, message: string, status = 400) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.status = status;
  }
}

/**
 * A bounded counting semaphore so conversions cannot pile up.
 *
 * The waiter queue is capped: an unbounded queue would let a burst of preview
 * requests hold one pending promise (and one container exec slot) each until the
 * process ran out of memory. Beyond the cap the caller is told to retry instead.
 */
class Semaphore {
  #limit: number;
  #maxWaiters: number;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(limit: number, maxWaiters = limit * 4) {
    this.#limit = Math.max(1, limit);
    this.#maxWaiters = Math.max(1, maxWaiters);
  }

  /** Throws when the queue is saturated; the caller maps that to HTTP 429. */
  async acquire(): Promise<() => void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return () => this.#release();
    }
    if (this.#waiters.length >= this.#maxWaiters) {
      throw new DocumentError("busy", t().documents.busy, 429);
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
    return () => this.#release();
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    const next = this.#waiters.shift();
    if (next) next();
  }
}

interface CacheEntry {
  result: RenderResult;
  bytes: number;
}

// `lo-run.sh` is invoked by render.sh from the same directory, so it must be
// written too; `install-root.sh` is deliberately NOT written into the sandbox -
// its content is supplied to root as fixed argv by the control plane, so the
// sandbox user can never edit what root executes.
const SCRIPT_FILES = ["render.sh", "lo-run.sh", "provision.sh", "aio-doc"] as const;
type ScriptName = (typeof SCRIPT_FILES)[number];

/**
 * `stat` inside the container, with fixed argv: no shell, no expansion.
 *
 * `realPath` is the container's own `realpath` result, already confirmed to be
 * inside the workspace. Every later step uses *that* path, so a symlink whose
 * lexical form looked valid but points outside the workspace is rejected here -
 * not only in the render script. `mtimeToken` keeps LibreOffice's nanosecond
 * precision (`stat %y`), because a second-precision timestamp cannot tell two
 * fast edits of a same-sized file apart and would serve a stale preview.
 */
interface SandboxStat {
  exists: boolean;
  isFile: boolean;
  size: number;
  mtimeToken: string;
  realPath: string;
}

export class DocumentService {
  readonly #cfg: Config;
  readonly #log: Logger;
  readonly #container: SandboxContainer;
  readonly #semaphore: Semaphore;
  #cache = new Map<string, CacheEntry>();
  #cacheBytes = 0;
  #readiness: DocumentReadiness | null = null;
  #readinessAt = 0;
  #readinessInFlight: Promise<DocumentReadiness> | null = null;
  #provisionInFlight: Promise<{ ok: boolean; message: string; readiness: DocumentReadiness }> | null = null;
  #inflight = new Map<string, Promise<RenderResult>>();
  #scriptsReady = false;
  #webImages = new Map<string, { bytes: Buffer; contentType: string; at: number } | { failed: DocumentError; at: number }>();
  #webImageBytes = 0;
  #webImageInflight = new Map<string, Promise<{ bytes: Buffer; contentType: string }>>();

  constructor(cfg: Config, log: Logger, container: SandboxContainer) {
    this.#cfg = cfg;
    this.#log = log;
    this.#container = container;
    this.#semaphore = new Semaphore(cfg.documents.maxConcurrent);
  }

  get enabled(): boolean {
    return this.#cfg.documents.enabled;
  }

  get cacheRoot(): string {
    return path.posix.join(this.#cfg.documents.toolDir, "cache");
  }

  /** Content hash of the managed scripts, so a stale in-container copy is replaced. */
  #scriptContents(): Record<ScriptName, string> {
    const dir = path.join(import.meta.dirname, "scripts");
    const out = {} as Record<ScriptName, string>;
    for (const name of SCRIPT_FILES) {
      out[name] = fs.readFileSync(path.join(dir, name), "utf8");
    }
    return out;
  }

  #scriptsDigest(contents: Record<ScriptName, string>): string {
    const hash = createHash("sha256");
    for (const name of SCRIPT_FILES) hash.update(`${name}\u0000${contents[name]}\u0000`);
    return hash.digest("hex");
  }

  /**
   * Make sure the container holds the current managed scripts. Written into the
   * persistent tool directory (never the image), and only when the recorded
   * digest differs, so a normal request is a single cheap `cat`.
   */
  async ensureScripts(): Promise<void> {
    if (this.#scriptsReady) return;
    const contents = this.#scriptContents();
    const digest = this.#scriptsDigest(contents);
    const scriptDir = path.posix.join(this.#cfg.documents.toolDir, "scripts");
    const markerPath = path.posix.join(this.#cfg.documents.toolDir, ".scripts.sha256");
    const marker = await this.#container.execInSandbox(["cat", markerPath], { timeoutMs: 15_000 });
    if (marker.code === 0 && marker.stdout.trim() === digest) {
      this.#scriptsReady = true;
      return;
    }
    const mkdir = await this.#container.execInSandbox(["mkdir", "-p", scriptDir], { timeoutMs: 15_000 });
    if (mkdir.code !== 0) {
      throw new DocumentError(
        "tools_not_ready",
        t().documents.scriptDirFailed((mkdir.stderr || mkdir.stdout).trim().slice(0, 200)),
        503,
      );
    }
    for (const name of SCRIPT_FILES) {
      const target = path.posix.join(scriptDir, name);
      await this.#container.writeFileInSandbox(target, contents[name]);
    }
    // A plain `chmod 0755` per file: the previous single command quoted a glob,
    // so the shell never expanded it and chmod failed silently (exit code was
    // not checked), leaving the scripts non-executable.
    for (const name of SCRIPT_FILES) {
      const target = path.posix.join(scriptDir, name);
      const chmod = await this.#container.execInSandbox(["chmod", "0755", target], { timeoutMs: 15_000 });
      if (chmod.code !== 0) {
        throw new DocumentError(
          "tools_not_ready",
          t().documents.scriptChmodFailed((chmod.stderr || chmod.stdout).trim().slice(0, 200)),
          503,
        );
      }
    }
    // The render cache must exist and be writable by the sandbox user before the
    // first render; create it here so a root-provisioned tree cannot leave it
    // root-owned.
    await this.#container.execInSandbox(["mkdir", "-p", this.cacheRoot], { timeoutMs: 15_000 });
    // The published CLI is a copy of the script we just rewrote. Refresh it here
    // so a start that updates the scripts cannot leave the sandbox running an
    // old `aio-doc` (the skill and README name this exact path). Only refresh an
    // already-published CLI: before provisioning there is nothing to update, and
    // provision.sh publishes it as part of install.
    const cliPath = path.posix.join(this.#cfg.documents.toolDir, "bin", "aio-doc");
    const published = await this.#container.execInSandbox(["test", "-x", cliPath], { timeoutMs: 15_000 });
    if (published.code === 0) {
      const refresh = await this.#container.execInSandbox(
        [
          "bash",
          "-c",
          `mkdir -p -- ${quoteArg(path.posix.dirname(cliPath))} && cp -- ${quoteArg(path.posix.join(scriptDir, "aio-doc"))} ${quoteArg(cliPath)} && chmod 0755 -- ${quoteArg(cliPath)}`,
        ],
        { timeoutMs: 15_000 },
      );
      if (refresh.code !== 0) {
        this.#log.warn("could not refresh the published sandbox document CLI", {
          error: (refresh.stderr || refresh.stdout).trim().slice(0, 200),
        });
      }
    }
    await this.#container.writeFileInSandbox(markerPath, `${digest}\n`);
    this.#scriptsReady = true;
  }

  #scriptPath(name: ScriptName): string {
    return path.posix.join(this.#cfg.documents.toolDir, "scripts", name);
  }

  /** Probe tool readiness, reusing a recent result so a page load is not a fork storm. */
  async readiness(force = false): Promise<DocumentReadiness> {
    if (!this.#cfg.documents.enabled) return this.#disabledReadiness();
    const now = Date.now();
    if (!force && this.#readiness && now - this.#readinessAt < this.#cfg.documents.readinessTtlMs) {
      return this.#readiness;
    }
    if (this.#readinessInFlight) return await this.#readinessInFlight;
    this.#readinessInFlight = this.#probeReadiness();
    try {
      const result = await this.#readinessInFlight;
      this.#readiness = result;
      this.#readinessAt = Date.now();
      return result;
    } finally {
      this.#readinessInFlight = null;
    }
  }

  #disabledReadiness(): DocumentReadiness {
    return {
      enabled: false,
      ready: false,
      previewReady: false,
      authoringReady: false,
      version: null,
      tools: {},
      python: {},
      missing: [],
      error: t().documents.disabledByConfig,
      checkedAt: Date.now(),
    };
  }

  #unready(error: string): DocumentReadiness {
    return {
      enabled: true,
      ready: false,
      previewReady: false,
      authoringReady: false,
      version: null,
      tools: {},
      python: {},
      missing: [],
      error,
      checkedAt: Date.now(),
    };
  }

  async #probeReadiness(): Promise<DocumentReadiness> {
    try {
      await this.ensureScripts();
      const result = await this.#container.execInSandbox(["bash", this.#scriptPath("provision.sh"), "check", this.#cfg.documents.toolDir], {
        timeoutMs: 60_000,
      });
      if (result.code !== 0) {
        return this.#unready(t().documents.checkExit(result.code, (result.stderr || result.stdout).trim().slice(0, 300)));
      }
      const parsed = parseJsonLine(result.stdout);
      if (!parsed) return this.#unready(t().documents.checkUnparsable);
      return {
        enabled: true,
        ready: parsed.ready === true,
        previewReady: parsed.previewReady === true,
        authoringReady: parsed.authoringReady === true,
        version: typeof parsed.version === "string" ? parsed.version : null,
        tools: asBoolMap(parsed.tools),
        python: asBoolMap(parsed.python),
        missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
        error: null,
        checkedAt: Date.now(),
      };
    } catch (err) {
      return this.#unready(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Content of the root-side install step, read from the deployed control plane
   * (never from a path the sandbox user can write). Root executes exactly this.
   */
  #rootInstallScript(): string {
    return fs.readFileSync(path.join(import.meta.dirname, "scripts", "install-root.sh"), "utf8");
  }

  /**
   * Install the toolchain into the sandbox, in two steps with different
   * privileges:
   *
   *   1. root installs OS packages and grants the sandbox user write access to
   *      the managed tool directory. The script content is fixed argv supplied
   *      by the control plane, so a compromised `gem` account cannot change what
   *      root runs; it never touches /etc/codex.
   *   2. the sandbox user creates the isolated venv, installs the Python
   *      libraries, and publishes the CLI inside that directory.
   *
   * Both steps are idempotent and report failure as data. Nothing here is on a
   * request hot path: it runs in the background after a sandbox start
   * (`ensureProvisioned`) or when the owner asks for a repair. Callers that
   * arrive while an install is running share it, so apt never runs twice at once.
   */
  async provision(): Promise<{ ok: boolean; message: string; readiness: DocumentReadiness }> {
    if (!this.#cfg.documents.enabled) {
      throw new DocumentError("disabled", t().documents.disabled, 409);
    }
    this.#provisionInFlight ??= this.#provision().finally(() => {
      this.#provisionInFlight = null;
    });
    return await this.#provisionInFlight;
  }

  /**
   * Every sandbox comes with the document tools: after a start, whatever is
   * missing (a new account, a container that was created again) is installed
   * without anyone asking. A sandbox that already has them costs one check.
   */
  async ensureProvisioned(): Promise<void> {
    if (!this.#cfg.documents.enabled) return;
    if ((await this.readiness(true)).ready) return;
    this.#log.info("document tools missing; installing");
    const result = await this.provision();
    if (result.ok) this.#log.info("document tools installed", { message: result.message });
    else this.#log.warn("document tools not installed", { message: result.message, missing: result.readiness.missing });
  }

  async #provision(): Promise<{ ok: boolean; message: string; readiness: DocumentReadiness }> {
    // Ordering matters. `ensureScripts()` writes into the managed tool directory,
    // which on an already-provisioned sandbox is owned by root - so calling it
    // first would throw and the root repair step could never run. The read-only
    // preflight below uses only fixed argv (no managed script), so it always
    // works and tells us whether the root step is needed.
    const pre = await this.#sandboxProbe();
    const steps: string[] = [];

    if (pre.needsRoot) {
      const root = await this.#runRootInstall();
      if (!root.ok) {
        const readiness = await this.readiness(true);
        return { ok: false, message: root.message, readiness };
      }
      steps.push(root.aptRan ? t().documents.install.stepSystem : t().documents.install.stepToolDir);
    }

    // Only now is the directory writable by the sandbox user, so the managed
    // scripts can be (re)written.
    await this.ensureScripts();

    // Sandbox-user step: venv + Python libraries + published CLI.
    const result = await this.#container.execInSandbox(
      ["bash", this.#scriptPath("provision.sh"), "install", this.#cfg.documents.toolDir],
      { timeoutMs: Math.max(this.#cfg.documents.timeoutMs, 600_000) },
    );
    const parsed = parseJsonLine(result.stdout);
    const message = installMessage(parsed, this.#cfg.documents.toolDir) ?? t().documents.install.exitCode(result.code);
    if (result.code === 0 && parsed?.ok === true && parsed?.code === "installed") steps.push(t().documents.install.stepPython);

    // `ok` means the toolchain is actually usable, not merely that the last
    // command printed ok:true. `provision.sh check` always exits with ok:true
    // because the probe itself succeeded, which says nothing about readiness.
    const readiness = await this.readiness(true);
    const ok = readiness.ready;
    const summary = ok
      ? steps.length > 0
        ? t().documents.install.installed(steps)
        : t().documents.install.alreadyReady
      : message;
    return { ok, message: summary, readiness };
  }

  /**
   * Read-only preflight that does NOT need the managed scripts, so it works even
   * when the tool directory is root-owned and therefore not writable by the
   * sandbox user. Fixed argv only; the probe script is control-plane content.
   */
  async #sandboxProbe(): Promise<{
    needsRoot: boolean;
    toolDirWritable: boolean;
    venvPython: boolean;
    missing: string[];
  }> {
    const toolDir = this.#cfg.documents.toolDir;
    const probe = `import os, shutil, subprocess, sys
tool_dir = sys.argv[1]
missing = []
for cmd in ("soffice", "pdftoppm", "pdfinfo"):
    if not shutil.which(cmd):
        missing.append(cmd)
try:
    subprocess.run([sys.executable, "-c", "import ensurepip"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except Exception:
    missing.append("python3-venv")
fonts = ("/usr/share/fonts/truetype/noto", "/usr/share/fonts/opentype/noto")
if not any(os.path.isdir(d) for d in fonts):
    missing.append("cjk-fonts")
writable = os.path.isdir(tool_dir) and os.access(tool_dir, os.W_OK)
# A missing directory is only fixable by the root step when its parent is not
# writable by us either.
parent = os.path.dirname(tool_dir.rstrip("/")) or "/"
if not os.path.isdir(tool_dir) and not os.access(parent, os.W_OK):
    writable = False
venv_python = os.access(os.path.join(tool_dir, "venv", "bin", "python"), os.X_OK)
print(",".join(missing) if missing else "-")
print("writable" if writable else "readonly")
print("venv" if venv_python else "novenv")
`;
    let stdout = "";
    try {
      const res = await this.#container.execInSandbox(
        ["python3", "-c", probe, toolDir],
        { timeoutMs: 30_000 },
      );
      if (res.code !== 0) return { needsRoot: true, toolDirWritable: false, venvPython: false, missing: ["probe_failed"] };
      stdout = res.stdout;
    } catch (err) {
      // A probe failure must not be reported as "nothing to do": ask for the
      // root step, which is idempotent and re-verifies everything itself.
      this.#log.warn("document sandbox probe failed", { error: String(err) });
      return { needsRoot: true, toolDirWritable: false, venvPython: false, missing: ["probe_failed"] };
    }
    const lines = stdout.trim().split("\n");
    const missing = (lines[0] ?? "-") === "-" ? [] : (lines[0] ?? "").split(",").filter(Boolean);
    const toolDirWritable = (lines[1] ?? "") === "writable";
    const venvPython = (lines[2] ?? "") === "venv";
    return { needsRoot: missing.length > 0 || !toolDirWritable, toolDirWritable, venvPython, missing };
  }

  /**
   * Run the fixed root install step. `install-root.sh` content is passed to
   * `bash -s` on stdin, so root never reads a script from a user-writable path.
   */
  async #runRootInstall(): Promise<{ ok: boolean; ran: boolean; aptRan: boolean; message: string }> {
    let script: string;
    try {
      script = this.#rootInstallScript();
    } catch (err) {
      return {
        ok: false,
        ran: false,
        aptRan: false,
        message: t().documents.install.rootScriptMissing(err instanceof Error ? err.message : String(err)),
      };
    }
    const result = await this.#container.execInSandbox(
      [
        "bash",
        "-c",
        `bash -s -- ${quoteArg(this.#cfg.documents.toolDir)} ${quoteArg(this.#cfg.sandbox.containerUser)}`,
        "aio-doc-root-install",
      ],
      { timeoutMs: Math.max(this.#cfg.documents.timeoutMs, 900_000), user: "root", stdin: script },
    );
    const parsed = parseJsonLine(result.stdout);
    if (result.code !== 0 || !parsed) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 300);
      return {
        ok: false,
        ran: true,
        aptRan: true,
        message: detail ? t().documents.install.rootFailed(detail) : t().documents.install.rootExitCode(result.code),
      };
    }
    if (parsed.ok !== true) {
      return {
        ok: false,
        ran: true,
        aptRan: false,
        message: rootInstallMessage(parsed) ?? t().documents.install.rootFailedGeneric,
      };
    }
    return { ok: true, ran: true, aptRan: parsed.aptRan === true, message: t().documents.install.rootReady };
  }

  /**
   * `stat` one container path with fixed argv (never a shell), resolving the real
   * path first so a symlink cannot escape the workspace.
   *
   * The real path is what every caller must use afterwards. `%y` carries
   * nanosecond precision, so two quick same-size edits get different signatures
   * and a stale preview is not served from cache.
   */
  async stat(target: string): Promise<SandboxStat> {
    const missing: SandboxStat = { exists: false, isFile: false, size: 0, mtimeToken: "", realPath: "" };
    const resolved = await this.#container.execInSandbox(["realpath", "-e", target], { timeoutMs: 20_000 });
    if (resolved.code !== 0) return missing;
    const realPath = resolved.stdout.trim().split("\n")[0] ?? "";
    if (!realPath) return missing;
    if (!isInsideWorkspace(realPath, this.#cfg.sandbox.containerWorkspaceDir)) return missing;
    if (realPath === this.#cfg.sandbox.containerWorkspaceDir) return missing;

    const result = await this.#container.execInSandbox(["stat", "-c", "%F\t%s\t%y", realPath], { timeoutMs: 20_000 });
    if (result.code !== 0) return missing;
    const line = result.stdout.trim().split("\n")[0] ?? "";
    const [type = "", size = "", mtime = ""] = line.split("\t");
    const parsedSize = Number.parseInt(size, 10);
    return {
      exists: true,
      isFile: type.includes("regular file"),
      size: Number.isFinite(parsedSize) ? parsedSize : 0,
      mtimeToken: mtime.trim(),
      realPath,
    };
  }

  /** Render (or serve from cache) the page rasters of one workspace document. */
  async render(validatedPath: string): Promise<RenderResult> {
    if (!this.#cfg.documents.enabled) {
      throw new DocumentError("disabled", t().documents.disabled, 409);
    }
    const kind = documentKind(validatedPath);
    if (!isRenderableKind(kind)) {
      throw new DocumentError("unsupported", t().documents.previewUnsupported, 415);
    }
    const stat = await this.stat(validatedPath);
    if (!stat.exists) throw new DocumentError("not_found", t().documents.notFound, 404);
    if (!stat.isFile) throw new DocumentError("not_a_file", t().documents.notAFile, 400);
    if (stat.size === 0) throw new DocumentError("empty_file", t().documents.emptyFile, 422);
    if (stat.size > MAX_SOURCE_BYTES) throw new DocumentError("too_large", t().documents.tooLargePreview, 413);

    // The cache key is built from the *resolved* path and the real revision, so
    // a symlink that now points somewhere else, or a same-size fast edit, can
    // never be served a stale entry.
    const signature = `${stat.size}:${stat.mtimeToken}:${this.#cfg.documents.maxPages}`;
    const key = `${stat.realPath}\u0000${signature}`;
    const cached = this.#cache.get(key);
    if (cached) {
      // Refresh LRU position so a hot entry is not evicted by a cold one.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.result;
    }

    const existing = this.#inflight.get(key);
    if (existing) return await existing;

    const task = this.#runRender(stat.realPath, kind, signature, key).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, task);
    return await task;
  }

  async #runRender(realPath: string, kind: DocumentKind, signature: string, key: string): Promise<RenderResult> {
    const release = await this.#semaphore.acquire();
    // Every exit path - success, failure, timeout - clears this run's own cache
    // directory. Only this directory is ever removed: never a sibling run's, and
    // never anything the user created.
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const cacheDir = path.posix.join(this.cacheRoot, digest);
    let cacheDirCleared = false;
    const clearCacheDir = async (): Promise<void> => {
      if (cacheDirCleared) return;
      cacheDirCleared = true;
      await this.#container
        .execInSandbox(["rm", "-rf", cacheDir], { timeoutMs: 20_000 })
        .catch(() => undefined);
    };
    try {
      // Re-check the cache: a queued request may have been satisfied while waiting.
      const cached = this.#cache.get(key);
      if (cached) return cached.result;

      const readiness = await this.readiness();
      if (!readiness.previewReady) {
        throw new DocumentError(
          "tools_not_ready",
          readiness.error ?? t().documents.toolsNotReadyPreview,
          503,
        );
      }
      await this.ensureScripts();

      // The container-side script bounds itself with its own `timeout`, so the
      // configured limit is enforced inside the sandbox as well; the exec
      // timeout below is only the outer guard, and it kills our own child only.
      const timeoutSeconds = Math.max(5, Math.floor(this.#cfg.documents.timeoutMs / 1000));
      const result = await this.#container.execInSandbox(
        [
          "bash",
          this.#scriptPath("render.sh"),
          realPath,
          cacheDir,
          String(this.#cfg.documents.maxPages),
          String(timeoutSeconds),
        ],
        { timeoutMs: this.#cfg.documents.timeoutMs + 30_000 },
      );
      const parsed = parseJsonLine(result.stdout);
      if (!parsed) {
        if (result.code !== 0 && /timed out|SIGTERM/i.test(result.stderr)) {
          throw new DocumentError("timeout", t().documents.previewTimeout, 504);
        }
        throw new DocumentError("render_failed", t().documents.previewUnparsable, 502);
      }
      if (parsed.ok !== true) {
        throw mapRenderFailure(parsed, "preview");
      }
      // Page paths are only accepted when they are a direct child of THIS run's
      // cache directory: a script that returned some other path (however it got
      // there) cannot make the control plane fetch an arbitrary container file.
      const pagePaths = this.#confinePagePaths(parsed.pages, cacheDir);
      if (pagePaths.length === 0) throw new DocumentError("render_failed", t().documents.noPreviewPages, 502);

      const pages: RenderPage[] = [];
      try {
        for (const pagePath of pagePaths) {
          const bytes = await this.#fetchSandboxFile(pagePath);
          pages.push({ index: pages.length + 1, bytes });
        }
      } catch (err) {
        throw err instanceof DocumentError
          ? err
          : new DocumentError("render_failed", t().documents.previewImageReadFailed, 502);
      }

      const totalPages = typeof parsed.totalPages === "number" ? parsed.totalPages : pages.length;
      const renderResult: RenderResult = {
        kind,
        pageCount: pages.length,
        totalPages,
        truncated: parsed.truncated === true || totalPages > pages.length,
        size: typeof parsed.size === "number" ? parsed.size : 0,
        pages,
        signature,
      };
      this.#store(key, renderResult);
      return renderResult;
    } finally {
      await clearCacheDir();
      release();
    }
  }

  /**
   * Keep only page paths that are a direct child of this run's cache directory,
   * are named like a page raster, and do not exceed the page-count cap. The
   * control plane fetches these paths, so this is the boundary that stops a
   * crafted response from turning the preview into an arbitrary file read.
   */
  #confinePagePaths(raw: unknown, cacheDir: string): string[] {
    if (!Array.isArray(raw)) return [];
    const prefix = `${cacheDir}/`;
    const maxPages = Math.min(this.#cfg.documents.maxPages, MAX_RENDER_PAGES);
    const out: string[] = [];
    for (const entry of raw) {
      if (out.length >= maxPages) break;
      const value = String((entry as { path?: unknown })?.path ?? "");
      if (!value || !value.startsWith(prefix)) continue;
      const rest = value.slice(prefix.length);
      // Exactly one path segment, no traversal, page-NNN.png shape.
      if (rest.includes("/") || rest.includes("..")) continue;
      if (!/^page-\d+\.png$/.test(rest)) continue;
      out.push(value);
    }
    return out;
  }

  async #fetchSandboxFile(target: string): Promise<Buffer> {
    const res = await this.#container.fetch(`/v1/file/download?path=${encodeURIComponent(target)}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new DocumentError("page_unavailable", t().documents.previewImageUnavailable, 502);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) throw new DocumentError("page_unavailable", t().documents.previewImageEmpty, 502);
    return buffer;
  }

  /** Stream audio or video from the sandbox, preserving range requests for seeking/Safari. */
  async media(validatedPath: string, range: string | undefined, head: boolean, signal: AbortSignal): Promise<Response> {
    if (!this.enabled) throw new DocumentError("disabled", t().documents.disabled, 409);
    const kind = documentKind(validatedPath);
    if (kind !== "video" && kind !== "audio") throw new DocumentError("unsupported", t().documents.mediaOnly, 415);
    const stat = await this.stat(validatedPath);
    if (!stat.exists) throw new DocumentError("not_found", t().documents.notFound, 404);
    if (!stat.isFile) throw new DocumentError("not_a_file", t().documents.notAFile, 400);
    if (!stat.size) throw new DocumentError("empty_file", t().documents.emptyFile, 422);
    // Only one byte range is needed by media elements. Avoid multipart responses
    // and validate numbers before handing them to the sandbox HTTP server.
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    }
    const url = `/v1/file/download?path=${encodeURIComponent(stat.realPath)}`;
    const probe = await this.#container.fetch(url, { headers: { Range: "bytes=0-31" }, signal });
    // Never buffer a full file when an upstream stops honoring Range.
    if (probe.status !== 206 || Number(probe.headers.get("content-length")) > 32) {
      await probe.body?.cancel();
      throw new DocumentError("sandbox_unreachable", t().documents.mediaRangeFailed(kind), 502);
    }
    const reader = probe.body?.getReader();
    const prefix = Buffer.alloc(32);
    let count = 0;
    try {
      while (reader && count < prefix.length) {
        const { value, done } = await reader.read();
        if (done) break;
        const length = Math.min(value.length, prefix.length - count);
        prefix.set(value.subarray(0, length), count); count += length;
      }
    } finally { await reader?.cancel(); }
    if (!mediaSignatureMatches(validatedPath, prefix.subarray(0, count))) {
      throw new DocumentError("unsupported", t().documents.mediaMismatch(kind), 415);
    }
    // AIO's download route does not implement HEAD. Fetch only its headers,
    // then cancel the body for HEAD rather than exposing that upstream 405.
    const upstream = await this.#container.fetch(url, { headers: range ? { Range: range } : {}, signal });
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      throw new DocumentError("sandbox_unreachable", t().documents.mediaReadFailed(kind), 502);
    }
    if (upstream.status === 416) {
      await upstream.body?.cancel();
      return new Response(null, {status:416, headers:{"content-range":`bytes */${stat.size}`}});
    }
    if (head) {
      await upstream.body?.cancel();
      return new Response(null, {status:upstream.status, headers:upstream.headers});
    }
    return upstream;
  }

  #store(key: string, result: RenderResult): void {
    const bytes = result.pages.reduce((total, page) => total + page.bytes.byteLength, 0);
    const budget = this.#cfg.documents.cacheMaxBytes;
    if (budget <= 0 || bytes > budget) {
      // Too large to cache under the configured budget: serve it, do not store it.
      return;
    }
    this.#cache.set(key, { result, bytes });
    this.#cacheBytes += bytes;
    // Oldest-first eviction; Map preserves insertion order and a hit re-inserts.
    while (this.#cacheBytes > budget) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      const entry = this.#cache.get(oldest.value);
      this.#cache.delete(oldest.value);
      this.#cacheBytes -= entry?.bytes ?? 0;
    }
  }

  /** Serve one cached page, or re-render when the entry was evicted. */
  async page(validatedPath: string, index: number): Promise<{ bytes: Buffer; kind: DocumentKind }> {
    if (!Number.isInteger(index) || index < 1) throw new DocumentError("bad_request", t().documents.badPage);
    const result = await this.render(validatedPath);
    const page = result.pages.find((p) => p.index === index);
    if (!page) {
      throw new DocumentError("page_unavailable", t().documents.pageCount(result.pageCount), 404);
    }
    return { bytes: page.bytes, kind: result.kind };
  }

  /**
   * Convert one workspace document to a new file with LibreOffice, inside the
   * sandbox. The output is a NEW file next to the source; the original is never
   * overwritten. Both the input and the target format are validated here, and the
   * command shape is fixed — no caller-supplied argv reaches the container.
   */
  async convert(validatedPath: string, targetFormat: string): Promise<{ path: string; bytes: number }> {
    if (!this.#cfg.documents.enabled) throw new DocumentError("disabled", t().documents.disabled, 409);
    const format = targetFormat.trim().toLowerCase();
    if (!CONVERT_TARGETS.has(format)) {
      throw new DocumentError("bad_request", t().documents.badTarget(targetFormat), 400);
    }
    const kind = documentKind(validatedPath);
    if (!isRenderableKind(kind) && kind !== "text") {
      throw new DocumentError("unsupported", t().documents.convertUnsupported, 415);
    }
    const stat = await this.stat(validatedPath);
    if (!stat.exists) throw new DocumentError("not_found", t().documents.notFound, 404);
    if (!stat.isFile) throw new DocumentError("not_a_file", t().documents.notAFile, 400);
    if (stat.size === 0) throw new DocumentError("empty_file", t().documents.emptyFile, 422);
    if (stat.size > MAX_SOURCE_BYTES) throw new DocumentError("too_large", t().documents.tooLargeConvert, 413);

    const readiness = await this.readiness();
    if (!readiness.previewReady) {
      throw new DocumentError("tools_not_ready", readiness.error ?? t().documents.toolsNotReady, 503);
    }
    await this.ensureScripts();

    // The real path is used from here on, so a symlink cannot redirect the
    // conversion to a file outside the workspace after the lexical check passed.
    const realPath = stat.realPath;
    const { dir, base } = splitPath(realPath);
    const outputName = withExtension(base, format);
    const outputPath = path.posix.join(dir, outputName);
    if (outputPath === realPath) {
      throw new DocumentError("bad_request", t().documents.wouldOverwrite, 400);
    }

    const release = await this.#semaphore.acquire();
    try {
      const timeoutSeconds = Math.max(5, Math.floor(this.#cfg.documents.timeoutMs / 1000));
      const result = await this.#container.execInSandbox(
        [
          "bash",
          this.#scriptPath("render.sh"),
          "--convert",
          realPath,
          format,
          dir,
          String(timeoutSeconds),
        ],
        { timeoutMs: this.#cfg.documents.timeoutMs + 30_000 },
      );
      const parsed = parseJsonLine(result.stdout);
      if (!parsed) {
        if (result.code !== 0 && /timed out|SIGTERM/i.test(result.stderr)) {
          throw new DocumentError("timeout", t().documents.convertTimeout, 504);
        }
        throw new DocumentError("convert_failed", t().documents.convertUnparsable, 502);
      }
      if (parsed.ok !== true) throw mapRenderFailure(parsed, "convert");
      // Only a path the container reports inside the same directory is trusted;
      // anything else falls back to the path we computed ourselves.
      const reported = typeof parsed.path === "string" ? parsed.path : "";
      const produced = reported.startsWith(`${dir}/`) && !reported.slice(dir.length + 1).includes("/") ? reported : outputPath;
      this.invalidate(validatedPath);
      this.invalidate(produced);
      return { path: produced, bytes: typeof parsed.bytes === "number" ? parsed.bytes : 0 };
    } finally {
      release();
    }
  }

  /** Read a small text file for inline display; larger files are download-only. */
  async text(validatedPath: string): Promise<{ text: string; size: number; truncated: boolean }> {
    const stat = await this.stat(validatedPath);
    if (!stat.exists) throw new DocumentError("not_found", t().documents.notFound, 404);
    if (!stat.isFile) throw new DocumentError("not_a_file", t().documents.notAFile, 400);
    // Read the *resolved* path, so a symlink that leaves the workspace is
    // rejected here rather than being followed by the sandbox file API.
    const realPath = stat.realPath;
    if (stat.size > this.#cfg.documents.textMaxBytes) {
      throw new DocumentError(
        "too_large",
        t().documents.textTooLarge(formatBytes(stat.size), formatBytes(this.#cfg.documents.textMaxBytes)),
        413,
      );
    }
    const res = await this.#container.fetch(
      "/v1/file/read",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: realPath }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const json = (await res.json()) as { success?: boolean; data?: { content?: string; error_type?: string; message?: string } };
    if (!json.success || json.data?.error_type) {
      throw new DocumentError("not_found", json.data?.message ?? t().documents.readFailed, 502);
    }
    const raw = json.data?.content ?? "";
    // A binary file misnamed as text would otherwise be rendered as garbage.
    if (raw.includes("\u0000")) {
      throw new DocumentError("unsupported", t().documents.binaryText, 415);
    }
    const truncated = Buffer.byteLength(raw) > this.#cfg.documents.textMaxBytes;
    return {
      text: truncated ? raw.slice(0, this.#cfg.documents.textMaxBytes) : raw,
      size: stat.size,
      truncated,
    };
  }

  /**
   * One workspace image, sniffed and served inline.
   *
   * The generic download endpoint answers `application/octet-stream` with an
   * attachment disposition, which browsers refuse to render in an `<img>`. This
   * is the narrow alternative: the path is validated (lexically and by realpath),
   * the kind must actually be an image, the bytes must carry a real image magic
   * number, and only then is a typed inline response returned. Nothing here can
   * serve a non-image or a host file.
   */
  async image(validatedPath: string): Promise<{ bytes: Buffer; contentType: string; etag?: string }>;
  async image(validatedPath: string, known: string | undefined): Promise<{ bytes: Buffer; contentType: string; etag?: string } | { notModified: true; etag: string }>;
  async image(validatedPath: string, known?: string): Promise<{ bytes: Buffer; contentType: string; etag?: string } | { notModified: true; etag: string }> {
    const kind = documentKind(validatedPath);
    if (kind !== "image") {
      throw new DocumentError("unsupported", t().documents.notImage, 415);
    }
    const stat = await this.stat(validatedPath);
    if (!stat.exists) throw new DocumentError("not_found", t().documents.notFound, 404);
    if (!stat.isFile) throw new DocumentError("not_a_file", t().documents.notAFile, 400);
    if (stat.size === 0) throw new DocumentError("empty_file", t().documents.emptyFile, 422);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new DocumentError("too_large", t().documents.imageTooLarge(formatBytes(MAX_IMAGE_BYTES)), 413);
    }
    // The version a console keeps a copy under: the same file, size and mtime answer
    // "unchanged" without the bytes ever leaving the sandbox.
    const etag = `"${createHash("sha256").update(`${stat.realPath}\0${stat.size}\0${stat.mtimeToken}`).digest("hex").slice(0, 32)}"`;
    if (known && known === etag) return { notModified: true, etag };
    const bytes = await this.#fetchSandboxFile(stat.realPath);
    // An .svg must really be an SVG; a raster extension must hold raster bytes.
    const contentType = extensionOf(validatedPath) === "svg" ? (looksLikeSvg(bytes.toString("utf8")) ? "image/svg+xml" : null) : sniffImage(bytes);
    if (!contentType) {
      throw new DocumentError("unsupported", t().documents.notRecognizedImage, 415);
    }
    return { bytes, contentType, etag };
  }

  /**
   * A web picture a message shows. The account's own sandbox downloads it (it can
   * reach the web anyway, so the control plane gains no fetch-anything ability),
   * and only raster image bytes come back: never SVG, HTML or a redirect target's
   * error page. Results are cached; a failure is remembered briefly.
   */
  async webImage(raw: string): Promise<{ bytes: Buffer; contentType: string }> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new DocumentError("bad_request", t().documents.badImageUrl, 400);
    }
    if (url.protocol !== "https:" || url.username || url.password || raw.length > 2048) throw new DocumentError("bad_request", t().documents.httpsOnly, 400);
    const key = url.href;
    const cached = this.#webImages.get(key);
    if (cached && Date.now() - cached.at < ("failed" in cached ? WEB_IMAGE_FAILED_TTL_MS : WEB_IMAGE_TTL_MS)) {
      if ("failed" in cached) throw cached.failed;
      return { bytes: cached.bytes, contentType: cached.contentType };
    }
    let pending = this.#webImageInflight.get(key);
    if (!pending) {
      pending = this.#fetchWebImage(key).finally(() => this.#webImageInflight.delete(key));
      this.#webImageInflight.set(key, pending);
    }
    return pending;
  }

  async #fetchWebImage(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    const remember = (entry: { bytes: Buffer; contentType: string } | { failed: DocumentError }) => {
      const old = this.#webImages.get(key);
      if (old && "bytes" in old) this.#webImageBytes -= old.bytes.length;
      this.#webImages.delete(key);
      this.#webImages.set(key, { ...entry, at: Date.now() });
      if ("bytes" in entry) this.#webImageBytes += entry.bytes.length;
      // Oldest first: a Map iterates in insertion order.
      for (const [k, v] of this.#webImages) {
        if (this.#webImageBytes <= WEB_IMAGE_CACHE_BYTES && this.#webImages.size <= 500) break;
        this.#webImages.delete(k);
        if ("bytes" in v) this.#webImageBytes -= v.bytes.length;
      }
    };
    const result = await this.#container.execInSandbox(["python3", "-c", WEB_IMAGE_SCRIPT, key], { timeoutMs: 25_000 });
    let failure: DocumentError | null = null;
    let bytes = Buffer.alloc(0);
    if (result.code === 3) failure = new DocumentError("too_large", t().documents.webImageTooLarge(formatBytes(MAX_WEB_IMAGE_BYTES)), 413);
    else if (result.code !== 0) failure = new DocumentError("fetch_failed", t().documents.webImageUnavailable, 502);
    else bytes = Buffer.from(result.stdout.trim(), "base64");
    const contentType = failure ? null : sniffImage(bytes);
    if (!failure && !contentType) failure = new DocumentError("unsupported", t().documents.notAnImage, 415);
    if (failure) {
      remember({ failed: failure });
      throw failure;
    }
    const image = { bytes, contentType: contentType! };
    remember(image);
    return image;
  }

  /** Drop one file's cached renders (used after a document-tool write). */
  invalidate(target: string): void {
    for (const key of [...this.#cache.keys()]) {
      if (key.startsWith(`${target}\u0000`)) {
        const entry = this.#cache.get(key);
        this.#cache.delete(key);
        this.#cacheBytes -= entry?.bytes ?? 0;
      }
    }
  }
}

function parseJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (const line of [...lines].reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function asBoolMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) out[key] = raw === true;
  return out;
}

type Words = Messages["documents"];

/**
 * What render.sh reports, by its code: the error it becomes and the words a
 * person reads. A code missing here keeps the script's own (English) message.
 */
const RENDER_FAILURES: Record<string, [DocumentErrorCode, number, (m: Words, mode: "preview" | "convert") => string]> = {
  outside_workspace: ["outside_workspace", 400, (m, mode) => (mode === "preview" ? m.render.outsidePreview : m.render.outsideConvert)],
  outdir_outside_workspace: ["outside_workspace", 400, (m) => m.render.outdirOutside],
  outdir_not_found: ["not_found", 404, (m) => m.render.outdirNotFound],
  not_a_file: ["not_a_file", 400, (m) => m.notAFile],
  too_large: ["too_large", 413, (m) => m.render.tooLarge],
  empty_file: ["empty_file", 422, (m) => m.emptyFile],
  unsupported: ["unsupported", 415, (m) => m.previewUnsupported],
  missing_lo_run: ["missing_tool", 503, (m) => m.render.missingLoRun],
  missing_soffice: ["missing_tool", 503, (m) => m.render.missingSoffice],
  missing_pdftoppm: ["missing_tool", 503, (m) => m.render.missingPdftoppm],
  bad_format: ["bad_request", 400, (m) => m.render.badFormat],
  missing_path: ["bad_request", 400, (m) => m.render.missingPath],
  missing_outdir: ["bad_request", 400, (m) => m.render.missingOutdir],
  missing_cache_dir: ["bad_request", 400, (m) => m.render.missingCacheDir],
  bad_max_pages: ["bad_request", 400, (m) => m.render.badMaxPages],
  bad_cache_dir: ["bad_request", 400, (m) => m.render.badCacheDir],
  would_overwrite: ["bad_request", 400, (m) => m.wouldOverwrite],
  convert_failed: ["render_failed", 422, (m, mode) => (mode === "preview" ? m.render.previewConvertFailed : m.render.convertFailed)],
  no_output: ["render_failed", 422, (m) => m.render.noOutput],
  write_failed: ["render_failed", 422, (m) => m.render.writeFailed],
  no_pdf: ["render_failed", 422, (m) => m.render.noPdf],
  cache_write_failed: ["render_failed", 422, (m) => m.render.cacheWriteFailed],
  cache_error: ["render_failed", 422, (m) => m.render.cacheError],
  temp_error: ["render_failed", 422, (m) => m.render.tempError],
  render_failed: ["render_failed", 422, (m) => m.render.renderFailed],
  no_pages: ["render_failed", 422, (m) => m.render.noPages],
};

function mapRenderFailure(parsed: Record<string, unknown>, mode: "preview" | "convert"): DocumentError {
  const code = typeof parsed.code === "string" ? parsed.code : "render_failed";
  const fallback = typeof parsed.message === "string" ? parsed.message : t().documents.previewFailed;
  const known = Object.hasOwn(RENDER_FAILURES, code) ? RENDER_FAILURES[code] : undefined;
  if (!known) return new DocumentError("render_failed", fallback, 422);
  const [errorCode, status, words] = known;
  return new DocumentError(errorCode, words(t().documents, mode), status);
}

/** What provision.sh reports, by its code; the script's own message for an unknown one. */
const INSTALL_MESSAGES: Record<string, (m: Words["install"], toolDir: string) => string> = {
  already: (m) => m.alreadyReady,
  cli_missing: (m) => m.cliMissing,
  cli_dir: (m) => m.cliDir,
  cli_copy_failed: (m) => m.cliCopyFailed,
  cli_chmod_failed: (m) => m.cliChmodFailed,
  bad_mode: (m) => m.badMode,
  tool_dir: (m, toolDir) => m.toolDir(toolDir),
  tool_dir_readonly: (m, toolDir) => m.toolDirReadonly(toolDir),
  need_root: (m) => m.needRoot,
  need_root_venv: (m) => m.needRootVenv,
  venv_failed: (m) => m.venvFailed,
  pip_failed: (m) => m.pipFailed,
  verify_failed: (m) => m.verifyFailed,
};

function installMessage(parsed: Record<string, unknown> | null, toolDir: string): string | null {
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  if (Object.hasOwn(INSTALL_MESSAGES, code)) return INSTALL_MESSAGES[code]!(t().documents.install, toolDir);
  return typeof parsed?.message === "string" ? parsed.message : null;
}

/** What install-root.sh reports, by its code; the script's own message for an unknown one. */
const ROOT_INSTALL_MESSAGES: Record<string, (m: Words["install"], path: string) => string> = {
  missing_tool_dir: (m) => m.missingToolDir,
  bad_tool_dir: (m) => m.badToolDir,
  tool_dir_outside: (m) => m.toolDirOutside,
  no_apt: (m) => m.noApt,
  apt_update_failed: (m) => m.aptUpdateFailed,
  apt_install_failed: (m) => m.aptInstallFailed,
  no_user: (m) => m.noUser,
  tool_dir_symlink: (m, path) => m.toolDirSymlink(path),
  tool_dir: (m) => m.rootToolDir,
  chown_failed: (m) => m.chownFailed,
  chmod_failed: (m) => m.chmodFailed,
};

function rootInstallMessage(parsed: Record<string, unknown>): string | null {
  const code = typeof parsed.code === "string" ? parsed.code : "";
  if (Object.hasOwn(ROOT_INSTALL_MESSAGES, code)) {
    return ROOT_INSTALL_MESSAGES[code]!(t().documents.install, typeof parsed.path === "string" ? parsed.path : "");
  }
  return typeof parsed.message === "string" ? parsed.message : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return t().documents.unknownSize;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { splitPath };
