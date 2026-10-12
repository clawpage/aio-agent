import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { AppContext } from "../context.js";
import type { Logger } from "../../common/logger.js";
import { requireWorkspaceFilePath } from "../documents/paths.js";
import { OP, TAG, ippRequest, encodeRequest, type IppResponse } from "./ipp.js";

/**
 * The home printer (an IPP Everywhere printer on the LAN), offered to the
 * accounts the owner lists as one MCP server on the member gateway
 * (`/printer/<token>/mcp`). The account's own sandbox turns a workspace PDF or
 * picture into PWG raster (scripts/pwg-raster.py); the control plane sends it
 * to the printer. Sandboxes never reach the printer themselves.
 */

const TIMEOUT_MS = 300_000;
const MAX_COPIES = 20;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const PDF = /\.pdf$/i;
const PICTURE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const SIDES = ["one-sided", "two-sided-long-edge", "two-sided-short-edge"] as const;
type Sides = (typeof SIDES)[number];

/** Paper sizes at 300 dpi, by PWG media name; the printer's loaded paper picks one. */
const MEDIA: Record<string, { width: number; height: number; label: string }> = {
  "na_letter_8.5x11in": { width: 2550, height: 3300, label: "Letter" },
  "iso_a4_210x297mm": { width: 2480, height: 3508, label: "A4" },
  "na_legal_8.5x14in": { width: 2550, height: 4200, label: "Legal" },
};
const mediaOf = (name: string) => MEDIA[name];

const STATES: Record<number, string> = { 3: "idle", 4: "printing", 5: "stopped" };
const JOB_STATES: Record<number, string> = { 3: "queued", 4: "held", 5: "printing", 6: "paused", 7: "canceled", 8: "aborted", 9: "finished printing" };
const REASONS: Record<string, string> = {
  "media-empty": "out of paper",
  "media-needed": "paper needs loading",
  "media-jam": "paper jam",
  "marker-supply-low": "ink low",
  "marker-supply-empty": "ink empty",
  "door-open": "cover open",
  "cover-open": "cover open",
  "input-tray-missing": "paper tray not inserted properly",
  "output-area-full": "output tray full",
  "toner-low": "toner low",
  offline: "offline",
  paused: "paused",
};

const TOOLS = [
  {
    name: "printer_status",
    description: "Check the current state of the home printer: whether it is idle, problems such as being out of paper or a paper jam, the ink level of each color, and the loaded paper.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "print_file",
    description:
      "Print a PDF or image (png/jpg/webp/gif/bmp/tiff) from the workspace on the home printer. Convert other formats to PDF first, then print. " +
      "PDFs print at their original size (shrunk if larger than the paper); images are scaled to fill the page, centered. At most 50 pages at a time.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file to print: an absolute path in the workspace, e.g. /home/gem/workspace/tasks/<task id>/report.pdf" },
        pages: { type: "string", description: "Print only these pages of the PDF, e.g. \"1-3,5\"; omit to print all pages" },
        copies: { type: "integer", minimum: 1, maximum: MAX_COPIES, description: "Number of copies, default 1" },
        sides: { type: "string", enum: SIDES, description: "One- or two-sided: one-sided (default); two-sided-long-edge flips on the long edge (ordinary portrait documents); two-sided-short-edge flips on the short edge" },
        color: { type: "boolean", description: "false prints in black and white (saves color ink); color by default" },
      },
      required: ["path"],
    },
  },
];

