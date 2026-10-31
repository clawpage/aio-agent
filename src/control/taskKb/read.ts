import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "../db.js";
import { randomId } from "../auth/passwords.js";
import { tokenize } from "../tasks/recall.js";
import { KB_PROPOSAL_TYPES, normalizeForMatch, sensitiveReason, taskCorpus, verifySource, type KbProposalType, type KbReadFile, type PreparedSource } from "./kernel.js";

/**
 * What every agent of the account may do with its personal knowledge base: look
 * things up, follow the graph, read the evidence, and hand the maintainer a
 * proposal. None of this changes knowledge; a proposal only waits in the mailbox,
 * and a correction flags its node at once so nobody trusts it blindly meanwhile.
 */

interface NodeRow { id: string; kind: string; domain: string; title: string; summary: string; status: string; superseded_by: string | null; wiki_md: string | null; reads: number; created_at: number; updated_at: number }
interface ClaimRow { id: string; node_id: string; text: string; certainty: string; volatility: string; verify_after: number | null; status: string; superseded_by: string | null; updated_at: number }
interface SourceRow { id: string; task_id: string; path: string | null; url: string | null; sha256: string | null; excerpt: string; captured_at: number; kind: string; contributor: string | null }

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export interface KbFlag { packet: string; type: string; text: string; task: string | null; at: string }

/** Corrections waiting for the maintainer, by the node they are about. */
export function pendingFlags(db: Db, ownerId: string, nodeIds: string[]): Map<string, KbFlag[]> {
  const out = new Map<string, KbFlag[]>();
  if (!nodeIds.length) return out;
  const rows = db.prepare(`SELECT id, type, target, task_id, payload_json, created_at FROM kb_packets
    WHERE owner_id=? AND kind='propose' AND status='pending' AND type IN ('correct','outdated','wrong') AND target IN (${nodeIds.map(() => "?").join(",")}) ORDER BY created_at`)
    .all(ownerId, ...nodeIds) as Array<{ id: string; type: string; target: string; task_id: string | null; payload_json: string; created_at: number }>;
  for (const r of rows) {
    const payload = JSON.parse(r.payload_json) as { text?: string; reason?: string };
    const list = out.get(r.target) ?? [];
    list.push({ packet: r.id, type: r.type, text: [payload.text, payload.reason].filter(Boolean).join(" — ").slice(0, 300), task: r.task_id, at: day(r.created_at) });
    out.set(r.target, list);
  }
  return out;
}

export interface KbHit { id: string; kind: string; domain: string; title: string; summary: string; claims: string[]; flagged: number; wiki: boolean; updated: string }

/** Nodes by relevance (BM25 over title, summary, domain and claims); the most recently changed without a query. */
export function searchKb(db: Db, ownerId: string, opts: { query?: string; domain?: string; kind?: string; limit?: number } = {}): KbHit[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 30);
  const filters = ["n.owner_id=?", "n.status='active'"];
  const args: string[] = [ownerId];
  if (opts.domain) { filters.push("n.domain=?"); args.push(opts.domain); }
  if (opts.kind) { filters.push("n.kind=?"); args.push(opts.kind); }
  const terms = [...new Set(tokenize((opts.query ?? "").slice(0, 2000)))].slice(0, 48);
  const rows = terms.length
    ? db.prepare(`SELECT n.*, -bm25(kb_search, 0, 0, 2.0, 1.0) AS score FROM kb_search JOIN kb_nodes n ON n.id=kb_search.node_id
        WHERE kb_search MATCH ? AND ${filters.join(" AND ")} ORDER BY score DESC LIMIT ?`).all(terms.map((t) => `"${t}"`).join(" OR "), ...args, limit) as unknown as NodeRow[]
    : db.prepare(`SELECT n.* FROM kb_nodes n WHERE ${filters.join(" AND ")} ORDER BY n.updated_at DESC LIMIT ?`).all(...args, limit) as unknown as NodeRow[];
  const flags = pendingFlags(db, ownerId, rows.map((r) => r.id));
  const termSet = new Set(terms);
  return rows.map((n) => {
    const claims = (db.prepare("SELECT text FROM kb_claims WHERE node_id=? AND status='active' ORDER BY updated_at DESC").all(n.id) as Array<{ text: string }>).map((c) => c.text);
    // The claims that share the most words with the query come first.
    const ranked = termSet.size ? claims.map((t) => ({ t, s: tokenize(t).filter((w) => termSet.has(w)).length })).sort((a, b) => b.s - a.s).map((x) => x.t) : claims;
    return { id: n.id, kind: n.kind, domain: n.domain, title: n.title, summary: n.summary, claims: ranked.slice(0, 3), flagged: flags.get(n.id)?.length ?? 0, wiki: !!n.wiki_md, updated: day(n.updated_at) };
  });
}

