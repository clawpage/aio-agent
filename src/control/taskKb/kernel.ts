import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "../db.js";
import { randomId } from "../auth/passwords.js";
import { tokenize } from "../tasks/recall.js";

/**
 * The write kernel of the account's personal knowledge base (docs/TASK-KB.md).
 *
 * Nothing else writes the kb_* tables: the knowledge maintainer answers with a
 * change list, and this module checks every item before any of it lands, in one
 * transaction. What the model cannot be trusted with is decided here, not in the
 * prompt: a source must be a task of this account, a cited file must sit in that
 * task's directory, the quoted words must actually appear in the file or the task,
 * the fingerprint is computed here, and credentials are refused outright.
 */

export const KB_KINDS = ["entity", "topic", "procedure", "fact"] as const;
export const KB_CERTAINTIES = ["user_said", "observed", "inferred"] as const;
export const KB_VOLATILITIES = ["stable", "changes"] as const;
export const KB_RELS = ["about", "part_of", "uses", "related_to", "supersedes", "contradicts"] as const;
export const KB_PROPOSAL_TYPES = ["add", "correct", "outdated", "wrong"] as const;
export type KbProposalType = (typeof KB_PROPOSAL_TYPES)[number];

/** The domains every account starts with; the maintainer adds others (an English slug with a description). */
export const KB_DEFAULT_DOMAINS: Record<string, string> = {
  family: "Family members, relationships and family arrangements",
  health: "Health, medical care, medicines and doctors",
  shopping: "Products, stores, orders, returns and prices",
  travel: "Trips, flights, hotels, transport and places",
  finance: "Money, banks, taxes, insurance and bills",
  work: "Work, projects and colleagues",
  tech: "Software, devices, setup and troubleshooting",
  accounts: "Websites, apps and how to use them (sign-in steps, quirks), never credentials",
  home: "Home, household, services and maintenance",
  food: "Food, recipes, restaurants and diet",
  learning: "Courses, school, reading and research",
  other: "Anything that fits no other domain",
};

export const KB_LIMITS = {
  title: 80,
  summary: 300,
  claim: 400,
  quote: 600,
  wiki: 6000,
  ops: 60,
  wikiPages: 50,
  /** A node reaches the wiki only after this many reads by tasks. */
  wikiReads: 3,
} as const;

export interface KbSourceInput { task?: unknown; path?: unknown; url?: unknown; quote?: unknown }
export interface KbAnswer { decisions?: unknown; ops?: unknown }

/** A file in the account's sandbox: its text and fingerprint, or null when it does not exist. */
export type KbReadFile = (absolutePath: string) => Promise<{ text: string; sha256: string } | null>;

export interface KbKernelDeps {
  db: Db;
  ownerId: string;
  /** The sandbox's workspace directory, under which `tasks/<id>/` holds each task's files. */
  workspaceDir: string;
  readFile: KbReadFile;
  /** The packets this answer handles; decisions may name only these. */
  packets: string[];
  now?: number;
}

export interface KbApplyResult { ok: boolean; errors: string[]; changed: number; nodes: string[] }

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const chars = (s: string) => [...s].length;
/** Whitespace and case do not decide whether a quote is in a text. */
export const normalizeForMatch = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Credentials and identity numbers never enter the knowledge base (the vault is for those). */
export function sensitiveReason(text: string): string | null {
  if (/(?<!\d)\d{17}[\dXx](?!\d)/.test(text)) return "looks like an identity card number";
  if (/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/.test(text)) return "looks like a social security number";
  for (const m of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "looks like a payment card number";
  }
  if (/(password|passcode|passwd|pin code|验证码|密码|口令)\s*(?:is|=|:|：|是|为)\s*\S{3,}/i.test(text)) return "contains a password or code";
  return null;
}

