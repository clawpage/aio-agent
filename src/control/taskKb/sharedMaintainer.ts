import type { Logger } from "../../common/logger.js";
import { applyKbAnswer, KB_CERTAINTIES, KB_KINDS, KB_LIMITS, KB_RELS, normalizeForMatch, type KbAnswer, type PreparedSource } from "./kernel.js";
import { getKbNode, searchKb } from "./read.js";
import { parseAnswer } from "./maintainer.js";
import type { LibraryPacket, SharedKbs } from "./shared.js";

/**
 * The maintainer of a shared library (docs/SHARED-KB.md §3.3): the second judgement. It
 * needs no sandbox: what it reads (the library's rules, its nearest nodes, the packets
 * with their already-checked quotes) is put together here, and one model call answers
 * with a change list the kernel checks. A batch holds one contributor's packets, and
 * its use is counted to that contributor.
 */

const BATCH_PACKETS = 10;
const ATTEMPTS = 3;
const URGENT_MS = 60_000;
const NORMAL_MS = 2 * 60_000;
const NEXT_BATCH_MS = 5_000;
const RETRY_MS = 5 * 60_000;
const PRIORITY: Record<string, number> = { wrong: 0, correct: 1, outdated: 2, add: 3 };

interface PacketRow { id: string; type: string | null; target: string | null; payload_json: string; attempts: number; created_at: number }