export interface KbNodeDetail {
  id: string; kind: string; domain: string; title: string; summary: string; status: string; supersededBy: string | null; updated: string; reads: number;
  claims: Array<{ id: string; text: string; certainty: string; volatility: string; recheck: boolean; status: string; supersededBy: string | null; sources: Array<{ id: string; task: string; path: string | null; url: string | null; excerpt: string; captured: string; kind: string; contributor: string | null }> }>;
  links: Array<{ rel: string; direction: "out" | "in"; node: string; title: string }>;
  pendingCorrections: KbFlag[];
  wiki: string | null;
}

/** One node in full; `read` counts it as used by a task (what decides the wiki). */
export function getKbNode(db: Db, ownerId: string, id: string, opts: { read?: boolean; history?: boolean } = {}): KbNodeDetail | null {
  const n = db.prepare("SELECT * FROM kb_nodes WHERE id=? AND owner_id=?").get(id, ownerId) as NodeRow | undefined;
  if (!n) return null;
  if (opts.read && n.status === "active") db.prepare("UPDATE kb_nodes SET reads=reads+1, last_read_at=? WHERE id=?").run(Date.now(), id);
  const claims = db.prepare(`SELECT * FROM kb_claims WHERE node_id=? ${opts.history ? "AND status<>'retired'" : "AND status='active'"} ORDER BY status='active' DESC, updated_at DESC`).all(id) as unknown as ClaimRow[];
  const sources = db.prepare("SELECT s.* FROM kb_sources s JOIN kb_cites c ON c.source_id=s.id WHERE c.item_id=? ORDER BY s.captured_at");
  const now = Date.now();
  const links = [
    ...(db.prepare("SELECT e.rel, e.dst AS node, n.title FROM kb_edges e JOIN kb_nodes n ON n.id=e.dst WHERE e.src=? AND n.status='active'").all(id) as Array<{ rel: string; node: string; title: string }>).map((l) => ({ ...l, direction: "out" as const })),
    ...(db.prepare("SELECT e.rel, e.src AS node, n.title FROM kb_edges e JOIN kb_nodes n ON n.id=e.src WHERE e.dst=? AND n.status='active'").all(id) as Array<{ rel: string; node: string; title: string }>).map((l) => ({ ...l, direction: "in" as const })),
  ];
  return {
    id: n.id, kind: n.kind, domain: n.domain, title: n.title, summary: n.summary, status: n.status, supersededBy: n.superseded_by, updated: day(n.updated_at), reads: n.reads + (opts.read ? 1 : 0),
    claims: claims.map((c) => ({
      id: c.id, text: c.text, certainty: c.certainty, volatility: c.volatility, recheck: c.volatility === "changes" || (c.verify_after !== null && c.verify_after <= now), status: c.status, supersededBy: c.superseded_by,
      sources: (sources.all(c.id) as unknown as SourceRow[]).map((s) => ({ id: s.id, task: s.task_id, path: s.path, url: s.url, excerpt: s.excerpt, captured: day(s.captured_at), kind: s.kind ?? "task", contributor: s.contributor ?? null })),
    })),
    links,
    pendingCorrections: pendingFlags(db, ownerId, [id]).get(id) ?? [],
    wiki: n.wiki_md,
  };
}

