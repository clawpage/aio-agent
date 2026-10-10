import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { randomId } from "../auth/passwords.js";
import { tokenize } from "./recall.js";

/**
 * What an executor can look up about the account's past, on demand, instead of
 * having it pasted into every turn: the standing agreements the person asked to
 * keep, and what an earlier task actually did (its tool calls and messages).
 */

export const AGREEMENT_KINDS = ["rule", "preference", "commitment", "fact"] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];
const KIND_LABEL: Record<AgreementKind, string> = { rule: "规则", preference: "偏好", commitment: "约定", fact: "事实" };
export const AGREEMENT_TEXT_MAX = 300;
const AGREEMENTS_MAX = 200;
/** The standing block every execution thread is given once: this many characters at most. */
const STANDING_CHARS = 2500;

export interface Agreement { id: string; kind: AgreementKind; text: string; sourceTaskId: string | null; createdAt: number; updatedAt: number }

interface AgreementRow { id: string; owner_id: string; kind: AgreementKind; text: string; source_task_id: string | null; created_at: number; updated_at: number }
const view = (r: AgreementRow): Agreement => ({ id: r.id, kind: r.kind, text: r.text, sourceTaskId: r.source_task_id, createdAt: r.created_at, updatedAt: r.updated_at });

export function listAgreements(db: Db, ownerId: string): Agreement[] {
  return (db.prepare("SELECT * FROM agreements WHERE owner_id=? ORDER BY updated_at DESC, id").all(ownerId) as unknown as AgreementRow[]).map(view);
}

