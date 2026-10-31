import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../../common/logger.js";
import type { SandboxContainer } from "../sandbox/container.js";
import { KB_CERTAINTIES, KB_KINDS, KB_PROPOSAL_TYPES, KB_RELS, sha256, type KbReadFile } from "./kernel.js";
import { checkProposal, getKbNode, kbNeighbors, kbSourceText, proposalStatus, proposeKb, searchKb } from "./read.js";
import { SharedKbError, type SharedKbs } from "./shared.js";
import { callHistoryTool, HISTORY_POLICY, HISTORY_TOOLS } from "./historyTools.js";
import type { TaskService } from "../tasks/service.js";

/**
 * The personal knowledge base, offered to every agent of the account as one MCP
 * server on the member gateway (`/task-kb/<token>/mcp`): reading tools and
 * kb_propose, and beside them the raw task history and standing agreements it is
 * distilled from (historyTools.ts). There is no tool that writes knowledge on any
 * URL; only the control plane's kernel does, from the maintainer's answers (maintainer.ts).
 */

const KNOWLEDGE_POLICY =
  "The user's personal knowledge base aio_task_kb is connected: what earlier tasks of this account found out, kept by a knowledge maintainer as a graph of entities, topics, procedures and facts, each claim with its sources. " +
  "Before working on something this account may have dealt with before (a person, product, store, website or app, a trip, a recurring chore, a setup), search it with kb_search, read the relevant node with kb_get, follow related nodes with kb_neighbors, and read the evidence with kb_source when the exact wording or numbers matter. " +
  "Claims marked observed or inferred are leads, not guarantees; claims that change (prices, opening hours, availability) or nodes with pending corrections must be checked again before use. The family knowledge base (aio_kb, when connected) takes precedence on family members' records. " +
  "You cannot change the knowledge base yourself, and you do not need to report routine results: the maintainer reads every finished task. Use kb_propose only for what the task record will not show or for knowledge that is now wrong: " +
  "add (something worth reusing you saw while working, such as a pitfall or the wording of a policy), correct (a claim differs from what you see now), outdated (a procedure or link no longer works), wrong (the user corrected it). Each proposal needs evidence from this task: an exact quote, with the file path in this task's directory or the page address it came from. Never propose credentials, identity numbers or one-off details. " +
  "The person may also belong to shared knowledge bases kept with other people (a family, a project): kb_search and kb_get cover them too and name the library each result comes from. Knowledge in a shared library was contributed by its members; only quotes of its sources are kept there. " +
  "When the user asks to record something in a shared library by name (\"记到家庭知识库\", \"add this to the project's knowledge base\"), list them with kb_libraries and send kb_propose type add with library set to its name; when no library or more than one matches, propose it without library (the personal one) and tell the user which libraries exist. Otherwise the maintainer decides after the task what is shared, by each library's rules."; // i18n-exempt: an example of what people say, for the executor

export const TASK_KB_POLICY = `${KNOWLEDGE_POLICY}\n\n${HISTORY_POLICY}`;