/** The nodes around one, up to two steps out. */
export function kbNeighbors(db: Db, ownerId: string, id: string, opts: { rel?: string; depth?: number } = {}): Array<{ id: string; title: string; kind: string; domain: string; summary: string; via: string; depth: number }> | null {
  if (!db.prepare("SELECT 1 FROM kb_nodes WHERE id=? AND owner_id=?").get(id, ownerId)) return null;
  const depth = Math.min(Math.max(Math.trunc(opts.depth ?? 1), 1), 2);
  const seen = new Set([id]);
  const out: Array<{ id: string; title: string; kind: string; domain: string; summary: string; via: string; depth: number }> = [];
  let frontier = [id];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const from of frontier) {
      const rows = db.prepare(`SELECT e.rel, CASE WHEN e.src=? THEN e.dst ELSE e.src END AS other, CASE WHEN e.src=? THEN 'out' ELSE 'in' END AS dir
        FROM kb_edges e WHERE (e.src=? OR e.dst=?) ${opts.rel ? "AND e.rel=?" : ""}`).all(from, from, from, from, ...(opts.rel ? [opts.rel] : [])) as Array<{ rel: string; other: string; dir: string }>;
      for (const r of rows) {
        if (seen.has(r.other)) continue;
        const n = db.prepare("SELECT id, title, kind, domain, summary FROM kb_nodes WHERE id=? AND status='active'").get(r.other) as { id: string; title: string; kind: string; domain: string; summary: string } | undefined;
        if (!n) continue;
        seen.add(n.id);
        next.push(n.id);
        out.push({ ...n, via: `${r.dir === "out" ? "" : "← "}${r.rel}`, depth: d });
        if (out.length >= 40) return out;
      }
    }
    frontier = next;
  }
  return out;
}

/** The evidence behind a claim: the file as it is now when it still holds the quote, else what was kept when it was recorded. */
export async function kbSourceText(db: Db, ownerId: string, id: string, readFile: KbReadFile, workspaceDir: string): Promise<Record<string, unknown> | null> {
  const s = db.prepare("SELECT * FROM kb_sources WHERE id=? AND owner_id=?").get(id, ownerId) as SourceRow | undefined;
  if (!s) return null;
  const base = { source: s.id, task: s.task_id, captured: day(s.captured_at), quote: s.excerpt, ...(s.url ? { url: s.url, note: "Web pages change: open the address again when the current state matters." } : {}) };
  const window = (text: string) => {
    const at = normalizeForMatch(text).indexOf(normalizeForMatch(s.excerpt));
    // Whitespace collapses in the normalised text, so the position is approximate; a wide window covers it.
    const start = Math.max(0, at - 1500);
    return at < 0 ? null : text.slice(start, start + 3000 + s.excerpt.length);
  };
  if (s.path) {
    let file: { text: string; sha256: string } | null = null;
    try { file = await readFile(path.posix.join(workspaceDir, s.path)); } catch { return { ...base, path: s.path, state: "unreachable", note: "The sandbox is not reachable right now; the quote above is what was recorded." }; }
    if (!file) return { ...base, path: s.path, state: "missing", note: "The file has been deleted since; only the recorded quote remains." };
    const around = window(file.text);
    if (file.sha256 === s.sha256) return { ...base, path: s.path, state: "current", context: around ?? file.text.slice(0, 3000) };
    return around
      ? { ...base, path: s.path, state: "changed", note: "The file changed since it was recorded but still contains the quote.", context: around }
      : { ...base, path: s.path, state: "changed", note: "The file changed since it was recorded and no longer contains the quote; treat the claim as possibly outdated." };
  }
  const corpus = taskCorpus(db, ownerId, s.task_id);
  if (!corpus) return { ...base, state: "missing", note: "The task no longer exists; only the recorded quote remains." };
  const around = window(corpus);
  return { ...base, state: around ? "current" : "missing", ...(around ? { context: around } : { note: "The task no longer contains the quote; only the recorded quote remains." }), more: `Read task ${s.task_id} with history_get for its full record.` };
}

/**
 * The few nodes an execution session starts with: the best matches for the
 * person's message, each with its gist and its neighbours' titles, within a
 * small budget. `version` changes only when the block does.
 */
