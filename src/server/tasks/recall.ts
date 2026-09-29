import { createHash } from "node:crypto";
import type { Db } from "../db.js";

/**
 * Recall of past tasks for the dispatcher.
 *
 * The dispatcher only sees a window of recent and unfinished tasks. Everything
 * older lives in an FTS5 index scored by BM25 (term frequency x inverse
 * document frequency), so a message that refers back hundreds of tasks can
 * still reach the task it means. FTS5's default tokenizer keeps a run of
 * Chinese as one token, so text is indexed as overlapping CJK bigrams plus
 * latin words and numbers.
 */

export interface RecallDoc {
  id: string;
  ownerId: string;
  title: string;
  /** The task's own input with its supplements. */
  body: string;
  result: string | null;
}

export interface RecallHit {
  id: string;
  score: number;
  rank: number;
}

/** Bigrams too common to say anything about which task a message means. */
const STOP = new Set(
  "帮我 一下 我们 你们 他们 这个 那个 一个 可以 什么 怎么 需要 现在 然后 还是 就是 没有 不是 因为 所以 如果 或者 已经 请你 给我 看看 一些 这些 那些 时候 的话 之后 之前 以后 以前 继续 刚才 上次".split(" "),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const run of lower.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]/.test(run)) {
      if (run.length >= 2 || /\d/.test(run)) out.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) out.push(chars[0]!);
    for (let i = 0; i + 1 < chars.length; i++) {
      const gram = chars[i]! + chars[i + 1]!;
      if (!STOP.has(gram)) out.push(gram);
    }
  }
  return out;
}

const DOC_BODY_CHARS = 6000;
const DOC_RESULT_CHARS = 8000;
const QUERY_CHARS = 2000;
const QUERY_TERMS = 48;
/** A hit this far below the best one is noise, whatever the cap allows. */
const RELATIVE_FLOOR = 0.3;
export const DEFAULT_CAP = 10;
const MIN_CAP = 5;
/** Labelled events needed before the cap follows observed ranks. */
const TUNE_MIN_SAMPLES = 20;