const KB_TOOLS = [
  {
    name: "kb_search",
    description: "Search the personal knowledge base: nodes ranked by relevance, each with its domain, kind, gist, its best-matching claims, and how many corrections are pending. Without query, lists the most recently changed nodes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few keywords; names of people, items, places, websites or apps work best, e.g. \"Costco 退货\" (\"Costco returns\")" }, // i18n-exempt: examples of what people type, for the executor
        domain: { type: "string", description: "Only this domain (optional), e.g. shopping, health, travel, accounts" },
        kind: { type: "string", enum: [...KB_KINDS], description: "Only this kind (optional)" },
        limit: { type: "integer", description: "At most this many nodes, default 10, at most 30" },
      },
    },
  },
  {
    name: "kb_get",
    description: `Read one node in full: its claims (certainty ${KB_CERTAINTIES.join(" / ")}; recheck=true means verify before relying on it), every claim's sources (task, file or page, recorded quote), its links to other nodes, pending corrections, and its wiki page if it has one.`,
    inputSchema: { type: "object", properties: { id: { type: "string", description: "A node id from kb_search or kb_neighbors" }, history: { type: "boolean", description: "Also show superseded claims (default false)" } }, required: ["id"] },
  },
  {
    name: "kb_neighbors",
    description: `The nodes linked to one node, one or two steps out (relations: ${KB_RELS.join(", ")}).`,
    inputSchema: { type: "object", properties: { id: { type: "string" }, rel: { type: "string", enum: [...KB_RELS], description: "Only this relation (optional)" }, depth: { type: "integer", description: "1 or 2, default 1" } }, required: ["id"] },
  },
  {
    name: "kb_source",
    description: "Read the evidence behind a claim: the source file or task text around the recorded quote, and whether it is still current, has changed, or is gone.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "A source id from kb_get" } }, required: ["id"] },
  },
  {
    name: "kb_libraries",
    description: "The shared knowledge bases the person belongs to: each one's name, members and rules (what it keeps).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kb_propose",
    description: "Send the knowledge maintainer a proposal from this task. It is checked and queued, and returns at once; the maintainer decides later. A correct / outdated / wrong proposal immediately flags its node for everyone until then.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...KB_PROPOSAL_TYPES], description: "add: new knowledge worth reusing; correct: a claim differs from what is true now; outdated: no longer applies; wrong: the user corrected it" },
        task: { type: "string", description: "The current task ID" },
        target: { type: "string", description: "The node or claim id it is about (required except for add); a node of a shared library sends the proposal to that library" },
        library: { type: "string", description: "Only for add when the user named a shared library: its name as kb_libraries lists it" },
        text: { type: "string", description: "What to add, or what is true now, in one or two sentences" },
        reason: { type: "string", description: "Why (optional)" },
        evidence: {
          type: "array",
          description: "1-5 items from this task: { quote: the exact words, path: a file in this task's directory (optional), url: the page it came from (optional) }; without path and url the quote must appear in this task's messages or results",
          items: { type: "object", properties: { quote: { type: "string" }, path: { type: "string" }, url: { type: "string" } }, required: ["quote"] },
        },
      },
      required: ["type", "task", "text", "evidence"],
    },
  },
  {
    name: "kb_propose_status",
    description: "How the maintainer decided a proposal: pending, accepted, merged or rejected, with its note.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

/** Thread-level MCP wiring for a Codex executor (and the maintainer's own threads). */
export function taskKbThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.taskKb ? { aio_task_kb: { url: cfg.taskKb.url, tool_timeout_sec: 30 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function taskKbMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.taskKb ? { aio_task_kb: { type: "http", url: cfg.taskKb.url } } : {};
}

const TOOLS = [...KB_TOOLS, ...HISTORY_TOOLS];
const HISTORY_TOOL_NAMES = new Set(HISTORY_TOOLS.map((t) => t.name));

const MAX_FILE_BYTES = 2_000_000;

/** A file's text (its first 2 MB) and that text's fingerprint, read inside the account's sandbox. */
export function sandboxKbFiles(container: Pick<SandboxContainer, "execInSandbox">): KbReadFile {
  return async (file) => {
    const res = await container.execInSandbox(["bash", "-c", `[ -f "$1" ] || exit 3; head -c ${MAX_FILE_BYTES} -- "$1"`, "kb-read", file], { timeoutMs: 30_000 });
    if (res.code === 3) return null;
    if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 200) || `exit ${res.code}`);
    return { text: res.stdout, sha256: sha256(res.stdout) };
  };
}

export interface TaskKbRuntime { db: Db; tasks: TaskService; cfg: Config; container: Pick<SandboxContainer, "execInSandbox">; taskKb?: { nudge(urgent: boolean): void }; sharedKb?: SharedKbs }

/** A shared node as an agent reads it: the library named, sources with who gave them (a path is someone else's file). */
function sharedNode(shared: SharedKbs, library: string, node: NonNullable<ReturnType<typeof getKbNode>>) {
  return {
    library: shared.library(library)?.name ?? library,
    ...node,
    claims: node.claims.map((c) => ({ ...c, sources: c.sources.map((s) => ({ id: s.id, excerpt: s.excerpt, captured: s.captured, url: s.url, from: s.contributor ? shared.usernameOf(s.contributor) : null, kind: s.kind })) })),
  };
}

export class TaskKbGateway {
  #port: number;
  #log: Logger;
  #runtimeFor: (userId: string) => Promise<TaskKbRuntime>;
  #tokens = new Map<string, string>();

