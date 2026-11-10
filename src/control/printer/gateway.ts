import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import type { Logger } from "../../common/logger.js";
import { requireWorkspaceFilePath } from "../documents/paths.js";
import { OP, TAG, ippRequest, encodeRequest, type IppCollection, type IppResponse } from "./ipp.js";

/**
 * The home printer (an IPP Everywhere printer on the LAN), offered to the
 * accounts the owner lists as one MCP server on the member gateway
 * (`/printer/<token>/mcp`). The account's own sandbox turns a workspace PDF or
 * picture into PWG raster (scripts/pwg-raster.py); the control plane sends it
 * to the printer. Sandboxes never reach the printer themselves.
 */

const TIMEOUT_MS = 300_000;
const MAX_COPIES = 20;
const HISTORY_DEFAULT = 10;
const HISTORY_MAX = 50;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const PDF = /\.pdf$/i;
const PICTURE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const SIDES = ["one-sided", "two-sided-long-edge", "two-sided-short-edge"] as const;
type Sides = (typeof SIDES)[number];

const DPI = 300;
/** High quality draws sheets up to 5x7 at 600 dpi; larger ones stay at 300 so a page still converts and sends in time. */
const FINE_DPI = 600;
const FINE_MAX_WIDTH = 12700;
const QUALITIES = { normal: 4, high: 5 } as const;
type Quality = keyof typeof QUALITIES;
/** Paper sizes people name, with their PWG media name and size in hundredths of a millimetre. */
const SIZES: Array<{ media: string; label: string; x: number; y: number }> = [
  { media: "na_letter_8.5x11in", label: "Letter", x: 21590, y: 27940 },
  { media: "iso_a4_210x297mm", label: "A4", x: 21000, y: 29700 },
  { media: "na_legal_8.5x14in", label: "Legal", x: 21590, y: 35560 },
  { media: "na_index-4x6_4x6in", label: "4x6", x: 10160, y: 15240 },
  { media: "na_5x7_5x7in", label: "5x7", x: 12700, y: 17780 },
  { media: "na_govt-letter_8x10in", label: "8x10", x: 20320, y: 25400 },
  { media: "oe_photo-l_3.5x5in", label: "3.5x5", x: 8890, y: 12700 },
  { media: "iso_a6_105x148mm", label: "A6", x: 10500, y: 14800 },
];
const LETTER = SIZES[0]!;

/** One paper the printer has loaded; `type` and `source` only when the printer says which tray holds what. */
interface Paper {
  media: string;
  label: string;
  x: number;
  y: number;
  type?: string;
  source?: string;
  /** The printer offers this paper with no margins. */
  borderless?: boolean;
}

const MARGINS = ["media-top-margin", "media-bottom-margin", "media-left-margin", "media-right-margin"] as const;

const pixels = (hundredthsMm: number, dpi: number) => Math.round((hundredthsMm / 2540) * dpi);
const isPhoto = (p: Paper) => !!p.type?.startsWith("photographic");
const isPlain = (p: Paper) => !p.type || p.type.startsWith("stationery");
const kindOf = (type: string) => (type.startsWith("stationery") ? "plain paper" : type.startsWith("photographic") ? "photo paper" : type);
const describe = (p: Paper) => `${p.label}${p.type ? ` (${[kindOf(p.type), p.source ? `${p.source} tray` : "", p.borderless ? "borderless available" : ""].filter(Boolean).join(", ")})` : ""}`;

function sized(x: number, y: number): Pick<Paper, "media" | "label" | "x" | "y"> {
  return SIZES.find((s) => s.x === x && s.y === y) ?? { media: `custom_${x / 100}x${y / 100}mm`, label: `${x / 100}x${y / 100}mm`, x, y };
}

/** The papers loaded now: one per size and tray, in the printer's order. */
function loadedPapers(res: Pick<IppResponse, "attrs" | "collections">): Paper[] {
  const papers: Paper[] = [];
  const add = (p: Paper) => {
    const same = papers.find((o) => o.x === p.x && o.y === p.y && o.source === p.source);
    if (!same) papers.push(p);
    else if (p.borderless) same.borderless = true;
  };
  for (const col of res.collections["media-col-ready"] ?? []) {
    const size = col["media-size"] as IppCollection | undefined;
    const x = Number(size?.["x-dimension"]);
    const y = Number(size?.["y-dimension"]);
    if (!(x > 0 && y > 0)) continue;
    add({
      ...sized(x, y),
      ...(typeof col["media-type"] === "string" ? { type: col["media-type"] } : {}),
      ...(typeof col["media-source"] === "string" ? { source: col["media-source"] } : {}),
      ...(MARGINS.every((m) => col[m] === 0) ? { borderless: true } : {}),
    });
  }
  if (papers.length) return papers;
  for (const name of (res.attrs["media-ready"] ?? []).map(String)) {
    const known = SIZES.find((s) => s.media === name);
    const m = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(in|mm)$/.exec(name);
    const unit = m?.[3] === "in" ? 2540 : 100;
    if (known) add({ ...known });
    else if (m) add({ media: name, label: name, x: Math.round(Number(m[1]) * unit), y: Math.round(Number(m[2]) * unit) });
  }
  return papers;
}

