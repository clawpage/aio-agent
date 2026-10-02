import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ExecResult } from "../common/protocol.js";

/**
 * The docker CLI, always called with an argument list (never a shell). Secret
 * values reach a command only through this process's environment, referenced by
 * name (`-e NAME`), so they never appear in argv or a process listing.
 */
export class DockerCli {
  constructor(private readonly bin = "docker") {}

  async run(args: string[], opts: { timeoutMs?: number; stdin?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    return await new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        args,
        { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...opts.env } },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("docker CLI not found on PATH"));
            return;
          }
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
      // `docker exec -i` keeps stdin open, so it is always closed: a command that
      // reads stdin must never wait forever.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.stdin ?? "");
    });
  }

  spawn(args: string[], env: Record<string, string> = {}): ChildProcess {
    return spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  }
}
