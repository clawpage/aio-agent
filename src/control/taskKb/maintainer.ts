import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { getMeta, setMeta } from "../db.js";
import type { Logger } from "../../common/logger.js";
import type { CodexSessionLike } from "../codex/manager.js";
import type { SandboxContainer } from "../sandbox/container.js";
import type { SandboxIdleState } from "../sandbox/idle.js";
import { randomId } from "../auth/passwords.js";
import { historyThreadServers } from "../historyTool.js";
import { applyKbAnswer, ensureDomains, KB_CERTAINTIES, KB_KINDS, KB_LIMITS, KB_RELS, wikiIneligible, type KbAnswer } from "./kernel.js";
import { getKbNode, kbEnabled } from "./read.js";
import { sandboxKbFiles, taskKbThreadServers } from "./gateway.js";
import { renderKbProjection } from "./projection.js";

/**
 * The account's knowledge maintainer (docs/TASK-KB.md §3.3): a role, not a standing
 * session. Packets wait in kb_packets (a finished task to read, a proposal from an agent
 * at work); when the sandbox is awake and no task is running, one short read-only run
 * reads a batch and answers with a change list, which the kernel checks and writes.
 * Its memory is the knowledge base itself.
 */

export interface KbMaintainerDeps {
  db: Db;
  cfg: Config;
  log: Logger;
  codex: Pick<CodexSessionLike, "maintainKb">;
  container: Pick<SandboxContainer, "execInSandbox" | "writeFileInSandbox">;
  /** Whether the account's own tasks are running or queued: the maintainer gives way. */
  busy: () => Promise<boolean>;
  idleState: () => SandboxIdleState | undefined;
}

/** A batch reads at most this many packets and this much material. */
const BATCH_PACKETS = 4;
const BATCH_CHARS = 40_000;
const TASK_CHARS = 12_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const ATTEMPTS = 3;
/** Corrections are looked at within a minute; everything else waits to be batched. */
const URGENT_MS = 60_000;
const NORMAL_MS = 10 * 60_000;
const NEXT_BATCH_MS = 2 * 60_000;
const RETRY_MS = 5 * 60_000;
const BACKFILL_DAYS = 14;
const BACKFILL_KEY = "task_kb.backfill_v1";
const PROJECTION_DIRTY = "task_kb.projection_dirty";
const PRIORITY: Record<string, number> = { wrong: 0, correct: 1, outdated: 2, add: 3 };

interface TaskRow { id: string; title: string; input_text: string; result: string | null; status: string; schedule_id: string | null; merged_into: string | null; plan_json: string | null; turn_id: string | null; created_at: number; completed_at: number | null }
interface PacketRow { id: string; kind: "extract" | "propose"; type: string | null; task_id: string | null; target: string | null; payload_json: string; attempts: number; created_at: number }

const clip = (s: unknown, n: number) => { const c = [...String(s ?? "").replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };
const day = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "?");