/** Thread-level MCP wiring for a Codex executor. */
export function printerThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.printer ? { aio_printer: { url: cfg.printer.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 30 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function printerMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.printer ? { aio_printer: { type: "http", url: cfg.printer.url } } : {};
}

export const PRINTER_POLICY =
  "The home printer is connected (aio_printer): when the user wants a file, photo, web page, or a document you made printed, print it directly with print_file; do not make the user print it themselves. " +
  "It only accepts PDFs and images in the workspace: convert Word, Excel, PPT, text, and so on to PDF in the sandbox first (e.g. soffice --headless --convert-to pdf), save web pages as PDF first, then print the converted file. " +
  "Print only when the user asks to print; follow what the user said for copies, pages, one- or two-sided, and color or black and white, and if they did not say, use 1 copy, one-sided, color. Confirm with the user first for more than 20 pages or multiple copies. " +
  "You can check the state with printer_status before and after printing; tell the user truthfully when it is out of paper, has a paper jam, or is low on ink. When the tool says the outcome is uncertain, do not print again automatically; first ask the user to look at the printer.";

/** Turning one account's workspace file into printer pages. */
export interface PrintFiles {
  rasterize(file: string, opts: { color: boolean; sides: Sides; media: string; width: number; height: number; pages: number[] }): Promise<{ bytes: Buffer; pages: number }>;
}

class PrintError extends Error {}

/** An account's workspace, reached through its own sandbox. */
export function sandboxPrintFiles(ctx: Pick<AppContext, "documents" | "container">): PrintFiles {
  const script = fs.readFileSync(path.join(import.meta.dirname, "scripts", "pwg-raster.py"), "utf8");
  return {
    async rasterize(file, opts) {
      // The real path, so a symlink cannot point the printer at a file outside the workspace.
      const stat = await ctx.documents.stat(file);
      if (!stat.exists) throw new PrintError(`File does not exist: ${file}`);
      if (!stat.isFile) throw new PrintError(`Not a regular file: ${file}`);
      if (stat.size === 0) throw new PrintError("The file is empty");
      if (stat.size > MAX_SOURCE_BYTES) throw new PrintError("The file is larger than 100MB");
      const out = `/tmp/aio-print-${randomUUID()}.pwg`;
      try {
        const run = await ctx.container.execInSandbox(
          ["python3", "-", stat.realPath, out, opts.color ? "srgb" : "sgray", opts.sides, String(opts.width), String(opts.height), opts.media, opts.pages.join(",")],
          { stdin: script, timeoutMs: 240_000 },
        );
        const last = run.stdout.trim().split("\n").pop() ?? "";
        let result: { ok?: boolean; pages?: number; message?: string } = {};
        try {
          result = JSON.parse(last);
        } catch {
          throw new Error(`Failed to convert the file for printing: ${(run.stderr || run.stdout).trim().slice(-300)}`);
        }
        if (!result.ok) throw new PrintError(result.message ?? "Failed to convert the file for printing");
        const res = await ctx.container.fetch(`/v1/file/download?path=${encodeURIComponent(out)}`, { signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`Failed to read the conversion result (${res.status})`);
        return { bytes: Buffer.from(await res.arrayBuffer()), pages: result.pages ?? 0 };
      } finally {
        await ctx.container.execInSandbox(["rm", "-f", "--", out], { timeoutMs: 20_000 }).catch(() => undefined);
      }
    },
  };
}

/** "1-3,5" as sorted page numbers; "" means every page. */
export function parsePages(raw: unknown): number[] {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, "") : raw === undefined || raw === null ? "" : String(raw);
  if (!text) return [];
  const pages = new Set<number>();
  for (const part of text.split(/[,，]/)) {
    const m = /^(\d+)(?:[-–~](\d+))?$/.exec(part);
    const from = m ? Number(m[1]) : 0;
    const to = m?.[2] ? Number(m[2]) : from;
    if (!m || from < 1 || to < from || to > 10_000) throw new PrintError(`pages is not written correctly: ${text} (e.g. "1-3,5")`);
    for (let p = from; p <= to; p += 1) pages.add(p);
    if (pages.size > 50) throw new PrintError("At most 50 pages can be printed at a time");
  }
  return [...pages].sort((a, b) => a - b);
}

export class PrinterGateway {
  #port: number;
  #log: Logger;
  #printerUri: string;
  #accounts: string[];
  #workspace: string;
  #usernameOf: (userId: string) => string | null;
  #filesFor: (userId: string) => Promise<PrintFiles>;
  /** capability token -> account */
  #tokens = new Map<string, { userId: string; username: string }>();
  /** One job at a time: the printer takes a single document per job. */
  #queue: Promise<unknown> = Promise.resolve();
  #requestId = 1;

  constructor(opts: {
    port: number;
    log: Logger;
    printerUri: string;
    accounts: string[];
    workspace: string;
    usernameOf: (userId: string) => string | null;
    filesFor: (userId: string) => Promise<PrintFiles>;
  }) {
    this.#port = opts.port;
    this.#log = opts.log.child("printer");
    this.#printerUri = opts.printerUri;
    this.#accounts = opts.accounts;
    this.#workspace = opts.workspace.replace(/\/$/, "");
    this.#usernameOf = opts.usernameOf;
    this.#filesFor = opts.filesFor;
  }

  /** Give a granted runtime its printer URL. */
  provision(cfg: Config): void {
    if (!this.#printerUri) return;
    const username = this.#usernameOf(cfg.runtimeUserId!);
    if (!username || !this.#accounts.includes(username)) return;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "printer-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, { userId: cfg.runtimeUserId!, username });
    cfg.printer = { url: `http://host.docker.internal:${this.#port}/printer/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/printer\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
    const account = match ? this.#tokens.get(match[1]!) : undefined;
    if (!account) return send(403, { error: "forbidden" });
    if (req.method === "DELETE") return send(200, {});
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 64 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad request" });
    }
    const headers: Record<string, string> = {};
    if (!Array.isArray(body) && (body as { method?: string })?.method === "initialize") headers["mcp-session-id"] = randomUUID();
    const messages = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(messages.map((m) => this.#rpc(account, m)))).filter(Boolean);
    if (!out.length) return send(202, undefined, headers);
    return send(200, Array.isArray(body) ? out : out[0], headers);
  }

  async #rpc(account: { userId: string; username: string }, message: unknown): Promise<unknown> {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: Record<string, unknown> };
    if (id === undefined || id === null) return null; // a notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "aio_printer", version: "1" },
          instructions: PRINTER_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(params?.name);
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (name === "printer_status") return reply(await this.#tool(() => this.#status()));
        if (name === "print_file") return reply(await this.#tool(() => this.#print(account, args)));
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  async #tool(run: () => Promise<string>): Promise<unknown> {
    try {
      return { content: [{ type: "text", text: await run() }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof PrintError)) this.#log.warn("printer tool failed", { error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  async #ipp(op: number, operation: Parameters<typeof encodeRequest>[3], job: Parameters<typeof encodeRequest>[4] = [], document?: Buffer, timeoutMs = 20_000): Promise<IppResponse> {
    const request = encodeRequest(op, this.#requestId++, this.#printerUri, operation, job);
    return await ippRequest(this.#printerUri, document ? Buffer.concat([request, document]) : request, timeoutMs);
  }

  async #printerAttributes(): Promise<IppResponse["attrs"]> {
    const wanted = ["printer-state", "printer-state-reasons", "printer-state-message", "marker-names", "marker-levels", "media-ready", "printer-make-and-model", "queued-job-count"];
    let res: IppResponse;
    try {
      res = await this.#ipp(OP.getPrinterAttributes, [[TAG.keyword, "requested-attributes", wanted]]);
    } catch (err) {
      throw new PrintError(`Cannot reach the printer (${err instanceof Error ? err.message : String(err)}): it may be turned off or not on the network`);
    }
    if (res.status >= 0x0100) throw new PrintError(`The printer refused the query (IPP status 0x${res.status.toString(16)})`);
    return res.attrs;
  }

  async #status(): Promise<string> {
    const a = await this.#printerAttributes();
    const reasons = problems(a);
    const names = (a["marker-names"] ?? []).map(String);
    const levels = a["marker-levels"] ?? [];
    const ink = names.map((n, i) => `${n.replace(/ ink$/i, "")} ${Number(levels[i]) >= 0 ? `${levels[i]}%` : "unknown"}`).join(", ");
    const paper = [...new Set((a["media-ready"] ?? []).map((m) => mediaOf(String(m))?.label ?? String(m)))].join(", ");
    return [
      `Printer: ${a["printer-make-and-model"]?.[0] ?? "unknown model"}`,
      `Status: ${STATES[Number(a["printer-state"]?.[0])] ?? "unknown"}${reasons.length ? ` (${reasons.join(", ")})` : ""}`,
      a["queued-job-count"] ? `Queued jobs: ${a["queued-job-count"][0]}` : "",
      ink ? `Ink: ${ink}` : "",
      paper ? `Paper: ${paper}` : "",
    ].filter(Boolean).join("\n");
  }

  async #print(account: { userId: string; username: string }, args: Record<string, unknown>): Promise<string> {
    const checked = requireWorkspaceFilePath(String(args.path ?? ""), this.#workspace);
    if (!checked.ok) throw new PrintError(`path: ${checked.message}`);
    const file = checked.path;
    if (!PDF.test(file) && !PICTURE.test(file)) throw new PrintError("Only PDFs or images can be printed; convert other formats to PDF in the sandbox first, then print");
    const pages = parsePages(args.pages);
    if (pages.length && !PDF.test(file)) throw new PrintError("pages applies only to PDFs");
    const copies = args.copies === undefined ? 1 : Number(args.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new PrintError(`copies must be an integer from 1 to ${MAX_COPIES}`);
    const sides = (args.sides ?? "one-sided") as Sides;
    if (!SIDES.includes(sides)) throw new PrintError(`sides must be ${SIDES.join(" / ")}`);
    const color = args.color !== false;

    const job = this.#queue.then(async () => {
      const a = await this.#printerAttributes();
      if (Number(a["printer-state"]?.[0]) === 5) throw new PrintError(`The printer is stopped; nothing was printed: ${problems(a).join(", ") || "reason unknown"}`);
      const loaded = String(a["media-ready"]?.[0] ?? "na_letter_8.5x11in");
      const media = mediaOf(loaded) ? loaded : "na_letter_8.5x11in";
      const { width, height } = mediaOf(media)!;
      const files = await this.#filesFor(account.userId);
      const raster = await files.rasterize(file, { color, sides, media, width, height, pages });
      const started = Date.now();
      let res: IppResponse;
      try {
        res = await this.#ipp(
          OP.printJob,
          [[TAG.name, "requesting-user-name", account.username], [TAG.name, "job-name", path.posix.basename(file).slice(0, 200)], [TAG.mime, "document-format", "image/pwg-raster"]],
          [[TAG.integer, "copies", copies], [TAG.keyword, "sides", sides], [TAG.keyword, "print-color-mode", color ? "color" : "monochrome"], [TAG.keyword, "media", media]],
          raster.bytes,
          180_000,
        );
      } catch (err) {
        // The document may or may not have reached the printer: never resend on our own.
        this.#log.warn("print job outcome unknown", { user: account.username, error: err instanceof Error ? err.message : String(err) });
        throw new PrintError(`An error occurred while sending (${err instanceof Error ? err.message : String(err)}); not sure whether the printer received it. Do not resend automatically; first ask the user to check whether the printer printed anything.`);
      }
      if (res.status >= 0x0100) throw new PrintError(`The printer refused this job (IPP status 0x${res.status.toString(16)}${res.attrs["status-message"] ? `: ${res.attrs["status-message"][0]}` : ""}); nothing was printed`);
      const jobId = res.attrs["job-id"]?.[0];
      const state = JOB_STATES[Number(res.attrs["job-state"]?.[0])] ?? "received";
      this.#log.info("print job sent", { user: account.username, jobId, pages: raster.pages, copies, sides, color, bytes: raster.bytes.length, ms: Date.now() - started });
      const warn = problems(a);
      return [
        `Sent to the printer: ${path.posix.basename(file)}, ${raster.pages} pages × ${copies} copies, ${sides === "one-sided" ? "one-sided" : "two-sided"}, ${color ? "color" : "black and white"}, ${mediaOf(media)!.label} paper.`,
        `Job ${jobId ?? "unknown"}, status: ${state}.`,
        warn.length ? `Printer notes: ${warn.join(", ")}` : "",
      ].filter(Boolean).join("\n");
    });
    this.#queue = job.catch(() => undefined);
    return await job;
  }
}

/** The printer's state reasons that matter to a person, in words. */
function problems(a: IppResponse["attrs"]): string[] {
  return [...new Set((a["printer-state-reasons"] ?? []).map(String).filter((r) => r !== "none").map((r) => {
    const base = r.replace(/-(report|warning|error)$/, "");
    return REASONS[base] ?? r;
  }))];
}
