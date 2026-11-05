import path from "node:path";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { readSecretFile } from "../common/secrets.js";
import { McpGateway } from "./mcpGateway.js";
import type { ClipFiles } from "./camera.js";
import { requireWorkspaceFilePath } from "./documents/paths.js";

/**
 * The knowledge base: an MCP server the owner runs on the host, offered to the
 * owner's and the listed members' executors through the member gateway
 * (McpGateway, at `/kb/<token>/mcp`). Which of them may also add notes
 * (`kb_note`) is the upstream's decision, by the username this gateway sends.
 * `kb_file` is the gateway's own: it fetches a cited original (the upstream's
 * `GET /file`) and saves it into the account's workspace, so the file's bytes
 * never pass through the model.
 */

export const KB_MCP_KEY = "KB_MCP_TOKEN";
// A scanned original is read by text recognition on the knowledge base's host: a dozen pages take ~15 s.
const TIMEOUT_MS = 90_000;

const KB_FILE_TOOL = {
  name: "kb_file",
  description: "Save the original file itself that a page cites (a photo, scan, PDF or document, as stored) into the workspace and return its path, to send it, convert it (e.g. HEIC to JPG) or attach it. id and n are the page and the source number from kb_read's source list. The file is not shown to you; open or convert it in the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The page id that lists the source, e.g. t0/some-topic" },
      n: { type: "integer", description: "The source number (from 1) in kb_read's source list" },
      path: { type: "string", description: "Where to save it: an absolute path in the workspace, inside this task's folder; if omitted, /home/gem/workspace/kb-files/<original name>" },
    },
    required: ["id", "n"],
  },
};

