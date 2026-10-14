import type { ExecResult } from "../../common/protocol.js";

/**
 * The image starts its editor and notebook servers with every container, and
 * together they hold ~300 MB in each sandbox whether anyone opens them or not.
 * Their boot start is switched off (`autostart=false` in the image's supervisord
 * files, read when the container next starts); the first request for their
 * pages starts them and they stop again once nobody has used them for
 * `idleMs`. The image's API server starts the Node.js REPL by itself when code
 * runs, so for it only the boot start is switched off.
 */
export const ON_DEMAND = [
  { program: "code-server", prefix: "/code-server", probe: "/code-server/" },
  { program: "jupyter", prefix: "/jupyter", probe: "/jupyter/lab" },
] as const;

export type OnDemandProgram = (typeof ON_DEMAND)[number];

const SUPERVISOR_DIR = "/opt/gem/supervisord";
const BOOT_OFF = [
  "supervisord.code_server.conf",
  "supervisord.jupyter.conf",
  "supervisord.nodejs_repl_20.conf",
  "supervisord.nodejs_repl_22.conf",
  "supervisord.nodejs_repl_24.conf",
].map((name) => `${SUPERVISOR_DIR}/${name}`);

/** How long a started program may take to answer its page. */
const START_TIMEOUT_MS = 60_000;
/** How often the stop pass may look inside the container. */
const REAP_EVERY_MS = 60_000;

export interface ProgramContainer {
  execInSandbox(argv: string[], opts?: { timeoutMs?: number; user?: string }): Promise<ExecResult>;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface OnDemandOptions {
  container: ProgramContainer;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
  idleMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class OnDemandPrograms {
  readonly #container: ProgramContainer;
  readonly #log: OnDemandOptions["log"];
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Programs known to answer since the container started. */
  #up = new Set<string>();
  #lastUse = new Map<string, number>();
  #starting = new Map<string, Promise<void>>();
  /** The image starts them at boot until the files are changed: look once per container start. */
  #checked = false;
  #reapedAt = 0;
  #reaping = false;

  constructor(opts: OnDemandOptions) {
    this.#container = opts.container;
    this.#log = opts.log;
    this.#idleMs = opts.idleMs;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The program serving this workspace path, or null. */
  match(path: string): OnDemandProgram | null {
    const pathname = path.split("?")[0] ?? "";
    return ON_DEMAND.find((p) => pathname === p.prefix || pathname.startsWith(`${p.prefix}/`)) ?? null;
  }

  /** Someone is using the program's pages (a request, socket traffic). */
  touch(entry: OnDemandProgram): void {
    this.#lastUse.set(entry.program, this.#now());
  }

  /** A request for the program's pages: start it when it is not up, and wait until it answers. */
  async use(entry: OnDemandProgram): Promise<void> {
    this.touch(entry);
    if (this.#up.has(entry.program)) return;
    let starting = this.#starting.get(entry.program);
    if (!starting) {
      starting = this.#start(entry).finally(() => this.#starting.delete(entry.program));
      this.#starting.set(entry.program, starting);
    }
    await starting;
  }

  /** Switch the boot start off in the container's files; idempotent, takes effect at its next start. */
  async disableBootStart(): Promise<void> {
    const res = await this.#container.execInSandbox(
      ["sed", "-i", "-E", "s/^autostart=%\\(ENV_AUTOSTART_[A-Z0-9_]+\\)s$/autostart=false/", ...BOOT_OFF],
      { timeoutMs: 15_000, user: "root" },
    );
    if (res.code !== 0) throw new Error(`supervisord files not changed (exit ${res.code})`);
  }

  /** The container stopped or started again: nothing proven about it holds. */
  reset(): void {
    this.#up.clear();
    this.#checked = false;
  }

  /** Stop programs nobody used for `idleMs`; cheap to call often (at most one look a minute). */
  async reap(): Promise<void> {
    const now = this.#now();
    if (this.#reaping || now - this.#reapedAt < REAP_EVERY_MS) return;
    // After the first look only programs this control plane started can be running.
    if (this.#checked && this.#up.size === 0) return;
    this.#reaping = true;
    this.#reapedAt = now;
    try {
      const idle = ON_DEMAND.filter((p) => !this.#starting.has(p.program) && now - (this.#lastUse.get(p.program) ?? 0) >= this.#idleMs);
      if (idle.length === 0) return;
      const status = await this.#container.execInSandbox(["supervisorctl", "status", ...idle.map((p) => p.program)], { timeoutMs: 15_000, user: "root" });
      this.#checked = true;
      for (const entry of idle) {
        const line = status.stdout.split("\n").find((l) => l.startsWith(`${entry.program} `)) ?? "";
        if (!/\b(RUNNING|STARTING|BACKOFF)\b/.test(line)) {
          this.#up.delete(entry.program);
          continue;
        }
        // A request that arrived since the look keeps it.
        if (this.#now() - (this.#lastUse.get(entry.program) ?? 0) < this.#idleMs || this.#starting.has(entry.program)) continue;
        this.#up.delete(entry.program);
        const stop = await this.#container.execInSandbox(["supervisorctl", "stop", entry.program], { timeoutMs: 30_000, user: "root" });
        if (stop.code === 0) this.#log.info("sandbox program stopped while unused", { program: entry.program });
        else this.#log.warn("sandbox program not stopped", { program: entry.program, exit: stop.code });
      }
    } finally {
      this.#reaping = false;
    }
  }

  async #start(entry: OnDemandProgram): Promise<void> {
    if (await this.#answers(entry)) {
      this.#up.add(entry.program);
      return;
    }
    const res = await this.#container.execInSandbox(["supervisorctl", "start", entry.program], { timeoutMs: 30_000, user: "root" });
    // "already started" exits non-zero but is what we want.
    if (res.code !== 0 && !/already started/i.test(`${res.stdout}${res.stderr}`)) {
      this.#log.warn("sandbox program did not start", { program: entry.program, exit: res.code });
    } else {
      this.#log.info("sandbox program started on use", { program: entry.program });
    }
    const deadline = this.#now() + START_TIMEOUT_MS;
    while (this.#now() < deadline) {
      if (await this.#answers(entry)) {
        this.#up.add(entry.program);
        return;
      }
      await this.#sleep(1000);
    }
    this.#log.warn("sandbox program not answering after start", { program: entry.program });
  }

  async #answers(entry: OnDemandProgram): Promise<boolean> {
    try {
      const res = await this.#container.fetch(entry.probe, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      return res.status < 500;
    } catch {
      return false;
    }
  }
}