/** Everything a task holds as text: the request and its supplements, the result, and what its turns saw and said. */
export function taskCorpus(db: Db, ownerId: string, taskId: string): string | null {
  const row = db.prepare("SELECT t.id, t.input_text, t.result, t.turn_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.owner_id=?").get(taskId, ownerId) as
    { id: string; input_text: string; result: string | null; turn_id: string | null } | undefined;
  if (!row) return null;
  const merged = db.prepare("SELECT input_text, turn_id FROM tasks WHERE merged_into=?").all(taskId) as Array<{ input_text: string; turn_id: string | null }>;
  const parts = [row.input_text, row.result ?? "", ...merged.map((m) => m.input_text)];
  const turns = [...new Set([row.turn_id, ...merged.map((m) => m.turn_id)].filter((t): t is string => !!t))];
  const events = db.prepare("SELECT payload FROM events WHERE turn_id=? AND type='item/completed' ORDER BY id");
  const collect = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  for (const turn of turns) for (const { payload } of events.all(turn) as Array<{ payload: string }>) {
    try { collect(JSON.parse(payload)); } catch { /* a malformed event holds nothing to cite */ }
  }
  return parts.join("\n");
}

export interface PreparedSource { task: string; path: string | null; url: string | null; sha256: string | null; excerpt: string }
type Ref = { kind: "new"; ref: string } | { kind: "existing"; id: string };
type PreparedOp =
  | { op: "domain"; name: string; description: string }
  | { op: "node"; ref: string; kind: string; domain: string; title: string; summary: string }
  | { op: "update_node"; id: string; title?: string; summary?: string; domain?: string }
  | { op: "claim"; node: Ref; text: string; certainty: string; volatility: string; verifyAfter: number | null; replaces: string | null; sources: PreparedSource[] }
  | { op: "link"; src: Ref; dst: Ref; rel: string; sources: PreparedSource[] }
  | { op: "merge"; from: string; into: Ref }
  | { op: "retire"; id: string; reason: string }
  | { op: "wiki"; node: string; markdown: string };

/** Check one piece of evidence: a task of this account, and words that really are in it (or in a file of its directory). */
export async function verifySource(deps: Pick<KbKernelDeps, "workspaceDir" | "readFile"> & { corpus: (task: string) => string | null }, where: string, input: unknown, errors: string[]): Promise<PreparedSource | null> {
  const s = (input ?? {}) as KbSourceInput;
  const task = clean(s.task);
  const quote = clean(s.quote);
  if (!task) { errors.push(`${where}.task is required (the task the evidence comes from)`); return null; }
  const body = deps.corpus(task);
  if (body === null) { errors.push(`${where}: task ${task} does not exist in this account`); return null; }
  if (chars(quote) < 4 || chars(quote) > KB_LIMITS.quote) { errors.push(`${where}.quote must be the exact words relied on, 4 to ${KB_LIMITS.quote} characters`); return null; }
  const sensitive = sensitiveReason(quote);
  if (sensitive) { errors.push(`${where}.quote ${sensitive}`); return null; }
  const wanted = normalizeForMatch(quote);
  if (s.path !== undefined && s.path !== null && s.path !== "") {
    const rel = clean(s.path).replace(/^\/+/, "");
    const relative = rel.startsWith(deps.workspaceDir.replace(/^\/+/, "") + "/") ? rel.slice(deps.workspaceDir.replace(/^\/+/, "").length + 1) : rel;
    const normal = path.posix.normalize(relative);
    if (!normal.startsWith(`tasks/${task}/`) || normal.includes("..")) { errors.push(`${where}.path must be a file in tasks/${task}/ (the task's own directory)`); return null; }
    let file;
    try { file = await deps.readFile(path.posix.join(deps.workspaceDir, normal)); } catch (err) { errors.push(`${where}: could not read ${normal} (${err instanceof Error ? err.message : String(err)})`); return null; }
    if (!file) { errors.push(`${where}: ${normal} does not exist`); return null; }
    if (!normalizeForMatch(file.text).includes(wanted)) { errors.push(`${where}.quote does not appear in ${normal}; copy the words exactly as they are in the file`); return null; }
    return { task, path: normal, url: null, sha256: file.sha256, excerpt: quote };
  }
  const haystack = normalizeForMatch(body);
  if (!haystack.includes(wanted)) { errors.push(`${where}.quote does not appear in task ${task} (its messages, result or what it saw); copy the words exactly`); return null; }
  if (s.url !== undefined && s.url !== null && s.url !== "") {
    const url = clean(s.url);
    if (!/^https?:\/\/\S+$/.test(url)) { errors.push(`${where}.url must be an http(s) address`); return null; }
    if (!body.includes(url)) { errors.push(`${where}.url was not visited or mentioned in task ${task}`); return null; }
    return { task, path: null, url, sha256: null, excerpt: quote };
  }
  return { task, path: null, url: null, sha256: null, excerpt: quote };
}