const clip = (s: unknown, n: number) => { const c = [...String(s ?? "").replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };

export const SHARED_MAINTAINER_INSTRUCTIONS = `You are the knowledge maintainer of a shared knowledge base inside Clawpage Agent, kept by several people together (a family, a project, a team). Members' own knowledge maintainers pass on what they judged worth sharing, and members' agents send proposals; you decide what this library keeps, by its rules, and answer with one JSON change list that the control plane checks and writes. You cannot write any other way.

Follow the library's rules: keep only what they say to keep, and reject what they exclude, saying why. When the rules are empty, keep what all members would find useful and nothing private to one person. Keep it small and reusable. Never record passwords, codes, identity, card or account numbers (they are refused).

The existing nodes most related to this batch are listed with their ids and claims: add to a node about the same thing instead of creating another; use merge when two existing nodes are the same thing; when a new claim contradicts an existing one, write it with replaces (if it is now true) or link the nodes with contradicts (if both may hold), never silently drop the old one. A correction proposal's evidence is real but its conclusion is the proposer's: check it against the node before accepting.

Certainty: user_said = a member said it; observed = seen in a page, file or tool output; inferred = a conclusion. Volatility: changes = prices, opening hours, availability, schedules (give verify_after_days); stable otherwise.

Every claim needs sources: {"packet": "<packet id>", "quote": "<words copied verbatim from that packet's quotes, 4-600 characters>"}. Only the quotes listed under a packet can be cited.

Answer with only this JSON (no prose, no code fence):
{"decisions":[{"packet":"<packet id>","status":"accepted|merged|rejected","note":"<short reason>"}],
 "ops":[
  {"op":"domain","name":"<new english-slug>","description":"..."},
  {"op":"node","ref":"<new short id, e.g. n1>","kind":"${KB_KINDS.join("|")}","domain":"<domain>","title":"<at most ${KB_LIMITS.title} chars>","summary":"<one sentence, at most ${KB_LIMITS.summary} chars>"},
  {"op":"update_node","id":"<node id>","title":"...","summary":"...","domain":"..."},
  {"op":"claim","node":"<node id or ref>","text":"<one statement, at most ${KB_LIMITS.claim} chars>","certainty":"${KB_CERTAINTIES.join("|")}","volatility":"stable|changes","verify_after_days":30,"replaces":"<claim id, optional>","sources":[...]},
  {"op":"link","src":"<node id or ref>","dst":"<node id or ref>","rel":"${KB_RELS.join("|")}","sources":[...optional]},
  {"op":"merge","from":"<node id>","into":"<node id or ref>"},
  {"op":"retire","id":"<node or claim id>","reason":"..."}
 ]}
Give every packet a decision: accepted (recorded), merged (already there), rejected (outside the rules, not worth keeping, or the evidence does not hold; say why). Every new node needs at least one claim. Write in the language the members use.`;

export interface SharedMaintainerDeps {
  kbs: SharedKbs;
  log: Logger;
  /** One model answer for `userId`'s account (counted in its usage). */
  ask: (userId: string, instructions: string, prompt: string) => Promise<string>;
}

export class SharedKbMaintainer {
  #d: SharedMaintainerDeps;
  #log: Logger;
  #timers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  #running = new Set<string>();
  #stopped = false;

  constructor(deps: SharedMaintainerDeps) {
    this.#d = deps;
    this.#log = deps.log.child("shared-kb-maintainer");
  }

  /** Look at every library with packets waiting (after a restart). */
  start(db: { prepare(sql: string): { all(): unknown[] } }): void {
    for (const { id } of db.prepare("SELECT id FROM kb_libraries").all() as Array<{ id: string }>) {
      try { if (this.#pending(id).length) this.nudge(id, false); } catch (err) { this.#log.warn("shared library not checked", { library: id, error: String(err) }); }
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const { timer } of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  nudge(library: string, urgent: boolean): void {
    const many = this.#pending(library).length >= BATCH_PACKETS;
    this.#schedule(library, urgent || many ? URGENT_MS : NORMAL_MS);
  }

  #schedule(library: string, ms: number): void {
    if (this.#stopped) return;
    const due = Date.now() + ms;
    const current = this.#timers.get(library);
    if (current && current.due <= due) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => { this.#timers.delete(library); void this.run(library); }, ms);
    timer.unref?.();
    this.#timers.set(library, { timer, due });
  }

  #pending(library: string): PacketRow[] {
    if (!this.#d.kbs.library(library)) return [];
    const rows = this.#d.kbs.db(library).prepare("SELECT id, type, target, payload_json, attempts, created_at FROM kb_packets WHERE owner_id=? AND status='pending' ORDER BY created_at").all(library) as unknown as PacketRow[];
    return rows.sort((a, b) => (PRIORITY[a.type ?? ""] ?? 9) - (PRIORITY[b.type ?? ""] ?? 9) || a.created_at - b.created_at);
  }

  /** One batch for one library; returns how many packets it settled. */
  async run(library: string): Promise<number> {
    if (this.#running.has(library) || this.#stopped) return 0;
    const { kbs } = this.#d;
    const pending = this.#pending(library);
    if (!pending.length) return 0;
    this.#running.add(library);
    let settled = 0;
    try {
      const db = kbs.db(library);
      // One contributor per batch: its use is counted to them.
      const from = (JSON.parse(pending[0]!.payload_json) as LibraryPacket).from;
      const packets = pending.filter((p) => (JSON.parse(p.payload_json) as LibraryPacket).from === from).slice(0, BATCH_PACKETS);
      if (!kbs.isMember(library, from)) {
        // Someone who left: what they had not shared yet is not shared.
        for (const p of packets) db.prepare("UPDATE kb_packets SET status='rejected', note=?, processed_at=? WHERE id=?").run("the contributor left the library", Date.now(), p.id);
        settled = packets.length;
      } else {
        settled = await this.#process(library, from, packets);
      }
    } catch (err) {
      this.#log.warn("shared maintainer run failed", { library, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.#running.delete(library);
    }
    if (this.#pending(library).length) this.#schedule(library, settled ? NEXT_BATCH_MS : RETRY_MS);
    return settled;
  }

  async #process(library: string, from: string, rows: PacketRow[]): Promise<number> {
    const { kbs } = this.#d;
    const db = kbs.db(library);
    const packets = new Map(rows.map((r) => [r.id, JSON.parse(r.payload_json) as LibraryPacket]));
    const ids = rows.map((r) => r.id);
    const who = kbs.usernameOf(from);
    const material = rows.map((r) => {
      const p = packets.get(r.id)!;
      const node = r.target ? getKbNode(db, library, r.target) : null;
      return [
        `### Packet ${r.id}: ${r.type === "add" ? (p.title ? `shared by ${who}'s maintainer` : `proposed by ${who}'s agent`) : `a ${r.type} proposal from ${who}'s agent`}`,
        ...(p.title ? [`Subject: ${p.title}`] : []),
        `Statement: ${p.text}${p.reason ? `\nReason: ${p.reason}` : ""}`,
        "Quotes (cite these exactly):",
        ...p.evidence.map((e) => `- ${JSON.stringify(e.excerpt)}${e.url ? ` · from ${e.url}` : ""}`),
        ...(node ? ["The node it is about, as it is now:", JSON.stringify({ id: node.id, title: node.title, summary: node.summary, claims: node.claims.map((c) => ({ id: c.id, text: c.text, certainty: c.certainty })) })] : []),
      ].join("\n");
    }).join("\n\n");
    const seen = new Set<string>();
    const related: string[] = [];
    for (const p of packets.values()) {
      for (const hit of searchKb(db, library, { query: `${p.title ?? ""}\n${p.text}`, limit: 6 })) {
        if (seen.has(hit.id) || seen.size >= 20) continue;
        seen.add(hit.id);
        const node = getKbNode(db, library, hit.id)!;
        related.push(JSON.stringify({ id: node.id, kind: node.kind, domain: node.domain, title: node.title, summary: node.summary, claims: node.claims.map((c) => ({ id: c.id, text: c.text })) }));
      }
    }
    const domains = (db.prepare("SELECT name, description FROM kb_domains WHERE owner_id=? ORDER BY name").all(library) as Array<{ name: string; description: string }>).map((d) => `${d.name}: ${d.description}`).join("\n");
    const lib = kbs.library(library)!;
    const rules = kbs.rules(library).text;
    const prompt = [
      `Library: ${lib.name} (members: ${kbs.members(library).map((m) => m.username).join(", ")})`,
      `Its rules:\n${rules || "(none written)"}`,
      `Domains:\n${domains}`,
      related.length ? `Existing nodes related to this batch:\n${related.join("\n")}` : "Existing nodes related to this batch: none yet.",
      `Packets to handle (${ids.join(", ")}):`,
      material,
      `Now answer with the JSON change list, with a decision for each of ${ids.join(", ")}.`,
    ].join("\n\n");

    const verify = async (where: string, input: unknown, errors: string[]): Promise<PreparedSource | null> => {
      const s = (input ?? {}) as { packet?: unknown; quote?: unknown };
      const pid = typeof s.packet === "string" ? s.packet.trim() : "";
      const p = packets.get(pid);
      if (!p) { errors.push(`${where}.packet must be one of this batch's packets`); return null; }
      const quote = typeof s.quote === "string" ? s.quote.replace(/\s+/g, " ").trim() : "";
      if ([...quote].length < 4 || [...quote].length > KB_LIMITS.quote) { errors.push(`${where}.quote must be 4 to ${KB_LIMITS.quote} characters copied from the packet's quotes`); return null; }
      const ev = p.evidence.find((e) => normalizeForMatch(e.excerpt).includes(normalizeForMatch(quote)));
      if (!ev) { errors.push(`${where}.quote does not appear in the quotes of packet ${pid}; copy the words exactly`); return null; }
      return { task: ev.task, path: ev.path, url: ev.url, sha256: ev.sha256, excerpt: quote, kind: ev.url ? "url" : "task", contributor: from };
    };
    const kernel = { db, ownerId: library, workspaceDir: "/", readFile: async () => null, packets: ids, noWiki: true, verify,
      change: { by: from, kind: "maintainer" as const, summary: rows.map((r) => clip(packets.get(r.id)!.title ?? packets.get(r.id)!.text, 40)).join("; ") } };

    let errors: string[] = [];
    let text: string | null = null;
    try {
      text = await this.#d.ask(from, SHARED_MAINTAINER_INSTRUCTIONS, prompt);
      let answer: KbAnswer | null = parseAnswer(text);
      if (answer) { const r = await applyKbAnswer(kernel, answer); if (r.ok) return this.#settle(library, ids, r.changed); errors = r.errors; }
      else errors = ["the answer was not a JSON object"];
      const again = await this.#d.ask(from, SHARED_MAINTAINER_INSTRUCTIONS, `${prompt}\n\nYour previous answer:\n${clip(text, 20_000)}\n\nIt was not accepted:\n${errors.slice(0, 30).map((e) => `- ${e}`).join("\n")}\nFix these (drop an item whose quote you cannot copy exactly) and answer with the complete corrected JSON.`);
      answer = parseAnswer(again);
      if (answer) { const r = await applyKbAnswer(kernel, answer); if (r.ok) return this.#settle(library, ids, r.changed); errors = r.errors; }
      else errors = ["the corrected answer was not a JSON object"];
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    }
    this.#log.warn("shared knowledge batch not applied", { library, packets: ids, errors: errors.slice(0, 5) });
    const now = Date.now();
    for (const r of rows) {
      if (r.attempts + 1 >= ATTEMPTS) db.prepare("UPDATE kb_packets SET status='failed', attempts=attempts+1, note=?, processed_at=? WHERE id=?").run(clip(errors.join("; "), 300), now, r.id);
      else db.prepare("UPDATE kb_packets SET attempts=attempts+1 WHERE id=?").run(r.id);
    }
    return 0;
  }

  #settle(library: string, ids: string[], changed: number): number {
    const now = Date.now();
    const db = this.#d.kbs.db(library);
    for (const id of ids) db.prepare("UPDATE kb_packets SET status=?, note=COALESCE(note,'no decision given'), processed_at=? WHERE id=? AND status='pending'").run(changed ? "accepted" : "merged", now, id);
    this.#log.info("shared knowledge batch applied", { library, packets: ids.length, changes: changed });
    return ids.length;
  }
}
