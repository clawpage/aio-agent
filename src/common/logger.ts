import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values must never be written to logs. */
const SECRET_KEYS = /(token|secret|password|passwd|authorization|cookie|apikey|api_key|credential)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact JWT-ish and long opaque strings that may be credentials.
    if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(value)) return "<redacted-jwt>";
    return value;
  }
  if (typeof value !== "object") return value;
  if (depth > 4) return "<depth-limit>";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "<redacted>" : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  #level: number;
  #stream: fs.WriteStream | null = null;
  #alsoStdout: boolean;

  constructor(level: LogLevel = "info", logFile?: string, alsoStdout = true) {
    this.#level = LEVELS[level];
    this.#alsoStdout = alsoStdout;
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      this.#stream = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
    }
  }

  child(scope: string): Logger {
    const l = new Logger("debug", undefined, this.#alsoStdout);
    l.#level = this.#level;
    l.#stream = this.#stream;
    l.#scope = scope;
    return l;
  }

  #scope = "";

  #write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.#level) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope: this.#scope || undefined,
      msg,
    };
    if (fields) record.fields = redact(fields);
    const line = JSON.stringify(record, (_k, v) => (v === undefined ? undefined : v));
    this.#stream?.write(line + "\n");
    if (this.#alsoStdout) {
      const sink = level === "error" || level === "warn" ? process.stderr : process.stdout;
      sink.write(line + "\n");
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.#write("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.#write("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.#write("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.#write("error", msg, fields);
  }
  close(): void {
    this.#stream?.end();
  }
}