/** Thread-level MCP wiring for a Codex executor. */
export function kbThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.kb ? { aio_kb: { url: cfg.kb.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function kbMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.kb ? { aio_kb: { type: "http", url: cfg.kb.url } } : {};
}

export const KB_POLICY =
  "The knowledge base aio_kb is connected (read-only; accounts allowed to write also have kb_note): when a question involves the user's own or their family's circumstances, past records and arrangements, or the user's own projects, first search and read the existing records, then carry out the task using that content; do not ask the user for information you can look up. Nicknames, English names, and formal names may differ; if the first search finds nothing, search again with aliases from related records. When a page is an index of sources, an unwritten field value does not mean there is no record: when you need a birthday, age, address, exact words, or numbers, use kb_source to read the relevant originals the page lists; calculate ages from the verified birthday and this task's target date, and do not copy an old age. From the originals, quote only the parts of numbers, IDs, addresses, diagnoses, and dosages that the task needs. The current user's corrections take precedence over historical material; verify time-sensitive information again. Only after the relevant searches, pages, and necessary checks of the originals still come up short, state the specific gap; do not make things up, and do not treat retrieval as the final deliverable and forget to continue the original task. When the user wants an original itself (a photo, a scan, a PDF: to send, convert or attach it), save it into the workspace with kb_file and work on that copy; kb_source only gives its text. When kb_note is among the tools, and the user asks you to remember, note down, or correct something, or to add it to the family knowledge base, use it to add a note (stating the fact, the people involved, the time, and the source clearly); do not merely promise in the conversation to remember it. When the chat brings up new family preferences (diet, routines, likes and dislikes, regular stores and doctors, and so on) or matters about Roy (health, feeding, sleep, growth, care, and arrangements), record them proactively even if the user did not ask; before recording, search first to confirm there is no identical record; record the same thing only once per conversation; after recording, briefly say in your reply what you recorded. Do not record small talk, temporary arrangements, your own suggestions, or credentials such as passwords and ID numbers.";

export class KbGateway extends McpGateway {
  #files: ((username: string) => Promise<ClipFiles>) | null;
  #workspace: string;
  #fileUrl: string;

  constructor(opts: {
    cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null;
    /** An account's workspace, where kb_file saves originals. */
    files?: (username: string) => Promise<ClipFiles>;
    onToolCall?: (username: string, tool: unknown) => void;
  }) {
    super({
      ...opts,
      name: "kb",
      upstreamUrl: opts.cfg.kbMcp.upstreamUrl,
      secretKey: KB_MCP_KEY,
      secretsFile: opts.cfg.kbMcp.secretsFile,
      // The owner, and the members the owner listed.
      granted: (username, runtime) => !runtime.memberRuntime || opts.cfg.kbMcp.members.includes(username),
      assign: (runtime, url) => { runtime.kb = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
    this.#files = opts.files ?? null;
    this.#workspace = opts.cfg.sandbox.containerWorkspaceDir.replace(/\/$/, "");
    this.#fileUrl = opts.cfg.kbMcp.upstreamUrl.replace(/\/mcp\/?$/, "/file");
  }

  /** The upstream's tools plus kb_file, which the gateway answers itself. */
  protected override async local(message: unknown, username: string): Promise<unknown> {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (!this.#files || id === undefined || id === null) return undefined;
    if (method === "tools/list") {
      const upstream = (await this.rpcUpstream(message, username)) as { result?: { tools?: unknown[] } };
      if (!Array.isArray(upstream?.result?.tools)) return upstream;
      return { ...upstream, result: { ...upstream.result, tools: [...upstream.result.tools, KB_FILE_TOOL] } };
    }
    if (method === "tools/call" && params?.name === KB_FILE_TOOL.name) {
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      return { jsonrpc: "2.0", id, result: await this.#saveFile(args, username) };
    }
    return undefined;
  }

  async #saveFile(args: Record<string, unknown>, username: string): Promise<unknown> {
    const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    const page = typeof args.id === "string" ? args.id.trim() : "";
    const n = Number(args.n);
    if (!page || !Number.isInteger(n) || n < 1) return fail("id (the page) and n (a source number from 1) are required, from kb_read's source list");
    let res: Response;
    try {
      res = await fetch(`${this.#fileUrl}?id=${encodeURIComponent(page)}&n=${n}`, {
        headers: { authorization: `Bearer ${this.upstreamToken()}`, "x-aio-user": username },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return fail("The knowledge base is unavailable right now");
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
      return fail(`The original could not be fetched: ${detail}`);
    }
    const name = path.posix.basename(decodeURIComponent(res.headers.get("x-file-name") ?? "")).replace(/[\u0000-\u001f/]/g, "_") || "original";
    let target = `${this.#workspace}/kb-files/${name}`;
    if (typeof args.path === "string" && args.path.trim()) {
      const checked = requireWorkspaceFilePath(args.path.trim(), this.#workspace);
      if (!checked.ok) return fail(`path: ${checked.message}`);
      target = checked.path;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    try {
      await (await this.#files!(username)).write(target, bytes);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const source = decodeURIComponent(res.headers.get("x-source") ?? "");
    return { content: [{ type: "text", text: `Original saved: ${target} (${bytes.length} bytes${source ? `, from ${source}` : ""}). Open or convert it in the workspace; link it in your reply to give it to the user.` }] };
  }
}

/**
 * One read-only query (kb_sql) for the control plane's own use: its rows, or
 * null when no knowledge base is configured. Throws when it does not answer.
 */
export async function kbSql(cfg: Config, query: string): Promise<unknown[][] | null> {
  if (!cfg.kbMcp.upstreamUrl) return null;
  const token = readSecretFile(cfg.kbMcp.secretsFile, KB_MCP_KEY);
  if (!token.ok) return null;
  const res = await fetch(cfg.kbMcp.upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token.value}`, "x-aio-user": "aio-control" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_sql", arguments: { query } } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  const text = body.result?.content?.[0]?.text;
  if (!text || body.result?.isError) throw new Error(text?.slice(0, 200) ?? "no result");
  return (JSON.parse(text) as { rows: unknown[][] }).rows;
}