export const MAINTAINER_INSTRUCTIONS = `You are the knowledge maintainer of one person's personal knowledge base inside Clawpage Agent. You are the only one who decides what it holds. You read finished tasks and proposals from agents, and you answer with one JSON change list; the control plane checks every item and writes it. You cannot write any other way and must not try to.

What belongs in it: things worth knowing the next time this person asks for something similar. People, products, stores, websites and apps they deal with (entity); subjects they keep coming back to (topic); how something is done, including the steps that worked and the pitfalls (procedure); and facts with lasting value (fact). Keep it small and reusable: skip small talk, one-off details, your own guesses presented as facts, temporary states, and anything already obvious. Never record passwords, codes, identity, card or account numbers (they are refused).

Before creating a node, search the knowledge base (aio_task_kb kb_search, then kb_get) for an existing node about the same thing and add to that one. Use merge when two existing nodes are the same thing. When a new claim contradicts an existing one, write the new claim with replaces (if it is now true) or link the nodes with contradicts (if both may hold), never silently drop the old one. You may read a task's files with shell commands (cat, ls, head) under its directory, and older tasks with aio_history.

Certainty: user_said = the person said it; observed = seen in a page, file or tool output during the task; inferred = your own conclusion. Volatility: changes = prices, opening hours, availability, schedules, anything that goes stale (give verify_after_days); stable otherwise.

Every claim needs sources: {"task": "<task id>", "quote": "<the exact words, 4-600 characters, copied verbatim>", and optionally "path": "tasks/<task id>/<file>" when the words are in a file of that task's directory, or "url": "<page address>" when they come from a page the task opened}. The quote must appear word for word in the file, or in that task's messages, results or tool outputs; otherwise the whole answer is sent back to you.

Answer with only this JSON (no prose, no code fence):
{"decisions":[{"packet":"<packet id>","status":"accepted|merged|rejected","note":"<short reason>"}],
 "ops":[
  {"op":"domain","name":"<new english-slug>","description":"..."},
  {"op":"node","ref":"<new short id, e.g. n1>","kind":"${KB_KINDS.join("|")}","domain":"<domain>","title":"<at most ${KB_LIMITS.title} chars>","summary":"<one sentence, at most ${KB_LIMITS.summary} chars>"},
  {"op":"update_node","id":"<node id>","title":"...","summary":"...","domain":"..."},
  {"op":"claim","node":"<node id or ref>","text":"<one statement, at most ${KB_LIMITS.claim} chars>","certainty":"${KB_CERTAINTIES.join("|")}","volatility":"stable|changes","verify_after_days":30,"replaces":"<claim id, optional>","sources":[...]},
  {"op":"link","src":"<node id or ref>","dst":"<node id or ref>","rel":"${KB_RELS.join("|")}","sources":[...optional]},
  {"op":"merge","from":"<node id>","into":"<node id or ref>"},
  {"op":"retire","id":"<node or claim id>","reason":"..."},
  {"op":"wiki","node":"<node id>","markdown":"<a reference page: conclusion first, then details, with the task ids it rests on>"}
 ]}
Give every packet a decision: accepted (its knowledge was recorded), merged (it repeated what is already there), rejected (not worth keeping, or the evidence does not hold; say why). A proposal's evidence is real but its conclusion is the agent's: check it against the node before accepting. Every new node needs at least one claim. Write titles, summaries and claims in the language the person uses. Only nodes listed as wiki candidates may get a wiki op.`;

export class TaskKbMaintainer {
  #d: KbMaintainerDeps;
  #log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #due = 0;
  #running = false;
  #stopped = false;

  constructor(deps: KbMaintainerDeps) {
    this.#d = deps;
    this.#log = deps.log.child("kb-maintainer");
  }

  get #owner(): string { return this.#d.cfg.runtimeUserId ?? "owner_1"; }