export function kbBrief(db: Db, ownerId: string, query: string, budget = 800): { text: string; version: string; nodes: string[] } | null {
  const hits = query.trim() ? searchKb(db, ownerId, { query, limit: 5 }) : [];
  if (!hits.length) return null;
  const best = hits[0]!;
  const lines: string[] = [];
  const nodes: string[] = [];
  let used = 0;
  for (const h of hits) {
    // Weak matches stay behind a clear one, as in recall.
    if (h !== best && !h.claims.length && !h.summary) continue;
    const near = (kbNeighbors(db, ownerId, h.id) ?? []).slice(0, 3).map((n) => n.title);
    const line = `- ${h.title} (${h.id}, ${h.domain}/${h.kind}${h.flagged ? `, ${h.flagged} correction(s) pending: do not rely on it without checking` : ""}): ${h.summary || h.claims[0] || ""}${near.length ? ` · related: ${near.join(", ")}` : ""}`;
    if (used + line.length > budget) break;
    lines.push(line);
    nodes.push(h.id);
    used += line.length;
  }
  if (!lines.length) return null;
  const text = lines.join("\n");
  return { text, version: createHash("sha256").update(text).digest("hex").slice(0, 8), nodes };
}

export const KB_PROPOSALS_PER_TASK = 12;

export interface CheckedProposal { type: KbProposalType; task: string; text: string; reason: string; evidence: PreparedSource[] }

/** What every proposal must hold, wherever it goes: a known type, this task, words, and evidence found in this task. */
export async function checkProposal(
  deps: { db: Db; ownerId: string; workspaceDir: string; readFile: KbReadFile },
  input: { type?: unknown; task?: unknown; text?: unknown; reason?: unknown; evidence?: unknown },
): Promise<CheckedProposal | { error: string }> {
  const { db, ownerId } = deps;
  const type = String(input.type ?? "") as KbProposalType;
  if (!KB_PROPOSAL_TYPES.includes(type)) return { error: `type must be one of ${KB_PROPOSAL_TYPES.join(", ")}` };
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task || taskCorpus(db, ownerId, task) === null) return { error: "task must be the current task ID (given at the start of the task)" };
  const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  const text = clip(input.text, 600);
  const reason = clip(input.reason, 300);
  if (!text) return { error: "text must say what to add or what is now true" };
  const sensitive = sensitiveReason(`${text} ${reason}`);
  if (sensitive) return { error: `the proposal ${sensitive}; credentials and identity numbers are never recorded` };
  const errors: string[] = [];
  const evidence: PreparedSource[] = [];
  const items = Array.isArray(input.evidence) ? input.evidence.slice(0, 5) : [];
  if (!items.length) return { error: "evidence needs at least one item: { quote, and path (a file in this task's directory) or url (a page this task opened), or neither for the user's own words in this task }" };
  const corpus = (t: string) => taskCorpus(db, ownerId, t);
  for (let i = 0; i < items.length; i++) {
    const s = await verifySource({ ...deps, corpus }, `evidence[${i}]`, { ...(items[i] as object), task }, errors);
    if (s) evidence.push(s);
  }
  if (errors.length) return { error: errors.join("; ") };
  return { type, task, text, reason, evidence };
}