/** Save one agreement, or rewrite the one it replaces (a changed mind keeps one entry, not two). */
export function saveAgreement(db: Db, ownerId: string, input: { kind?: unknown; text?: unknown; replaces?: unknown; taskId?: string | null }): { agreement: Agreement; replaced: boolean } {
  const kind = input.kind as AgreementKind;
  if (!AGREEMENT_KINDS.includes(kind)) throw new Error(`kind 只能是 ${AGREEMENT_KINDS.join("、")}`);
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new Error("text 要写清这条约定的内容");
  if ([...text].length > AGREEMENT_TEXT_MAX) throw new Error(`text 最多 ${AGREEMENT_TEXT_MAX} 字，只写要长期记住的那一句`);
  const now = Date.now();
  if (typeof input.replaces === "string" && input.replaces) {
    const old = db.prepare("SELECT * FROM agreements WHERE id=? AND owner_id=?").get(input.replaces, ownerId) as AgreementRow | undefined;
    if (!old) throw new Error(`没有 id 为 ${input.replaces} 的约定`);
    db.prepare("UPDATE agreements SET kind=?,text=?,source_task_id=COALESCE(?,source_task_id),updated_at=? WHERE id=?").run(kind, text, input.taskId ?? null, now, old.id);
    return { agreement: view({ ...old, kind, text, updated_at: now }), replaced: true };
  }
  const same = db.prepare("SELECT * FROM agreements WHERE owner_id=? AND text=?").get(ownerId, text) as AgreementRow | undefined;
  if (same) {
    db.prepare("UPDATE agreements SET kind=?,updated_at=? WHERE id=?").run(kind, now, same.id);
    return { agreement: view({ ...same, kind, updated_at: now }), replaced: false };
  }
  const count = (db.prepare("SELECT count(*) AS n FROM agreements WHERE owner_id=?").get(ownerId) as { n: number }).n;
  if (count >= AGREEMENTS_MAX) throw new Error(`约定已有 ${AGREEMENTS_MAX} 条：先用 memory_search 找到过时的，用 replaces 改写或 memory_forget 删掉`);
  const row: AgreementRow = { id: randomId("mem"), owner_id: ownerId, kind, text, source_task_id: input.taskId ?? null, created_at: now, updated_at: now };
  db.prepare("INSERT INTO agreements (id,owner_id,kind,text,source_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(row.id, row.owner_id, row.kind, row.text, row.source_task_id, row.created_at, row.updated_at);
  return { agreement: view(row), replaced: false };
}

export function forgetAgreement(db: Db, ownerId: string, id: string): boolean {
  return Number(db.prepare("DELETE FROM agreements WHERE id=? AND owner_id=?").run(id, ownerId).changes) > 0;
}

/** Agreements sharing the most words with the query, best first; all of them (newest first) for an empty query. */
export function searchAgreements(db: Db, ownerId: string, query: string, limit = 20): Agreement[] {
  const all = listAgreements(db, ownerId);
  const terms = new Set(tokenize(query));
  if (!terms.size) return all.slice(0, limit);
  return all
    .map((a) => ({ a, score: tokenize(a.text).filter((t) => terms.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || y.a.updatedAt - x.a.updatedAt)
    .slice(0, limit)
    .map((x) => x.a);
}

const KIND_ORDER: Record<AgreementKind, number> = { rule: 0, preference: 1, commitment: 2, fact: 3 };

/**
 * The agreements every execution thread starts with: rules first, then
 * preferences, commitments and facts, newest first within each, up to a small
 * budget. The rest are one memory_search away. `version` changes only when the
 * block does, so a resumed thread is not given the same block twice.
 */
export function standingAgreements(db: Db, ownerId: string): { text: string; version: string; omitted: number } | null {
  const all = listAgreements(db, ownerId).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.updatedAt - a.updatedAt);
  if (!all.length) return null;
  const lines: string[] = [];
  let used = 0;
  for (const a of all) {
    const line = `- [${KIND_LABEL[a.kind]}] ${a.text}（${a.id}）`;
    if (used + line.length > STANDING_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  const text = lines.join("\n");
  return { text, version: createHash("sha256").update(text).digest("hex").slice(0, 8), omitted: all.length - lines.length };
}

/** One line per thing a turn did, short enough that a whole task fits in a few thousand characters. */
export function processSteps(db: Db, turnId: string, limit = 40): { steps: string[]; more: number } {
  const rows = db.prepare("SELECT payload FROM events WHERE turn_id=? AND type='item/completed' ORDER BY id").all(turnId) as Array<{ payload: string }>;
  const clip = (s: unknown, n: number) => { const c = [...String(s ?? "").replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };
  const steps: string[] = [];
  for (const { payload } of rows) {
    let item: Record<string, unknown>;
    try { item = (JSON.parse(payload) as { item?: Record<string, unknown> }).item ?? {}; } catch { continue; }
    const type = String(item.type ?? "");
    if (type === "mcpToolCall") {
      const error = (item.error as { message?: string } | null)?.message;
      steps.push(`工具 ${item.server}.${item.tool}(${clip(JSON.stringify(item.arguments ?? {}), 120)})${error ? ` → 出错：${clip(error, 100)}` : ""}`);
    } else if (type === "commandExecution") {
      steps.push(`命令 ${clip(String(item.command ?? "").replace(/^\/bin\/(ba)?sh -lc /, ""), 140)}${typeof item.exitCode === "number" && item.exitCode !== 0 ? `（退出码 ${item.exitCode}）` : ""}`);
    } else if (type === "webSearch") {
      const query = item.query || (item.action as { query?: string } | null)?.query;
      if (query) steps.push(`搜索 ${clip(query, 120)}`);
    } else if (type === "fileChange") {
      const files = Array.isArray(item.changes) ? (item.changes as Array<{ path?: string }>).map((c) => c.path).filter(Boolean).join("、") : "";
      steps.push(`改文件 ${clip(files, 140)}`);
    } else if (type === "agentMessage") {
      steps.push(`说 ${clip(item.text, 200)}`);
    } else if (type && !["reasoning", "userMessage", "contextCompaction", "imageView"].includes(type)) {
      // Claude Code's own tools (Read, WebFetch, ...): their name and first argument.
      const input = (item.input ?? item.arguments ?? {}) as Record<string, unknown>;
      const first = Object.values(input).find((v) => typeof v === "string");
      steps.push(`${type}${first ? ` ${clip(first, 120)}` : ""}`);
    }
  }
  return { steps: steps.slice(-limit), more: Math.max(0, steps.length - limit) };
}