export class TaskRecall {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /** Bring the index up to date with the given tasks; unchanged ones are skipped by content hash. */
  sync(docs: RecallDoc[]): void {
    const known = new Map((this.#db.prepare("SELECT task_id, hash FROM task_search_state").all() as Array<{ task_id: string; hash: string }>).map((r) => [r.task_id, r.hash]));
    const remove = this.#db.prepare("DELETE FROM task_search WHERE task_id=?");
    const insert = this.#db.prepare("INSERT INTO task_search (task_id, owner_id, title, body) VALUES (?,?,?,?)");
    const mark = this.#db.prepare("INSERT INTO task_search_state (task_id, hash) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET hash=excluded.hash");
    for (const doc of docs) {
      const body = `${doc.body.slice(0, DOC_BODY_CHARS)}\n${(doc.result ?? "").slice(0, DOC_RESULT_CHARS)}`;
      const hash = createHash("sha1").update(`${doc.ownerId}\0${doc.title}\0${body}`).digest("hex");
      if (known.get(doc.id) === hash) continue;
      remove.run(doc.id);
      insert.run(doc.id, doc.ownerId, tokenize(doc.title).join(" "), tokenize(body).join(" "));
      mark.run(doc.id, hash);
    }
  }

  /** Drop tasks that no longer stand on their own (merged into another task). */
  forget(ids: string[]): void {
    const remove = this.#db.prepare("DELETE FROM task_search WHERE task_id=?");
    const unmark = this.#db.prepare("DELETE FROM task_search_state WHERE task_id=?");
    for (const id of ids) {
      remove.run(id);
      unmark.run(id);
    }
  }

  /** Every match, best first, with its BM25 score (higher is better). Titles weigh double. */
  rank(ownerId: string, query: string, limit = 50): RecallHit[] {
    const terms = [...new Set(tokenize(query.slice(0, QUERY_CHARS)))].slice(0, QUERY_TERMS);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.#db
      .prepare("SELECT task_id AS id, -bm25(task_search, 0, 0, 2.0, 1.0) AS score FROM task_search WHERE task_search MATCH ? AND owner_id=? ORDER BY score DESC LIMIT ?")
      .all(match, ownerId, limit) as Array<{ id: string; score: number }>;
    return rows.map((r, i) => ({ id: r.id, score: r.score, rank: i + 1 }));
  }

  /**
   * The hits worth showing the dispatcher: at most `cap`, and none far below the
   * best one, so a message with one clear match brings one task, not ten.
   */
  search(ownerId: string, query: string, opts: { exclude?: Set<string>; cap?: number } = {}): RecallHit[] {
    const cap = opts.cap ?? this.cap();
    const hits = this.rank(ownerId, query, cap + (opts.exclude?.size ?? 0));
    // Measured against the best match even when that one is already shown, so a
    // clear match in view does not let weak ones in behind it.
    const best = hits[0]?.score ?? 0;
    return hits.filter((h) => !opts.exclude?.has(h.id) && h.score >= best * RELATIVE_FLOOR).slice(0, cap);
  }

  /**
   * The cap follows what monitoring measured: when a person had to point at a
   * task by hand, where the search ranked it. Until there is enough of that,
   * the default holds.
   */
  cap(): number {
    const ranks = (this.#db.prepare("SELECT gold_rank FROM recall_events WHERE gold_rank IS NOT NULL AND gold_in_window=0 ORDER BY created_at DESC LIMIT 100").all() as Array<{ gold_rank: number }>).map((r) => r.gold_rank).sort((a, b) => a - b);
    if (ranks.length < TUNE_MIN_SAMPLES) return DEFAULT_CAP;
    const p90 = ranks[Math.min(ranks.length - 1, Math.ceil(ranks.length * 0.9) - 1)]!;
    return Math.max(MIN_CAP, Math.min(DEFAULT_CAP, p90 + 2));
  }
}

export type RecallSource = "recent" | "active" | "today" | "recall" | "context" | "search" | "explicit";

export interface RecallEvent {
  taskId: string;
  ownerId: string;
  /** Candidate ids the dispatcher saw, by where they came from. */
  candidates: Array<{ id: string; source: RecallSource; rank?: number; score?: number }>;
  searches: string[];
  rounds: number;
  chosen: { related: string[]; appendTo: string | null };
  /** A task the person pointed at by hand, and where search alone would have ranked it. */
  gold: { id: string; rank: number | null; inWindow: boolean } | null;
  latencyMs: number;
  promptChars: number;
  failed: boolean;
}

export function recordRecall(db: Db, e: RecallEvent): void {
  db.prepare(
    "INSERT INTO recall_events (task_id, owner_id, created_at, candidates_json, searches_json, rounds, chosen_json, gold_task_id, gold_rank, gold_in_window, latency_ms, prompt_chars, failed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(e.taskId, e.ownerId, Date.now(), JSON.stringify(e.candidates), JSON.stringify(e.searches), e.rounds, JSON.stringify(e.chosen), e.gold?.id ?? null, e.gold?.rank ?? null, e.gold ? (e.gold.inWindow ? 1 : 0) : null, e.latencyMs, e.promptChars, e.failed ? 1 : 0);
}

export interface RecallStats {
  days: number;
  dispatches: number;
  failed: number;
  /** Dispatches where recall brought at least one task beyond the recent window. */
  withRecall: number;
  avgRecalled: number;
  /** Dispatches where the dispatcher asked to search, and the average number of rounds. */
  searchRate: number;
  avgRounds: number;
  /** Chosen related/append targets, and how many of them only recall or search had surfaced. */
  chosen: number;
  chosenFromRecall: number;
  chosenFromSearch: number;
  /** Hand-picked references outside the recent window: how often search alone ranked them within the cap. */
  labelled: number;
  recallAtCap: number | null;
  mrr: number | null;
  cap: number;
  avgLatencyMs: number;
  p90PromptChars: number;
}

export function recallStats(db: Db, ownerId: string, days: number, cap: number): RecallStats {
  const since = Date.now() - days * 86_400_000;
  const rows = db.prepare("SELECT * FROM recall_events WHERE owner_id=? AND created_at >= ? ORDER BY created_at").all(ownerId, since) as Array<{
    candidates_json: string; searches_json: string; rounds: number; chosen_json: string; gold_rank: number | null; gold_in_window: number | null; latency_ms: number; prompt_chars: number; failed: number;
  }>;
  let withRecall = 0, recalled = 0, searched = 0, rounds = 0, chosen = 0, fromRecall = 0, fromSearch = 0, latency = 0;
  const labelled: Array<number | null> = [];
  for (const r of rows) {
    const candidates = JSON.parse(r.candidates_json) as RecallEvent["candidates"];
    const extra = candidates.filter((c) => c.source === "recall" || c.source === "context" || c.source === "search" || c.source === "today");
    if (extra.length) withRecall += 1;
    recalled += extra.length;
    if (r.rounds > 1) searched += 1;
    rounds += r.rounds;
    latency += r.latency_ms;
    const pick = JSON.parse(r.chosen_json) as RecallEvent["chosen"];
    const source = new Map(candidates.map((c) => [c.id, c.source]));
    for (const id of new Set([...pick.related, ...(pick.appendTo ? [pick.appendTo] : [])])) {
      chosen += 1;
      const s = source.get(id);
      if (s === "recall" || s === "context" || s === "today") fromRecall += 1;
      if (s === "search") fromSearch += 1;
    }
    if (r.gold_in_window === 0) labelled.push(r.gold_rank);
  }
  const n = rows.length || 1;
  const prompts = rows.map((r) => r.prompt_chars).sort((a, b) => a - b);
  return {
    days,
    dispatches: rows.length,
    failed: rows.filter((r) => r.failed).length,
    withRecall,
    avgRecalled: round(recalled / n),
    searchRate: round(searched / n),
    avgRounds: round(rounds / n),
    chosen,
    chosenFromRecall: fromRecall,
    chosenFromSearch: fromSearch,
    labelled: labelled.length,
    recallAtCap: labelled.length ? round(labelled.filter((r) => r !== null && r <= cap).length / labelled.length) : null,
    mrr: labelled.length ? round(labelled.reduce<number>((sum, r) => sum + (r ? 1 / r : 0), 0) / labelled.length) : null,
    cap,
    avgLatencyMs: Math.round(latency / n),
    p90PromptChars: prompts.length ? prompts[Math.min(prompts.length - 1, Math.ceil(prompts.length * 0.9) - 1)]! : 0,
  };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