const paperKey = (text: string) => text.toLowerCase().replace(/[\s"”″]/g, "").replace(/[×*]/g, "x").replace(/(in|inch|inches)$/, "");

/** The paper for one job: the one asked for, or plain document paper when none is named. */
function choosePaper(papers: Paper[], wanted: string): Paper {
  const loaded = papers.map(describe).join(", ");
  if (wanted) {
    const key = paperKey(wanted);
    const found = papers.find((p) => paperKey(p.label) === key || p.media === wanted);
    if (!found) throw new PrintError(`${wanted} paper is not loaded; nothing was printed. Loaded now: ${loaded || "unknown"}. Ask the user to load it (and set its size on the printer), or print on a loaded paper.`);
    return found;
  }
  // A printer that does not say what is loaded gets Letter, its usual default.
  if (!papers.length) return { ...LETTER };
  const plain = papers.find(isPlain);
  if (!plain) throw new PrintError(`No plain paper is loaded (loaded now: ${loaded}); nothing was printed. Pass paper to print on what is loaded, or ask the user to load plain paper.`);
  return plain;
}

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
      "PDFs print at their original size (shrunk if larger than the paper); images are scaled to fill the page inside a small margin, centered, or with borderless to cover the whole sheet. At most 50 pages at a time.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file to print: an absolute path in the workspace, e.g. /home/gem/workspace/tasks/<task id>/report.pdf" },
        pages: { type: "string", description: "Print only these pages of the PDF, e.g. \"1-3,5\"; omit to print all pages" },
        copies: { type: "integer", minimum: 1, maximum: MAX_COPIES, description: "Number of copies, default 1" },
        sides: { type: "string", enum: SIDES, description: "One- or two-sided: one-sided (default); two-sided-long-edge flips on the long edge (ordinary portrait documents); two-sided-short-edge flips on the short edge" },
        color: { type: "boolean", description: "false prints in black and white (saves color ink); color by default" },
        paper: { type: "string", description: "The paper to print on, one of the papers printer_status lists as loaded, e.g. \"Letter\", \"A4\", \"4x6\". Omit for plain document paper; photo paper is used only when named here" },
        quality: { type: "string", enum: Object.keys(QUALITIES), description: "Print quality: high is the printer's finest mode (slower, more ink), for photos; normal for documents. Default: high on photo paper, normal otherwise" },
        borderless: { type: "boolean", description: "true prints to the very edge of the paper with no white border, on a paper printer_status lists as \"borderless available\": an image is enlarged to cover the whole sheet (its overhang is cropped), a PDF page keeps its size. Default false: a white margin all around" },
      },
      required: ["path"],
    },
  },
  {
    name: "print_history",
    description:
      "The home printer's recent jobs, newest first: when, the file, pages and copies, paper and settings, whether it was sent, refused or of unknown outcome, and the ink level of each color when the job started; with the ink levels now. " +
      "Use it to answer what was printed and how much ink printing has used. Jobs of other accounts appear without their file names.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: HISTORY_MAX, description: `How many jobs to list, default ${HISTORY_DEFAULT}` } },
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
  "Print only when the user asks to print; follow what the user said for copies, pages, one- or two-sided, color or black and white, and paper, and if they did not say, use 1 copy, one-sided, color, on plain paper. The printer can hold several papers at once (e.g. Letter plain paper and 4x6 photo paper): printer_status lists them; pass paper to print_file when the user names a size or wants a photo print on photo paper, and when it is unclear which paper they mean, ask. Photo paper prints at high quality on its own; pass quality only when the user asks for finer or faster printing than that default. Pass borderless only when the user asks for a borderless (edge-to-edge, no white border) print. Confirm with the user first for more than 20 pages or multiple copies. " +
  "You can check the state with printer_status before and after printing; tell the user truthfully when it is out of paper, has a paper jam, or is low on ink. When the tool says the outcome is uncertain, do not print again automatically; first ask the user to look at the printer. print_history lists what was printed and the ink levels at each job.";

/** Turning one account's workspace file into printer pages. */
export interface PrintFiles {
  rasterize(file: string, opts: { color: boolean; sides: Sides; media: string; width: number; height: number; pages: number[]; borderless: boolean; dpi: number }): Promise<{ bytes: Buffer; pages: number }>;
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
          ["python3", "-", stat.realPath, out, opts.color ? "srgb" : "sgray", opts.sides, String(opts.width), String(opts.height), opts.media, opts.pages.join(","), opts.borderless ? "borderless" : "margins", String(opts.dpi)],
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
  #db: Db | undefined;
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
    /** Where the jobs are remembered; without it there is no history. */
    db?: Db;
  }) {
    this.#port = opts.port;
    this.#log = opts.log.child("printer");
    this.#printerUri = opts.printerUri;
    this.#accounts = opts.accounts;
    this.#workspace = opts.workspace.replace(/\/$/, "");
    this.#usernameOf = opts.usernameOf;
    this.#filesFor = opts.filesFor;
    this.#db = opts.db;
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
        if (name === "print_history") return reply(await this.#tool(() => this.#history(account, args)));
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

  async #printer(): Promise<IppResponse> {
    const wanted = ["media-col-ready", "printer-state", "printer-state-reasons", "printer-state-message", "marker-names", "marker-levels", "media-ready", "printer-make-and-model", "queued-job-count"];
    let res: IppResponse;
    try {
      res = await this.#ipp(OP.getPrinterAttributes, [[TAG.keyword, "requested-attributes", wanted]]);
    } catch (err) {
      throw new PrintError(`Cannot reach the printer (${err instanceof Error ? err.message : String(err)}): it may be turned off or not on the network`);
    }
    if (res.status >= 0x0100) throw new PrintError(`The printer refused the query (IPP status 0x${res.status.toString(16)})`);
    return res;
  }

  async #status(): Promise<string> {
    const res = await this.#printer();
    const a = res.attrs;
    const reasons = problems(a);
    const ink = inkOf(a);
    const paper = loadedPapers(res).map(describe).join(", ");
    return [
      `Printer: ${a["printer-make-and-model"]?.[0] ?? "unknown model"}`,
      `Status: ${STATES[Number(a["printer-state"]?.[0])] ?? "unknown"}${reasons.length ? ` (${reasons.join(", ")})` : ""}`,
      a["queued-job-count"] ? `Queued jobs: ${a["queued-job-count"][0]}` : "",
      ink ? `Ink: ${ink}` : "",
      paper ? `Paper: ${paper}` : "",
    ].filter(Boolean).join("\n");
  }

  #remember(account: { userId: string }, job: { file: string; pages: number; copies: number; settings: string; outcome: "sent" | "refused" | "unknown"; jobId?: unknown; ink: string }): void {
    try {
      this.#db
        ?.prepare("INSERT INTO print_jobs (created_at, owner_id, file, pages, copies, settings, outcome, job_id, ink) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(Date.now(), account.userId, job.file, job.pages, job.copies, job.settings, job.outcome, Number.isInteger(job.jobId) ? (job.jobId as number) : null, job.ink);
    } catch (err) {
      this.#log.warn("print job not recorded", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async #history(account: { userId: string }, args: Record<string, unknown>): Promise<string> {
    const limit = args.limit === undefined ? HISTORY_DEFAULT : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX) throw new PrintError(`limit must be an integer from 1 to ${HISTORY_MAX}`);
    if (!this.#db) throw new PrintError("Print history is not kept on this installation");
    const rows = this.#db.prepare("SELECT * FROM print_jobs ORDER BY id DESC LIMIT ?").all(limit) as Array<{ created_at: number; owner_id: string; file: string; pages: number; copies: number; settings: string; outcome: string; job_id: number | null; ink: string }>;
    const total = (this.#db.prepare("SELECT COUNT(*) AS n FROM print_jobs").get() as { n: number }).n;
    const now = await this.#printer().then((res) => inkOf(res.attrs) || "not reported", (err) => `unknown (${err instanceof Error ? err.message : String(err)})`);
    const outcomes: Record<string, string> = { sent: "sent", refused: "refused by the printer, not printed", unknown: "outcome unknown" };
    return [
      `Ink now: ${now}`,
      rows.length ? `Jobs, newest first (${rows.length} of ${total}):` : "No print jobs recorded yet.",
      ...rows.map((r) =>
        [
          `${new Date(r.created_at).toLocaleString("sv-SE")}: ${r.owner_id === account.userId ? r.file : "(another account's job)"}, ${r.pages} pages × ${r.copies} copies, ${r.settings}`,
          `${outcomes[r.outcome] ?? r.outcome}${r.job_id === null ? "" : `, job ${r.job_id}`}`,
          r.ink ? `ink then: ${r.ink}` : "",
        ].filter(Boolean).join("; "),
      ),
    ].join("\n");
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
    const wanted = typeof args.paper === "string" ? args.paper.trim() : "";
    const borderless = args.borderless === true;
    if (args.quality !== undefined && !Object.hasOwn(QUALITIES, String(args.quality))) throw new PrintError(`quality must be ${Object.keys(QUALITIES).join(" / ")}`);

    const job = this.#queue.then(async () => {
      const printer = await this.#printer();
      const a = printer.attrs;
      if (Number(a["printer-state"]?.[0]) === 5) throw new PrintError(`The printer is stopped; nothing was printed: ${problems(a).join(", ") || "reason unknown"}`);
      const paper = choosePaper(loadedPapers(printer), wanted);
      const { media } = paper;
      if (borderless && !paper.borderless) throw new PrintError(`The printer does not offer borderless printing on ${describe(paper)}; nothing was printed. Print it with margins, or on a paper listed as borderless available.`);
      const quality = (args.quality as Quality | undefined) ?? (isPhoto(paper) ? "high" : "normal");
      const dpi = quality === "high" && paper.x <= FINE_MAX_WIDTH ? FINE_DPI : DPI;
      const [width, height] = [pixels(paper.x, dpi), pixels(paper.y, dpi)];
      // Size, tray and paper type together when the printer told us them, so it cannot feed from another tray.
      const mediaAttr: Parameters<typeof encodeRequest>[4] = paper.source
        ? [[TAG.begCollection, "media-col", { "media-size": { "x-dimension": paper.x, "y-dimension": paper.y }, "media-source": paper.source, ...(paper.type ? { "media-type": paper.type } : {}), ...(borderless ? Object.fromEntries(MARGINS.map((m) => [m, 0])) : {}) }]]
        : [[TAG.keyword, "media", media]];
      const files = await this.#filesFor(account.userId);
      const raster = await files.rasterize(file, { color, sides, media, width, height, pages, borderless, dpi });
      const settings = `${sides === "one-sided" ? "one-sided" : "two-sided"}, ${color ? "color" : "black and white"}, on ${paper.label}${borderless ? ", borderless" : ""}, ${quality} quality`;
      const remember = (outcome: "sent" | "refused" | "unknown", jobId?: unknown) =>
        this.#remember(account, { file: path.posix.basename(file), pages: raster.pages, copies, settings, outcome, jobId, ink: inkOf(a) });
      const started = Date.now();
      let res: IppResponse;
      try {
        res = await this.#ipp(
          OP.printJob,
          [[TAG.name, "requesting-user-name", account.username], [TAG.name, "job-name", path.posix.basename(file).slice(0, 200)], [TAG.mime, "document-format", "image/pwg-raster"]],
          [[TAG.integer, "copies", copies], [TAG.keyword, "sides", sides], [TAG.keyword, "print-color-mode", color ? "color" : "monochrome"], [TAG.enum, "print-quality", QUALITIES[quality]], ...mediaAttr],
          raster.bytes,
          180_000,
        );
      } catch (err) {
        // The document may or may not have reached the printer: never resend on our own.
        remember("unknown");
        this.#log.warn("print job outcome unknown", { user: account.username, error: err instanceof Error ? err.message : String(err) });
        throw new PrintError(`An error occurred while sending (${err instanceof Error ? err.message : String(err)}); not sure whether the printer received it. Do not resend automatically; first ask the user to check whether the printer printed anything.`);
      }
      if (res.status >= 0x0100) remember("refused");
      if (res.status >= 0x0100) throw new PrintError(`The printer refused this job (IPP status 0x${res.status.toString(16)}${res.attrs["status-message"] ? `: ${res.attrs["status-message"][0]}` : ""}); nothing was printed`);
      const jobId = res.attrs["job-id"]?.[0];
      remember("sent", jobId);
      const state = JOB_STATES[Number(res.attrs["job-state"]?.[0])] ?? "received";
      this.#log.info("print job sent", { user: account.username, jobId, pages: raster.pages, copies, sides, color, paper: describe(paper), borderless, quality, dpi, bytes: raster.bytes.length, ms: Date.now() - started });
      const warn = problems(a);
      return [
        `Sent to the printer: ${path.posix.basename(file)}, ${raster.pages} pages × ${copies} copies, ${settings}.`,
        `Job ${jobId ?? "unknown"}, status: ${state}.`,
        warn.length ? `Printer notes: ${warn.join(", ")}` : "",
      ].filter(Boolean).join("\n");
    });
    this.#queue = job.catch(() => undefined);
    return await job;
  }
}

/** Each ink's level, in words. */
function inkOf(a: IppResponse["attrs"]): string {
  const levels = a["marker-levels"] ?? [];
  return (a["marker-names"] ?? []).map((n, i) => `${String(n).replace(/ ink$/i, "")} ${Number(levels[i]) >= 0 ? `${levels[i]}%` : "unknown"}`).join(", ");
}

/** The printer's state reasons that matter to a person, in words. */
function problems(a: IppResponse["attrs"]): string[] {
  return [...new Set((a["printer-state-reasons"] ?? []).map(String).filter((r) => r !== "none").map((r) => {
    const base = r.replace(/-(report|warning|error)$/, "");
    return REASONS[base] ?? r;
  }))];
}