  constructor(opts: { port: number; log: Logger; runtimeFor: (userId: string) => Promise<TaskKbRuntime> }) {
    this.#port = opts.port;
    this.#log = opts.log.child("task-kb");
    this.#runtimeFor = opts.runtimeFor;
  }

  /** Give a runtime its knowledge-base URL. */
  provision(cfg: Config): void {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "task-kb-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, cfg.runtimeUserId!);
    cfg.taskKb = { url: `http://host.docker.internal:${this.#port}/task-kb/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/task-kb\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
    const userId = match ? this.#tokens.get(match[1]!) : undefined;
    if (!userId) return send(403, { error: "forbidden" });
    if (req.method === "DELETE") return send(200, {});
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 256 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad request" });
    }
    const headers: Record<string, string> = {};
    if (!Array.isArray(body) && (body as { method?: string })?.method === "initialize") headers["mcp-session-id"] = randomUUID();
    const messages = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(messages.map((m) => this.#rpc(userId, m)))).filter(Boolean);
    if (!out.length) return send(202, undefined, headers);
    return send(200, Array.isArray(body) ? out : out[0], headers);
  }

  async #rpc(userId: string, message: unknown): Promise<unknown> {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: Record<string, unknown> };
    if (id === undefined || id === null) return null; // a notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "aio_task_kb", version: "1" },
          instructions: TASK_KB_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(params?.name);
        if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
        return reply(await this.#call(userId, name, (params?.arguments ?? {}) as Record<string, unknown>));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  /** A proposal for a shared library: checked against this task like any other, then only its quotes travel. */
  async #toLibrary(runtime: TaskKbRuntime, userId: string, library: string, target: string | null, args: Record<string, unknown>): Promise<string> {
    const checked = await checkProposal({ db: runtime.db, ownerId: userId, workspaceDir: runtime.cfg.sandbox.containerWorkspaceDir, readFile: sandboxKbFiles(runtime.container) }, args);
    if ("error" in checked) throw new Error(checked.error);
    if (checked.type !== "add" && !target) throw new Error(`a ${checked.type} proposal needs target: the node or claim it is about`);
    const shared = runtime.sharedKb!;
    try {
      const id = shared.enqueue(library, { from: userId, type: checked.type, task: checked.task, target, text: checked.text, reason: checked.reason, evidence: checked.evidence.map((e) => ({ ...e, contributor: userId })) });
      const name = shared.library(library)?.name ?? library;
      return `Proposal ${id} sent to the maintainer of the shared knowledge base "${name}"${target && checked.type !== "add" ? `; node ${target} is flagged until it decides` : ""}. Carry on with the task.`;
    } catch (err) {
      throw new Error(err instanceof SharedKbError ? err.message : String(err));
    }
  }

  async #call(userId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      const runtime = await this.#runtimeFor(userId);
      if (HISTORY_TOOL_NAMES.has(name)) return callHistoryTool(runtime, userId, name, args);
      const { db, cfg } = runtime;
      const readFile = sandboxKbFiles(runtime.container);
      const workspaceDir = cfg.sandbox.containerWorkspaceDir;
      const shared = runtime.sharedKb;
      const libraries = shared ? shared.librariesOf(userId) : [];
      if (name === "kb_search") {
        const opts = { query: str(args.query), domain: str(args.domain), kind: str(args.kind), limit: typeof args.limit === "number" ? args.limit : undefined };
        const hits: Array<Record<string, unknown>> = searchKb(db, userId, opts).map((h) => ({ library: "personal", ...h }));
        for (const lib of libraries) hits.push(...searchKb(shared!.db(lib.id), lib.id, opts).map((h) => ({ library: lib.name, ...h })));
        return text(hits.length ? hits : "Nothing in the knowledge base matches. Try other keywords or names, or drop domain/kind; the knowledge base only holds what earlier tasks found out.");
      }
      if (name === "kb_libraries") {
        return text(libraries.length
          ? libraries.map((l) => ({ name: l.name, members: shared!.members(l.id).map((m) => m.username), rules: shared!.rules(l.id).text || "(none written yet: keep what the members would all find useful)" }))
          : "The person belongs to no shared knowledge base; everything goes to their personal one.");
      }
      const id = String(args.id ?? "");
      const lib = shared && !db.prepare("SELECT 1 FROM kb_nodes WHERE id=? AND owner_id=?").get(id, userId) ? shared.libraryOfNode(userId, id) : null;
      if (name === "kb_get") {
        if (lib) { const node = getKbNode(shared!.db(lib), lib, id, { read: true, history: args.history === true }); return node ? text(sharedNode(shared!, lib, node)) : text("No such node", true); }
        const node = getKbNode(db, userId, id, { read: true, history: args.history === true });
        return node ? text(node) : text("No such node", true);
      }
      if (name === "kb_neighbors") {
        const near = lib ? kbNeighbors(shared!.db(lib), lib, id, { rel: str(args.rel), depth: typeof args.depth === "number" ? args.depth : undefined })
          : kbNeighbors(db, userId, id, { rel: str(args.rel), depth: typeof args.depth === "number" ? args.depth : undefined });
        return near ? text(near.length ? near : "This node has no links yet.") : text("No such node", true);
      }
      if (name === "kb_source") {
        const source = await kbSourceText(db, userId, id, readFile, workspaceDir);
        if (source) return text(source);
        for (const l of libraries) {
          const row = shared!.db(l.id).prepare("SELECT excerpt, url, contributor, captured_at FROM kb_sources WHERE id=? AND owner_id=?").get(id, l.id) as { excerpt: string; url: string | null; contributor: string | null; captured_at: number } | undefined;
          if (row) return text({ source: id, library: l.name, from: row.contributor ? shared!.usernameOf(row.contributor) : null, captured: new Date(row.captured_at).toISOString().slice(0, 10), quote: row.excerpt, ...(row.url ? { url: row.url } : {}),
            state: "shared", note: "Only this quote was kept when it was shared; the original is in the contributor's own workspace." });
        }
        return text("No such source", true);
      }
      if (name === "kb_propose") {
        const raw = str(args.target)?.trim() ?? "";
        const targetLib = raw && shared && !db.prepare("SELECT 1 FROM kb_nodes WHERE id=? AND owner_id=?").get(raw, userId) && !db.prepare("SELECT 1 FROM kb_claims c JOIN kb_nodes n ON n.id=c.node_id WHERE c.id=? AND n.owner_id=?").get(raw, userId)
          ? (shared.libraryOfNode(userId, raw) ? { library: shared.libraryOfNode(userId, raw)!, node: raw } : shared.libraryOfClaim(userId, raw)) : null;
        const named = str(args.library)?.trim();
        if (named && !raw) {
          const exact = libraries.filter((l) => l.name === named);
          const loose = exact.length ? exact : libraries.filter((l) => l.name.toLowerCase().includes(named.toLowerCase()) || named.toLowerCase().includes(l.name.toLowerCase()));
          if (loose.length !== 1) return text(`${loose.length ? "More than one" : "No"} shared knowledge base matches "${named}" (the person's: ${libraries.map((l) => l.name).join(", ") || "none"}). Propose it without library to keep it in the personal knowledge base, and tell the user.`, true);
          return text(await this.#toLibrary(runtime, userId, loose[0]!.id, null, args));
        }
        if (targetLib) return text(await this.#toLibrary(runtime, userId, targetLib.library, targetLib.node, args));
        const result = await proposeKb({ db, ownerId: userId, workspaceDir, readFile }, args);
        if ("error" in result) return text(result.error, true);
        runtime.taskKb?.nudge(args.type !== "add");
        return text(`Proposal ${result.id} sent to the knowledge maintainer${result.target && args.type !== "add" ? `; node ${result.target} is flagged until it decides` : ""}. Carry on with the task; check the decision later with kb_propose_status if it matters.`);
      }
      if (name === "kb_propose_status") {
        const status = proposalStatus(db, userId, id);
        if (status) return text(status);
        for (const l of libraries) {
          const row = shared!.db(l.id).prepare("SELECT status, note FROM kb_packets WHERE id=? AND owner_id=? AND json_extract(payload_json,'$.from')=?").get(id, l.id, userId) as { status: string; note: string | null } | undefined;
          if (row) return text({ ...row, library: l.name });
        }
        return text("No such proposal", true);
      }
      return text(`unknown tool ${name}`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn("task-kb tool call failed", { tool: name, error: message });
      return text(message, true);
    }
  }
}