  /** Begin: the owner's one-off look back, then whatever is already waiting. */
  start(): void {
    const { db, cfg } = this.#d;
    ensureDomains(db, this.#owner);
    if (!cfg.memberRuntime && getMeta(db, BACKFILL_KEY) === null) {
      const since = Date.now() - BACKFILL_DAYS * 86_400_000;
      const rows = (db.prepare("SELECT t.* FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE c.owner_id=? AND t.status='completed' AND COALESCE(t.completed_at,t.created_at)>=? ORDER BY COALESCE(t.completed_at,t.created_at)")
        .all(this.#owner, since) as unknown as TaskRow[]).filter((t) => this.#worthReading(t));
      for (const t of rows) this.#enqueueExtract(t.id, t.completed_at ?? t.created_at);
      setMeta(db, BACKFILL_KEY, String(Date.now()));
      this.#log.info("knowledge backfill queued", { tasks: rows.length, days: BACKFILL_DAYS });
    }
    if (this.#pending().length) this.#schedule(NORMAL_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** A task finished: queue it for reading when it holds something to learn from. */
  taskCompleted(taskId: string): void {
    try {
      const row = this.#d.db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as TaskRow | undefined;
      if (!row || !kbEnabled(this.#d.db) || !this.#worthReading(row)) return;
      if (this.#d.db.prepare("SELECT 1 FROM kb_packets WHERE owner_id=? AND kind='extract' AND task_id=? AND status='pending'").get(this.#owner, taskId)) return;
      this.#enqueueExtract(taskId, Date.now());
      this.nudge(false);
    } catch (err) {
      this.#log.warn("task not queued for the knowledge base", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Something is waiting: a correction is looked at soon, anything else when a batch has gathered. */
  nudge(urgent: boolean): void {
    const many = this.#pending().length >= BATCH_PACKETS;
    this.#schedule(urgent || many ? URGENT_MS : NORMAL_MS);
  }

  #enqueueExtract(taskId: string, at: number): void {
    this.#d.db.prepare("INSERT INTO kb_packets (id, owner_id, kind, task_id, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(randomId("kbp"), this.#owner, "extract", taskId, "{}", at);
  }

  /** Chat, scheduled runs and the daily feed teach nothing; neither does a task that used no tools. */
  #worthReading(t: TaskRow): boolean {
    if (t.status !== "completed" || t.schedule_id || t.merged_into) return false;
    if (t.plan_json) { try { if ((JSON.parse(t.plan_json) as { answeredBy?: unknown }).answeredBy) return false; } catch { /* a plan that does not parse says nothing either way */ } }
    const turns = [t.turn_id, ...(this.#d.db.prepare("SELECT turn_id FROM tasks WHERE merged_into=?").all(t.id) as Array<{ turn_id: string | null }>).map((r) => r.turn_id)].filter(Boolean);
    return turns.some((turn) => this.#d.db.prepare("SELECT 1 FROM events WHERE turn_id=? AND type='item/completed' AND (payload LIKE '%\"type\":\"mcpToolCall\"%' OR payload LIKE '%\"type\":\"commandExecution\"%' OR payload LIKE '%\"type\":\"webSearch\"%' OR payload LIKE '%\"type\":\"fileChange\"%') LIMIT 1").get(turn));
  }

  #pending(): PacketRow[] {
    const rows = this.#d.db.prepare("SELECT * FROM kb_packets WHERE owner_id=? AND status='pending' ORDER BY created_at").all(this.#owner) as unknown as PacketRow[];
    return rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "propose" ? -1 : 1) || (PRIORITY[a.type ?? ""] ?? 9) - (PRIORITY[b.type ?? ""] ?? 9) || a.created_at - b.created_at);
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    const due = Date.now() + ms;
    if (this.#timer && this.#due <= due) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(() => { this.#timer = null; void this.run(); }, ms);
    this.#timer.unref?.();
  }

  /** Whether a run may start now: an awake sandbox (never woken for this) and none of the account's tasks at work. */
  async #canRun(): Promise<boolean> {
    const state = this.#d.idleState();
    if (state && state !== "running") return false;
    return !(await this.#d.busy());
  }

  /** One batch; returns how many packets it settled. Public for tests and the backfill. */
  async run(): Promise<number> {
    if (this.#running || this.#stopped || !this.#d.codex.maintainKb || !kbEnabled(this.#d.db)) return 0;
    const pending = this.#pending();
    if (!pending.length) { await this.#project(); return 0; }
    if (!(await this.#canRun())) { this.#schedule(RETRY_MS); return 0; }
    this.#running = true;
    let settled = 0;
    try {
      const batch = await this.#batch(pending);
      settled = await this.#process(batch.packets, batch.material);
      await this.#reviewWiki();
      await this.#project();
    } catch (err) {
      this.#log.warn("knowledge maintainer run failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.#running = false;
    }
    if (this.#pending().length) this.#schedule(settled ? NEXT_BATCH_MS : RETRY_MS);
    return settled;
  }

  async #batch(pending: PacketRow[]): Promise<{ packets: PacketRow[]; material: string }> {
    const parts: string[] = [];
    const packets: PacketRow[] = [];
    let used = 0;
    for (const p of pending) {
      if (packets.length >= BATCH_PACKETS) break;
      const text = p.kind === "extract" ? await this.#taskMaterial(p) : this.#proposalMaterial(p);
      if (packets.length && used + text.length > BATCH_CHARS) break;
      packets.push(p);
      parts.push(text);
      used += text.length;
    }
    return { packets, material: parts.join("\n\n") };
  }

  #proposalMaterial(p: PacketRow): string {
    const payload = JSON.parse(p.payload_json) as { text?: string; reason?: string; evidence?: Array<{ path?: string | null; url?: string | null; excerpt?: string }> };
    const node = p.target ? getKbNode(this.#d.db, this.#owner, p.target) : null;
    return [
      `### Packet ${p.id}: a ${p.type} proposal from task ${p.task_id} (${day(p.created_at)})`,
      `Proposal: ${payload.text ?? ""}${payload.reason ? `\nReason: ${payload.reason}` : ""}`,
      `Evidence (already checked to exist; cite it with task ${p.task_id} and the same quote and path or url):`,
      ...(payload.evidence ?? []).map((e) => `- quote: ${JSON.stringify(e.excerpt)}${e.path ? ` · path: ${e.path}` : ""}${e.url ? ` · url: ${e.url}` : ""}`),
      ...(node ? [`The node it is about, as it is now:`, JSON.stringify(node)] : []),
    ].join("\n");
  }

  async #taskMaterial(p: PacketRow): Promise<string> {
    const { db } = this.#d;
    const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(p.task_id) as TaskRow | undefined;
    if (!t) return `### Packet ${p.id}: task ${p.task_id} no longer exists; reject it.`;
    const merged = db.prepare("SELECT input_text, turn_id, created_at FROM tasks WHERE merged_into=? ORDER BY created_at").all(t.id) as Array<{ input_text: string; turn_id: string | null; created_at: number }>;
    const earlier = db.prepare("SELECT processed_at FROM kb_packets WHERE owner_id=? AND kind='extract' AND task_id=? AND status<>'pending' ORDER BY processed_at DESC LIMIT 1").get(this.#owner, t.id) as { processed_at: number } | undefined;
    const known = db.prepare(`SELECT DISTINCT n.id, n.title FROM kb_sources s JOIN kb_cites x ON x.source_id=s.id JOIN kb_claims c ON c.id=x.item_id JOIN kb_nodes n ON n.id=c.node_id
      WHERE s.owner_id=? AND s.task_id=? AND n.status='active' LIMIT 20`).all(this.#owner, t.id) as Array<{ id: string; title: string }>;
    const steps: string[] = [];
    for (const turn of [t.turn_id, ...merged.map((m) => m.turn_id)].filter((x): x is string => !!x)) {
      for (const { payload } of db.prepare("SELECT payload FROM events WHERE turn_id=? AND type='item/completed' ORDER BY id").all(turn) as Array<{ payload: string }>) {
        let item: Record<string, unknown>;
        try { item = (JSON.parse(payload) as { item?: Record<string, unknown> }).item ?? {}; } catch { continue; }
        const type = String(item.type ?? "");
        const output = (v: unknown) => { const texts: string[] = []; const walk = (x: unknown) => { if (typeof x === "string") texts.push(x); else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") Object.values(x).forEach(walk); }; walk(v); return clip(texts.join(" "), 900); };
        if (type === "mcpToolCall") steps.push(`tool ${item.server}.${item.tool}(${clip(JSON.stringify(item.arguments ?? {}), 240)}) → ${output(item.result ?? item.error)}`);
        else if (type === "commandExecution") steps.push(`command ${clip(String(item.command ?? "").replace(/^\/bin\/(ba)?sh -lc /, ""), 240)} → ${clip(item.aggregatedOutput, 700)}`);
        else if (type === "webSearch") steps.push(`search ${clip(item.query ?? (item.action as { query?: string } | null)?.query, 160)}`);
        else if (type === "fileChange") steps.push(`edit files ${clip(Array.isArray(item.changes) ? (item.changes as Array<{ path?: string }>).map((c) => c.path).join(", ") : "", 200)}`);
        else if (type === "agentMessage") steps.push(`said ${clip(item.text, 600)}`);
      }
    }
    // Long tasks keep their opening and, mostly, their end: where things were settled.
    let process = steps.join("\n");
    if (process.length > TASK_CHARS) process = `${process.slice(0, TASK_CHARS * 0.3)}\n… (middle steps left out) …\n${process.slice(-TASK_CHARS * 0.7)}`;
    let files = "";
    try {
      const dir = `${this.#d.cfg.sandbox.containerWorkspaceDir}/tasks/${t.id}`;
      const res = await this.#d.container.execInSandbox(["bash", "-c", `[ -d "$1" ] && cd "$1" && find . -maxdepth 3 -type f -size -5M -printf '%P (%s bytes)\\n' | head -40`, "kb-ls", dir], { timeoutMs: 20_000 });
      files = res.code === 0 ? res.stdout.trim() : "";
    } catch { /* no listing: the task's files can still be read by path */ }
    return [
      `### Packet ${p.id}: finished task ${t.id} "${t.title}" (created ${day(t.created_at)}, finished ${day(t.completed_at)})`,
      ...(earlier ? [`This task was read before (${day(earlier.processed_at)}) and has been continued since: record what is new.`] : []),
      ...(known.length ? [`Nodes already citing this task: ${known.map((k) => `${k.title} (${k.id})`).join("; ")}`] : []),
      `Request: ${clip(t.input_text, 3000)}`,
      ...merged.map((m) => `Follow-up (${day(m.created_at)}): ${clip(m.input_text, 1200)}`),
      `Result: ${clip(t.result, 6000)}`,
      `What it did (tool outputs clipped):\n${process || "(no steps recorded)"}`,
      `Files in tasks/${t.id}/: ${files ? `\n${files}` : "(none)"}`,
    ].join("\n");
  }

  #wikiCandidates(): string {
    const rows = this.#d.db.prepare("SELECT id, title, reads FROM kb_nodes WHERE owner_id=? AND status='active' AND wiki_md IS NULL AND wiki_draft IS NULL AND reads>=? ORDER BY reads DESC LIMIT 20").all(this.#owner, KB_LIMITS.wikiReads) as Array<{ id: string; title: string; reads: number }>;
    const ok = rows.filter((r) => !wikiIneligible(this.#d.db, this.#owner, r.id)).slice(0, 3);
    return ok.length ? `Wiki candidates (often read; write a wiki page for any that would help as a quick reference): ${ok.map((r) => `${r.title} (${r.id}, read ${r.reads} times)`).join("; ")}` : "No wiki candidates this time.";
  }

  async #ask(prompt: string, instructions = MAINTAINER_INSTRUCTIONS, servers?: Record<string, unknown>): Promise<string | null> {
    const res = await this.#d.codex.maintainKb!(prompt, instructions, {
      member: !!this.#d.cfg.memberRuntime,
      servers: servers ?? { ...taskKbThreadServers(this.#d.cfg), ...historyThreadServers(this.#d.cfg) },
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (res.error || res.timedOut) throw new Error(res.error ?? "the maintainer run timed out");
    return res.text;
  }

  async #process(packets: PacketRow[], material: string): Promise<number> {
    const { db } = this.#d;
    const ids = packets.map((p) => p.id);
    const domains = (db.prepare("SELECT name, description FROM kb_domains WHERE owner_id=? ORDER BY name").all(this.#owner) as Array<{ name: string; description: string }>).map((d) => `${d.name}: ${d.description}`).join("\n");
    const prompt = [`Domains:\n${domains}`, this.#wikiCandidates(), `Packets to handle (${ids.join(", ")}):`, material, `Now answer with the JSON change list, with a decision for each of ${ids.join(", ")}.`].join("\n\n");
    const kernel = { db, ownerId: this.#owner, workspaceDir: this.#d.cfg.sandbox.containerWorkspaceDir, readFile: sandboxKbFiles(this.#d.container), packets: ids };
    let answer: KbAnswer | null = null;
    let errors: string[] = [];
    let text: string | null = null;
    try {
      text = await this.#ask(prompt);
      answer = parseAnswer(text);
      if (!answer) errors = ["the answer was not a JSON object"];
      else { const r = await applyKbAnswer(kernel, answer); if (r.ok) return this.#settle(ids, r.changed); errors = r.errors; }
      // One more try with the reasons, as dispatch does.
      const again = await this.#ask(`${prompt}\n\nYour previous answer:\n${clip(text, 20_000)}\n\nIt was not accepted:\n${errors.slice(0, 30).map((e) => `- ${e}`).join("\n")}\nFix these (drop an item whose evidence you cannot quote exactly) and answer with the complete corrected JSON.`);
      answer = parseAnswer(again);
      if (answer) { const r = await applyKbAnswer(kernel, answer); if (r.ok) return this.#settle(ids, r.changed); errors = r.errors; }
      else errors = ["the corrected answer was not a JSON object"];
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    }
    this.#log.warn("knowledge batch not applied", { packets: ids, errors: errors.slice(0, 5) });
    const now = Date.now();
    for (const p of packets) {
      if (p.attempts + 1 >= ATTEMPTS) db.prepare("UPDATE kb_packets SET status='failed', attempts=attempts+1, note=?, processed_at=? WHERE id=?").run(clip(errors.join("; "), 300), now, p.id);
      else db.prepare("UPDATE kb_packets SET attempts=attempts+1 WHERE id=?").run(p.id);
    }
    return 0;
  }

  /** Packets the answer gave no decision count as accepted when it changed something, else as merged. */
  #settle(ids: string[], changed: number): number {
    const now = Date.now();
    for (const id of ids) this.#d.db.prepare("UPDATE kb_packets SET status=?, note=COALESCE(note,'no decision given'), processed_at=? WHERE id=? AND status='pending'").run(changed ? "accepted" : "merged", now, id);
    setMeta(this.#d.db, PROJECTION_DIRTY, "1");
    this.#log.info("knowledge batch applied", { packets: ids.length, changes: changed });
    return ids.length;
  }

  /** A wiki page is published only after another session checks it against its sources. */
  async #reviewWiki(): Promise<void> {
    const { db } = this.#d;
    const drafts = db.prepare("SELECT id, wiki_draft FROM kb_nodes WHERE owner_id=? AND wiki_draft IS NOT NULL LIMIT 3").all(this.#owner) as Array<{ id: string; wiki_draft: string }>;
    for (const d of drafts) {
      const node = getKbNode(db, this.#owner, d.id);
      let verdict: { pass?: unknown; problems?: unknown } | null = null;
      try {
        const text = await this.#ask(
          `Wiki draft for node ${d.id}:\n${d.wiki_draft}\n\nThe node with its claims and the recorded quotes of their sources:\n${JSON.stringify(node)}`,
          'You check a reference page before it is published to a personal knowledge base. Every statement in the draft must be supported by the node\'s claims and the quotes of their sources; nothing may be added, overstated, or stated as current when it is marked as changing. Answer with only JSON: {"pass": true|false, "problems": ["..."]}.',
          {},
        );
        verdict = text ? (parseAnswer(text) as { pass?: unknown; problems?: unknown } | null) : null;
      } catch (err) {
        this.#log.warn("wiki review failed", { node: d.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const now = Date.now();
      if (verdict?.pass === true) {
        db.prepare("UPDATE kb_nodes SET wiki_md=wiki_draft, wiki_draft=NULL, wiki_at=? WHERE id=?").run(now, d.id);
        db.prepare("INSERT INTO kb_revisions (owner_id, packets, object_id, op, detail_json, at) VALUES (?,?,?,?,?,?)").run(this.#owner, "", d.id, "wiki_published", "{}", now);
        setMeta(db, PROJECTION_DIRTY, "1");
      } else {
        db.prepare("UPDATE kb_nodes SET wiki_draft=NULL WHERE id=?").run(d.id);
        db.prepare("INSERT INTO kb_revisions (owner_id, packets, object_id, op, detail_json, at) VALUES (?,?,?,?,?,?)").run(this.#owner, "", d.id, "wiki_rejected", JSON.stringify({ problems: verdict?.problems ?? "no verdict" }), now);
      }
    }
  }

  /** Bring the sandbox's kb/ files up to date, only while it is awake. */
  async #project(): Promise<void> {
    if (getMeta(this.#d.db, PROJECTION_DIRTY) !== "1") return;
    const state = this.#d.idleState();
    if (state && state !== "running") return;
    try {
      await renderKbProjection({ db: this.#d.db, ownerId: this.#owner, workspaceDir: this.#d.cfg.sandbox.containerWorkspaceDir, container: this.#d.container });
      setMeta(this.#d.db, PROJECTION_DIRTY, "0");
    } catch (err) {
      this.#log.warn("knowledge files not written", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The person changed the knowledge base by hand: rewrite its files when the sandbox is next awake. */
  markChanged(): void {
    setMeta(this.#d.db, PROJECTION_DIRTY, "1");
    void this.#project();
  }
}

/** The JSON object in a model answer, with or without a code fence or words around it. */
export function parseAnswer(text: string | null): KbAnswer | null {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(body.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as KbAnswer) : null;
  } catch {
    return null;
  }
}