/** Check a change list and, only if every item holds, write all of it. */
export async function applyKbAnswer(deps: KbKernelDeps, answer: KbAnswer): Promise<KbApplyResult> {
  const { db, ownerId } = deps;
  const now = deps.now ?? Date.now();
  ensureDomains(db, ownerId, now);
  const errors: string[] = [];
  const ops = Array.isArray(answer.ops) ? answer.ops : [];
  const decisions = Array.isArray(answer.decisions) ? answer.decisions : [];
  if (!Array.isArray(answer.ops) && !Array.isArray(answer.decisions)) return { ok: false, errors: ["the answer needs an ops array and a decisions array"], changed: 0, nodes: [] };
  if (ops.length > KB_LIMITS.ops) errors.push(`at most ${KB_LIMITS.ops} ops per answer; keep only what is worth remembering`);

  const domains = new Set((db.prepare("SELECT name FROM kb_domains WHERE owner_id=?").all(ownerId) as Array<{ name: string }>).map((d) => d.name));
  const refs = new Set<string>();
  const nodeOf = (id: string) => db.prepare("SELECT id, status FROM kb_nodes WHERE id=? AND owner_id=?").get(id, ownerId) as { id: string; status: string } | undefined;
  const claimOf = (id: string) => db.prepare("SELECT c.id, c.status FROM kb_claims c JOIN kb_nodes n ON n.id=c.node_id WHERE c.id=? AND n.owner_id=?").get(id, ownerId) as { id: string; status: string } | undefined;
  const corpora = new Map<string, string | null>();
  const corpus = (task: string) => { if (!corpora.has(task)) corpora.set(task, taskCorpus(db, ownerId, task)); return corpora.get(task)!; };

  const text = (where: string, value: unknown, max: number, required = true): string | null => {
    const v = clean(value);
    if (!v) { if (required) errors.push(`${where} is required`); return required ? null : ""; }
    if (chars(v) > max) { errors.push(`${where} is at most ${max} characters`); return null; }
    const sensitive = sensitiveReason(v);
    if (sensitive) { errors.push(`${where} ${sensitive}; credentials and identity numbers are never recorded`); return null; }
    return v;
  };
  const ref = (where: string, value: unknown): Ref | null => {
    const v = clean(value);
    if (refs.has(v)) return { kind: "new", ref: v };
    const node = v ? nodeOf(v) : undefined;
    if (!node) { errors.push(`${where}: ${v || "(empty)"} is neither a ref created earlier in this answer nor an existing node`); return null; }
    if (node.status !== "active") { errors.push(`${where}: node ${v} is ${node.status}; use the node that replaced it`); return null; }
    return { kind: "existing", id: v };
  };
  const source = (where: string, input: unknown) => verifySource({ ...deps, corpus }, where, input, errors);
  const sources = async (where: string, list: unknown, required: boolean): Promise<PreparedSource[]> => {
    const items = Array.isArray(list) ? list : [];
    if (required && !items.length) { errors.push(`${where} needs at least one source`); return []; }
    const out: PreparedSource[] = [];
    for (let i = 0; i < Math.min(items.length, 5); i++) { const s = await source(`${where}[${i}]`, items[i]); if (s) out.push(s); }
    return out;
  };

  const prepared: PreparedOp[] = [];
  const claimed = new Set<string>();
  for (let i = 0; i < ops.length && i < KB_LIMITS.ops; i++) {
    const o = (ops[i] ?? {}) as Record<string, unknown>;
    const where = `ops[${i}]`;
    switch (o.op) {
      case "domain": {
        const name = clean(o.name);
        if (!/^[a-z][a-z0-9-]{1,29}$/.test(name)) { errors.push(`${where}.name must be a short English slug (a-z, 0-9, -)`); break; }
        if (domains.has(name)) break;
        const description = text(`${where}.description`, o.description, 200);
        if (description === null) break;
        domains.add(name);
        prepared.push({ op: "domain", name, description });
        break;
      }
      case "node": {
        const r = clean(o.ref);
        if (!/^[a-z0-9-]{1,40}$/.test(r) || refs.has(r)) { errors.push(`${where}.ref must be a new short id (a-z, 0-9, -) unique in this answer`); break; }
        if (!KB_KINDS.includes(o.kind as never)) { errors.push(`${where}.kind must be one of ${KB_KINDS.join(", ")}`); break; }
        const domain = clean(o.domain);
        if (!domains.has(domain)) { errors.push(`${where}.domain ${domain || "(empty)"} does not exist; use one of the listed domains or add one with a domain op first`); break; }
        const title = text(`${where}.title`, o.title, KB_LIMITS.title);
        const summary = text(`${where}.summary`, o.summary, KB_LIMITS.summary, false);
        if (title === null || summary === null) break;
        refs.add(r);
        prepared.push({ op: "node", ref: r, kind: String(o.kind), domain, title, summary });
        break;
      }
      case "update_node": {
        const id = clean(o.id);
        const node = nodeOf(id);
        if (!node || node.status !== "active") { errors.push(`${where}.id is not an active node`); break; }
        const title = o.title === undefined ? undefined : text(`${where}.title`, o.title, KB_LIMITS.title);
        const summary = o.summary === undefined ? undefined : text(`${where}.summary`, o.summary, KB_LIMITS.summary, false);
        const domain = o.domain === undefined ? undefined : clean(o.domain);
        if (domain !== undefined && !domains.has(domain)) { errors.push(`${where}.domain ${domain} does not exist`); break; }
        if (title === null || summary === null) break;
        prepared.push({ op: "update_node", id, ...(title !== undefined ? { title } : {}), ...(summary !== undefined ? { summary } : {}), ...(domain !== undefined ? { domain } : {}) });
        break;
      }
      case "claim": {
        const node = ref(`${where}.node`, o.node);
        const t = text(`${where}.text`, o.text, KB_LIMITS.claim);
        if (!KB_CERTAINTIES.includes(o.certainty as never)) errors.push(`${where}.certainty must be one of ${KB_CERTAINTIES.join(", ")}`);
        const volatility = o.volatility === undefined ? "stable" : String(o.volatility);
        if (!KB_VOLATILITIES.includes(volatility as never)) errors.push(`${where}.volatility must be one of ${KB_VOLATILITIES.join(", ")}`);
        const days = typeof o.verify_after_days === "number" && o.verify_after_days > 0 ? Math.min(Math.trunc(o.verify_after_days), 3650) : null;
        const replaces = o.replaces ? clean(o.replaces) : null;
        if (replaces) { const old = claimOf(replaces); if (!old || old.status !== "active") errors.push(`${where}.replaces is not an active claim`); }
        const srcs = await sources(`${where}.sources`, o.sources, true);
        if (!node || t === null || !srcs.length) break;
        if (node.kind === "new") claimed.add(node.ref);
        prepared.push({ op: "claim", node, text: t, certainty: String(o.certainty), volatility, verifyAfter: days ?? (volatility === "changes" ? 30 : null), replaces, sources: srcs });
        break;
      }
      case "link": {
        const src = ref(`${where}.src`, o.src);
        const dst = ref(`${where}.dst`, o.dst);
        if (!KB_RELS.includes(o.rel as never)) { errors.push(`${where}.rel must be one of ${KB_RELS.join(", ")}`); break; }
        const srcs = await sources(`${where}.sources`, o.sources, false);
        if (!src || !dst) break;
        if (JSON.stringify(src) === JSON.stringify(dst)) { errors.push(`${where} links a node to itself`); break; }
        prepared.push({ op: "link", src, dst, rel: String(o.rel), sources: srcs });
        break;
      }
      case "merge": {
        const from = clean(o.from);
        const node = nodeOf(from);
        if (!node || node.status !== "active") { errors.push(`${where}.from is not an active node`); break; }
        const into = ref(`${where}.into`, o.into);
        if (!into || (into.kind === "existing" && into.id === from)) { if (into) errors.push(`${where} merges a node into itself`); break; }
        prepared.push({ op: "merge", from, into });
        break;
      }
      case "retire": {
        const id = clean(o.id);
        const item = nodeOf(id) ?? claimOf(id);
        if (!item || item.status !== "active") { errors.push(`${where}.id is not an active node or claim`); break; }
        const reason = text(`${where}.reason`, o.reason, 200);
        if (reason === null) break;
        prepared.push({ op: "retire", id, reason });
        break;
      }
      case "wiki": {
        const id = clean(o.node);
        const why = wikiIneligible(db, ownerId, id);
        if (why) { errors.push(`${where}: ${why}`); break; }
        const md = typeof o.markdown === "string" ? o.markdown.trim() : "";
        if (!md || chars(md) > KB_LIMITS.wiki) { errors.push(`${where}.markdown is required, at most ${KB_LIMITS.wiki} characters`); break; }
        const sensitive = sensitiveReason(md);
        if (sensitive) { errors.push(`${where}.markdown ${sensitive}`); break; }
        prepared.push({ op: "wiki", node: id, markdown: md });
        break;
      }
      default:
        errors.push(`${where}.op must be one of domain, node, update_node, claim, link, merge, retire, wiki`);
    }
  }
  for (const r of refs) if (!claimed.has(r)) errors.push(`node ${r} has no claim in this answer; every new node needs at least one sourced claim`);

  const decided: Array<{ packet: string; status: string; note: string }> = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = (decisions[i] ?? {}) as Record<string, unknown>;
    const packet = clean(d.packet);
    if (!deps.packets.includes(packet)) { errors.push(`decisions[${i}].packet ${packet || "(empty)"} is not one of this batch's packets`); continue; }
    if (!["accepted", "merged", "rejected"].includes(String(d.status))) { errors.push(`decisions[${i}].status must be accepted, merged or rejected`); continue; }
    decided.push({ packet, status: String(d.status), note: clean(d.note).slice(0, 300) });
  }
  if (errors.length) return { ok: false, errors, changed: 0, nodes: [] };

  const ids = new Map<string, string>();
  const idOf = (r: Ref) => (r.kind === "new" ? ids.get(r.ref)! : r.id);
  const touched = new Set<string>();
  const revision = db.prepare("INSERT INTO kb_revisions (owner_id, packets, object_id, op, detail_json, at) VALUES (?,?,?,?,?,?)");
  const packetsLabel = deps.packets.join(",");
  const log = (object: string, op: string, detail: unknown) => revision.run(ownerId, packetsLabel, object, op, JSON.stringify(detail), now);
  const cite = (item: string, list: PreparedSource[]) => {
    for (const s of list) {
      const existing = db.prepare("SELECT id FROM kb_sources WHERE owner_id=? AND task_id=? AND COALESCE(path,'')=? AND COALESCE(url,'')=? AND excerpt=?")
        .get(ownerId, s.task, s.path ?? "", s.url ?? "", s.excerpt) as { id: string } | undefined;
      const sid = existing?.id ?? randomId("kbs");
      if (!existing) db.prepare("INSERT INTO kb_sources (id, owner_id, task_id, path, url, sha256, excerpt, captured_at) VALUES (?,?,?,?,?,?,?,?)").run(sid, ownerId, s.task, s.path, s.url, s.sha256, s.excerpt, now);
      db.prepare("INSERT OR IGNORE INTO kb_cites (item_id, source_id) VALUES (?,?)").run(item, sid);
    }
  };
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const op of prepared) {
      changed++;
      if (op.op === "domain") {
        db.prepare("INSERT OR IGNORE INTO kb_domains (owner_id, name, description, created_at) VALUES (?,?,?,?)").run(ownerId, op.name, op.description, now);
        log(`domain:${op.name}`, "domain", { description: op.description });
      } else if (op.op === "node") {
        const id = randomId("kbn");
        ids.set(op.ref, id);
        db.prepare("INSERT INTO kb_nodes (id, owner_id, kind, domain, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, ownerId, op.kind, op.domain, op.title, op.summary, now, now);
        log(id, "node", { kind: op.kind, domain: op.domain, title: op.title, summary: op.summary });
        touched.add(id);
      } else if (op.op === "update_node") {
        const before = db.prepare("SELECT title, summary, domain FROM kb_nodes WHERE id=?").get(op.id);
        db.prepare("UPDATE kb_nodes SET title=COALESCE(?,title), summary=COALESCE(?,summary), domain=COALESCE(?,domain), updated_at=? WHERE id=?").run(op.title ?? null, op.summary ?? null, op.domain ?? null, now, op.id);
        log(op.id, "update_node", { before, after: { title: op.title, summary: op.summary, domain: op.domain } });
        touched.add(op.id);
      } else if (op.op === "claim") {
        const id = randomId("kbc");
        const node = idOf(op.node);
        db.prepare("INSERT INTO kb_claims (id, node_id, text, certainty, volatility, verify_after, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(id, node, op.text, op.certainty, op.volatility, op.verifyAfter ? now + op.verifyAfter * 86_400_000 : null, now, now);
        cite(id, op.sources);
        if (op.replaces) {
          db.prepare("UPDATE kb_claims SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(id, now, op.replaces);
          const old = db.prepare("SELECT node_id FROM kb_claims WHERE id=?").get(op.replaces) as { node_id: string };
          touched.add(old.node_id);
        }
        log(id, "claim", { node, text: op.text, certainty: op.certainty, volatility: op.volatility, replaces: op.replaces });
        db.prepare("UPDATE kb_nodes SET updated_at=? WHERE id=?").run(now, node);
        touched.add(node);
      } else if (op.op === "link") {
        const src = idOf(op.src);
        const dst = idOf(op.dst);
        const existing = db.prepare("SELECT id FROM kb_edges WHERE src=? AND dst=? AND rel=?").get(src, dst, op.rel) as { id: string } | undefined;
        const id = existing?.id ?? randomId("kbe");
        if (!existing) db.prepare("INSERT INTO kb_edges (id, src, dst, rel, created_at) VALUES (?,?,?,?,?)").run(id, src, dst, op.rel, now);
        cite(id, op.sources);
        log(id, "link", { src, dst, rel: op.rel });
      } else if (op.op === "merge") {
        const into = idOf(op.into);
        db.prepare("UPDATE kb_claims SET node_id=? WHERE node_id=?").run(into, op.from);
        for (const e of db.prepare("SELECT id, src, dst, rel FROM kb_edges WHERE src=? OR dst=?").all(op.from, op.from) as Array<{ id: string; src: string; dst: string; rel: string }>) {
          const src = e.src === op.from ? into : e.src;
          const dst = e.dst === op.from ? into : e.dst;
          if (src === dst || db.prepare("SELECT 1 FROM kb_edges WHERE src=? AND dst=? AND rel=?").get(src, dst, e.rel)) db.prepare("DELETE FROM kb_edges WHERE id=?").run(e.id);
          else db.prepare("UPDATE kb_edges SET src=?, dst=? WHERE id=?").run(src, dst, e.id);
        }
        db.prepare("UPDATE kb_nodes SET status='superseded', superseded_by=?, wiki_md=NULL, wiki_draft=NULL, wiki_at=NULL, updated_at=? WHERE id=?").run(into, now, op.from);
        db.prepare("UPDATE kb_nodes SET reads=reads+(SELECT reads FROM kb_nodes WHERE id=?), updated_at=? WHERE id=?").run(op.from, now, into);
        db.prepare("UPDATE kb_packets SET target=? WHERE target=? AND status='pending'").run(into, op.from);
        log(op.from, "merge", { into });
        touched.add(op.from); touched.add(into);
      } else if (op.op === "retire") {
        const isNode = !!db.prepare("SELECT 1 FROM kb_nodes WHERE id=?").get(op.id);
        if (isNode) db.prepare("UPDATE kb_nodes SET status='retired', wiki_md=NULL, wiki_draft=NULL, wiki_at=NULL, updated_at=? WHERE id=?").run(now, op.id);
        else db.prepare("UPDATE kb_claims SET status='retired', updated_at=? WHERE id=?").run(now, op.id);
        const node = isNode ? op.id : (db.prepare("SELECT node_id FROM kb_claims WHERE id=?").get(op.id) as { node_id: string }).node_id;
        log(op.id, "retire", { reason: op.reason });
        touched.add(node);
      } else if (op.op === "wiki") {
        db.prepare("UPDATE kb_nodes SET wiki_draft=?, updated_at=? WHERE id=?").run(op.markdown, now, op.node);
        log(op.node, "wiki_draft", { chars: chars(op.markdown) });
      }
    }
    for (const d of decided) {
      db.prepare("UPDATE kb_packets SET status=?, note=?, processed_at=? WHERE id=? AND owner_id=?").run(d.status, d.note || null, now, d.packet, ownerId);
    }
    for (const id of touched) reindexNode(db, id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true, errors: [], changed, nodes: [...touched] };
}

/** Why a node may not have a wiki page yet, or null when it may. */
export function wikiIneligible(db: Db, ownerId: string, id: string): string | null {
  const node = db.prepare("SELECT status, reads, wiki_md FROM kb_nodes WHERE id=? AND owner_id=?").get(id, ownerId) as { status: string; reads: number; wiki_md: string | null } | undefined;
  if (!node || node.status !== "active") return `${id} is not an active node`;
  if (node.reads < KB_LIMITS.wikiReads) return `node ${id} has been read by tasks ${node.reads} times; a wiki page needs at least ${KB_LIMITS.wikiReads}`;
  const stats = db.prepare(`SELECT count(DISTINCT s.task_id) AS tasks, sum(c.certainty<>'inferred') AS firm FROM kb_claims c
    JOIN kb_cites x ON x.item_id=c.id JOIN kb_sources s ON s.id=x.source_id WHERE c.node_id=? AND c.status='active'`).get(id) as { tasks: number; firm: number | null };
  if (stats.tasks < 2) return `node ${id} rests on ${stats.tasks} task(s); a wiki page needs sources from at least 2 tasks`;
  if (!stats.firm) return `node ${id} has only inferred claims; a wiki page needs something the user said or that was observed`;
  const pages = (db.prepare("SELECT count(*) AS n FROM kb_nodes WHERE owner_id=? AND wiki_md IS NOT NULL AND id<>?").get(ownerId, id) as { n: number }).n;
  if (!node.wiki_md && pages >= KB_LIMITS.wikiPages) return `there are already ${KB_LIMITS.wikiPages} wiki pages`;
  return null;
}

export function ensureDomains(db: Db, ownerId: string, now = Date.now()): void {
  const insert = db.prepare("INSERT OR IGNORE INTO kb_domains (owner_id, name, description, created_at) VALUES (?,?,?,?)");
  for (const [name, description] of Object.entries(KB_DEFAULT_DOMAINS)) insert.run(ownerId, name, description, now);
}

/** The search row of one node: its title, and its summary, domain and current claims. */
export function reindexNode(db: Db, id: string): void {
  db.prepare("DELETE FROM kb_search WHERE node_id=?").run(id);
  const node = db.prepare("SELECT owner_id, title, summary, domain, status FROM kb_nodes WHERE id=?").get(id) as { owner_id: string; title: string; summary: string; domain: string; status: string } | undefined;
  if (!node || node.status !== "active") return;
  const claims = (db.prepare("SELECT text FROM kb_claims WHERE node_id=? AND status='active'").all(id) as Array<{ text: string }>).map((c) => c.text);
  db.prepare("INSERT INTO kb_search (node_id, owner_id, title, body) VALUES (?,?,?,?)").run(id, node.owner_id, tokenize(node.title).join(" "), tokenize([node.summary, node.domain, ...claims].join("\n")).join(" "));
}

/**
 * The person's own deletion: the node, its claims and edges, and the sources only they
 * cited, gone for good. The ledger keeps only that it happened.
 */
export function deleteKbNode(db: Db, ownerId: string, id: string, by: string): boolean {
  const node = db.prepare("SELECT id FROM kb_nodes WHERE id=? AND owner_id=?").get(id, ownerId);
  if (!node) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const items = [id, ...(db.prepare("SELECT id FROM kb_claims WHERE node_id=?").all(id) as Array<{ id: string }>).map((c) => c.id),
      ...(db.prepare("SELECT id FROM kb_edges WHERE src=? OR dst=?").all(id, id) as Array<{ id: string }>).map((e) => e.id)];
    const cites = db.prepare("DELETE FROM kb_cites WHERE item_id=?");
    for (const item of items) cites.run(item);
    db.prepare("DELETE FROM kb_sources WHERE owner_id=? AND id NOT IN (SELECT source_id FROM kb_cites)").run(ownerId);
    db.prepare("DELETE FROM kb_edges WHERE src=? OR dst=?").run(id, id);
    db.prepare("DELETE FROM kb_claims WHERE node_id=?").run(id);
    db.prepare("DELETE FROM kb_search WHERE node_id=?").run(id);
    db.prepare("UPDATE kb_nodes SET superseded_by=NULL WHERE superseded_by=?").run(id);
    db.prepare("DELETE FROM kb_nodes WHERE id=?").run(id);
    db.prepare("UPDATE kb_packets SET target=NULL WHERE target=?").run(id);
    db.prepare("INSERT INTO kb_revisions (owner_id, packets, object_id, op, detail_json, at) VALUES (?,?,?,?,?,?)").run(ownerId, "", id, "deleted", JSON.stringify({ by }), Date.now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return true;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