/** A proposal from an agent at work: checked like any evidence, then left for the maintainer. */
export async function proposeKb(
  deps: { db: Db; ownerId: string; workspaceDir: string; readFile: KbReadFile },
  input: { type?: unknown; task?: unknown; target?: unknown; text?: unknown; reason?: unknown; evidence?: unknown },
): Promise<{ id: string; target: string | null } | { error: string }> {
  const { db, ownerId } = deps;
  let target: string | null = null;
  const raw = typeof input.target === "string" ? input.target.trim() : "";
  if (raw) {
    const node = db.prepare("SELECT id FROM kb_nodes WHERE id=? AND owner_id=?").get(raw, ownerId) as { id: string } | undefined;
    const claim = node ? undefined : db.prepare("SELECT c.node_id FROM kb_claims c JOIN kb_nodes n ON n.id=c.node_id WHERE c.id=? AND n.owner_id=?").get(raw, ownerId) as { node_id: string } | undefined;
    target = node?.id ?? claim?.node_id ?? null;
    if (!target) return { error: `target ${raw} is not a node or claim of this knowledge base` };
  }
  const checked = await checkProposal(deps, input);
  if ("error" in checked) return checked;
  const { type, task, text, reason, evidence } = checked;
  if (type !== "add" && !target) return { error: `a ${type} proposal needs target: the node or claim it is about` };
  const sent = (db.prepare("SELECT count(*) AS n FROM kb_packets WHERE owner_id=? AND kind='propose' AND task_id=?").get(ownerId, task) as { n: number }).n;
  if (sent >= KB_PROPOSALS_PER_TASK) return { error: `this task already sent ${KB_PROPOSALS_PER_TASK} proposals; the maintainer reads the task when it ends, so only send what its record will not show` };
  // The same task saying the same thing about the same node again is one proposal.
  const same = db.prepare("SELECT id FROM kb_packets WHERE owner_id=? AND kind='propose' AND task_id=? AND status='pending' AND type=? AND COALESCE(target,'')=? AND json_extract(payload_json,'$.text')=?")
    .get(ownerId, task, type, target ?? "", text) as { id: string } | undefined;
  if (same) return { id: same.id, target };
  const id = randomId("kbp");
  db.prepare("INSERT INTO kb_packets (id, owner_id, kind, type, task_id, target, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, ownerId, "propose", type, task, target, JSON.stringify({ text, reason, evidence }), Date.now());
  return { id, target };
}

export function proposalStatus(db: Db, ownerId: string, id: string): { status: string; note: string | null } | null {
  return (db.prepare("SELECT status, note FROM kb_packets WHERE id=? AND owner_id=? AND kind='propose'").get(id, ownerId) as { status: string; note: string | null } | undefined) ?? null;
}

/** The person's own view: domains with their nodes, newest first. */
export function listKb(db: Db, ownerId: string): { domains: Array<{ name: string; description: string; nodes: number }>; nodes: Array<{ id: string; kind: string; domain: string; title: string; summary: string; claims: number; wiki: boolean; flagged: number; updated: string }>; pending: number } {
  const domains = db.prepare(`SELECT d.name, d.description, (SELECT count(*) FROM kb_nodes n WHERE n.owner_id=d.owner_id AND n.domain=d.name AND n.status='active') AS nodes
    FROM kb_domains d WHERE d.owner_id=? ORDER BY nodes DESC, d.name`).all(ownerId) as Array<{ name: string; description: string; nodes: number }>;
  const rows = db.prepare(`SELECT n.id, n.kind, n.domain, n.title, n.summary, n.wiki_md IS NOT NULL AS wiki, n.updated_at,
    (SELECT count(*) FROM kb_claims c WHERE c.node_id=n.id AND c.status='active') AS claims FROM kb_nodes n WHERE n.owner_id=? AND n.status='active' ORDER BY n.updated_at DESC LIMIT 2000`)
    .all(ownerId) as Array<{ id: string; kind: string; domain: string; title: string; summary: string; wiki: number; updated_at: number; claims: number }>;
  const flags = pendingFlags(db, ownerId, rows.map((r) => r.id));
  const pending = (db.prepare("SELECT count(*) AS n FROM kb_packets WHERE owner_id=? AND status='pending'").get(ownerId) as { n: number }).n;
  return { domains, nodes: rows.map((r) => ({ id: r.id, kind: r.kind, domain: r.domain, title: r.title, summary: r.summary, claims: r.claims, wiki: !!r.wiki, flagged: flags.get(r.id)?.length ?? 0, updated: day(r.updated_at) })), pending };
}

const DISABLED_KEY = "task_kb.disabled";
/** The person can turn the knowledge base off: nothing new is read into it and nothing from it is handed to tasks. */
export function kbEnabled(db: Db): boolean {
  return (db.prepare("SELECT value FROM meta WHERE key=?").get(DISABLED_KEY) as { value: string } | undefined)?.value !== "1";
}
export function setKbEnabled(db: Db, enabled: boolean): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(DISABLED_KEY, enabled ? "0" : "1");
}
