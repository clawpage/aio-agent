import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { Logger } from "../../common/logger.js";
import { randomId } from "../auth/passwords.js";
import { t } from "../i18n/index.js";
import { deleteKbNode, ensureDomains, KB_KINDS, KB_LIMITS, reindexNode, sensitiveReason, type PreparedSource } from "./kernel.js";
import { openLibraryDb, tracked } from "./ledger.js";

/**
 * Shared knowledge bases (docs/SHARED-KB.md): who belongs to which library, invitations,
 * each library's rules, and what members change by hand. A library's contents live in its
 * own file under data/kbs/; the list of libraries and members lives in the owner runtime's
 * database. Every method that acts for a person checks membership first.
 */

export class SharedKbError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface LibraryRow { id: string; name: string; admin_id: string; created_by: string; created_at: number }
export interface LibraryPacket { from: string; type: string; task: string | null; target: string | null; title?: string; text: string; reason?: string; evidence: PreparedSource[] }

export const RULES_MAX = 4000;
const NAME_MAX = 40;
const INVITE_DAYS = 7;
const PACKETS_PER_TASK = 12;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const chars = (s: string) => [...s].length;

export class SharedKbs {
  readonly #db: Db;
  readonly #dir: string;
  readonly #log: Logger;
  readonly #dbs = new Map<string, Db>();
  /** Told when a packet waits in a library's mailbox (the shared maintainer). */
  onPacket: ((library: string, urgent: boolean) => void) | null = null;

  constructor(opts: { db: Db; dataDir: string; log: Logger }) {
    this.#db = opts.db;
    this.#dir = path.join(opts.dataDir, "kbs");
    this.#log = opts.log.child("shared-kb");
  }

  usernameOf(id: string): string {
    return (this.#db.prepare("SELECT username FROM owners WHERE id=?").get(id) as { username: string } | undefined)?.username ?? id;
  }

  /** A library's database, opened once. */
  db(id: string): Db {
    let db = this.#dbs.get(id);
    if (!db) {
      if (!/^kbl_[A-Za-z0-9_-]+$/.test(id)) throw new Error("bad library id");
      db = openLibraryDb(path.join(this.#dir, `${id}.sqlite`));
      this.#dbs.set(id, db);
    }
    return db;
  }

  library(id: string): LibraryRow | null {
    return (this.#db.prepare("SELECT * FROM kb_libraries WHERE id=?").get(id) as LibraryRow | undefined) ?? null;
  }

  /** The libraries a person belongs to, by name. */
  librariesOf(userId: string): Array<{ id: string; name: string; admin: boolean }> {
    return (this.#db.prepare("SELECT l.id, l.name, l.admin_id FROM kb_libraries l JOIN kb_library_members m ON m.library_id=l.id WHERE m.user_id=? ORDER BY l.created_at")
      .all(userId) as Array<{ id: string; name: string; admin_id: string }>).map((l) => ({ id: l.id, name: l.name, admin: l.admin_id === userId }));
  }

  isMember(id: string, userId: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM kb_library_members WHERE library_id=? AND user_id=?").get(id, userId);
  }

  /** The library a person may act on, or a 404 that does not say whether it exists. */
  member(id: string, userId: string): LibraryRow {
    const lib = this.library(id);
    if (!lib || !this.isMember(id, userId)) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
    return lib;
  }

  #admin(id: string, userId: string): LibraryRow {
    const lib = this.member(id, userId);
    if (lib.admin_id !== userId) throw new SharedKbError(403, "admin_only", t().knowledge.adminOnly);
    return lib;
  }

  members(id: string): Array<{ id: string; username: string; joinedAt: number }> {
    return (this.#db.prepare("SELECT user_id, joined_at FROM kb_library_members WHERE library_id=? ORDER BY joined_at").all(id) as Array<{ user_id: string; joined_at: number }>)
      .map((m) => ({ id: m.user_id, username: this.usernameOf(m.user_id), joinedAt: m.joined_at }));
  }

  #name(value: unknown): string {
    const name = clean(value);
    if (!name || chars(name) > NAME_MAX) throw new SharedKbError(400, "bad_name", t().knowledge.badName(NAME_MAX));
    return name;
  }

  #rulesText(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (chars(text) > RULES_MAX) throw new SharedKbError(400, "rules_too_long", t().knowledge.rulesTooLong(RULES_MAX));
    const sensitive = sensitiveReason(text);
    if (sensitive) throw new SharedKbError(400, "sensitive", t().knowledge.sensitive);
    return text;
  }

  create(userId: string, name: unknown, rules: unknown): string {
    const n = this.#name(name);
    const text = this.#rulesText(rules);
    const id = randomId("kbl");
    const now = Date.now();
    const db = this.db(id);
    ensureDomains(db, id, now);
    db.prepare("INSERT INTO kb_rules (text, by, at) VALUES (?,?,?)").run(text, userId, now);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO kb_libraries (id, name, admin_id, created_by, created_at) VALUES (?,?,?,?,?)").run(id, n, userId, userId, now);
      this.#db.prepare("INSERT INTO kb_library_members (library_id, user_id, joined_at) VALUES (?,?,?)").run(id, userId, now);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    this.#log.info("shared library created", { library: id });
    return id;
  }

  rename(id: string, userId: string, name: unknown): void {
    this.member(id, userId);
    this.#db.prepare("UPDATE kb_libraries SET name=? WHERE id=?").run(this.#name(name), id);
  }

  // ----- rules -----

  rules(id: string): { version: number; text: string; by: string; at: number } {
    const row = this.db(id).prepare("SELECT version, text, by, at FROM kb_rules ORDER BY version DESC LIMIT 1").get() as { version: number; text: string; by: string; at: number } | undefined;
    return row ?? { version: 0, text: "", by: "", at: 0 };
  }

  ruleHistory(id: string, userId: string): Array<{ version: number; text: string; by: string; at: number; restoredFrom: number | null }> {
    this.member(id, userId);
    return (this.db(id).prepare("SELECT version, text, by, at, restored_from FROM kb_rules ORDER BY version DESC LIMIT 100").all() as Array<{ version: number; text: string; by: string; at: number; restored_from: number | null }>)
      .map((r) => ({ version: r.version, text: r.text, by: this.usernameOf(r.by), at: r.at, restoredFrom: r.restored_from }));
  }

  setRules(id: string, userId: string, text: unknown, restoredFrom: number | null = null): number {
    this.member(id, userId);
    const value = this.#rulesText(text);
    if (value === this.rules(id).text) return this.rules(id).version;
    return Number(this.db(id).prepare("INSERT INTO kb_rules (text, by, at, restored_from) VALUES (?,?,?,?)").run(value, userId, Date.now(), restoredFrom).lastInsertRowid);
  }

  restoreRules(id: string, userId: string, version: number): number {
    this.member(id, userId);
    const row = this.db(id).prepare("SELECT text FROM kb_rules WHERE version=?").get(version) as { text: string } | undefined;
    if (!row) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
    return this.setRules(id, userId, row.text, version);
  }

  // ----- invitations and membership -----

  createInvite(id: string, userId: string): { id: string; token: string; expiresAt: number } {
    this.member(id, userId);
    const token = randomBytes(24).toString("base64url");
    const inviteId = randomId("kbi");
    const now = Date.now();
    const expiresAt = now + INVITE_DAYS * 86_400_000;
    this.#db.prepare("INSERT INTO kb_library_invites (id, library_id, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)").run(inviteId, id, hash(token), userId, now, expiresAt);
    return { id: inviteId, token, expiresAt };
  }

  invites(id: string, userId: string): Array<{ id: string; createdBy: string; createdAt: number; expiresAt: number; uses: number }> {
    this.member(id, userId);
    return (this.#db.prepare("SELECT id, created_by, created_at, expires_at, uses FROM kb_library_invites WHERE library_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC")
      .all(id, Date.now()) as Array<{ id: string; created_by: string; created_at: number; expires_at: number; uses: number }>)
      .map((i) => ({ id: i.id, createdBy: this.usernameOf(i.created_by), createdAt: i.created_at, expiresAt: i.expires_at, uses: i.uses }));
  }

  revokeInvite(id: string, userId: string, inviteId: string): void {
    this.member(id, userId);
    const r = this.#db.prepare("UPDATE kb_library_invites SET revoked_at=? WHERE id=? AND library_id=? AND revoked_at IS NULL").run(Date.now(), inviteId, id);
    if (!r.changes) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
  }

  #invite(token: unknown): { id: string; library_id: string; created_by: string } {
    const value = typeof token === "string" ? token.trim() : "";
    const row = value ? this.#db.prepare("SELECT id, library_id, created_by FROM kb_library_invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?").get(hash(value), Date.now()) as { id: string; library_id: string; created_by: string } | undefined : undefined;
    if (!row) throw new SharedKbError(404, "invite_invalid", t().knowledge.inviteInvalid);
    return row;
  }

  /** What an invitation link leads to, for the person who opened it. */
  previewInvite(token: unknown, userId: string): { library: string; name: string; inviter: string; member: boolean; members: number } {
    const invite = this.#invite(token);
    const lib = this.library(invite.library_id)!;
    const members = (this.#db.prepare("SELECT count(*) AS n FROM kb_library_members WHERE library_id=?").get(lib.id) as { n: number }).n;
    return { library: lib.id, name: lib.name, inviter: this.usernameOf(invite.created_by), member: this.isMember(lib.id, userId), members };
  }

  join(token: unknown, userId: string): string {
    const invite = this.#invite(token);
    if (this.isMember(invite.library_id, userId)) return invite.library_id;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO kb_library_members (library_id, user_id, joined_at) VALUES (?,?,?)").run(invite.library_id, userId, Date.now());
      this.#db.prepare("UPDATE kb_library_invites SET uses=uses+1 WHERE id=?").run(invite.id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    this.#log.info("shared library joined", { library: invite.library_id });
    return invite.library_id;
  }

  /** Leave a library. The administrator hands it over first, unless nobody else is left: then it is dissolved. */
  leave(id: string, userId: string): { dissolved: boolean } {
    const lib = this.member(id, userId);
    const others = this.members(id).filter((m) => m.id !== userId);
    if (lib.admin_id === userId) {
      if (others.length) throw new SharedKbError(409, "transfer_first", t().knowledge.transferFirst);
      this.#dissolve(id);
      return { dissolved: true };
    }
    this.#db.prepare("DELETE FROM kb_library_members WHERE library_id=? AND user_id=?").run(id, userId);
    return { dissolved: false };
  }

  removeMember(id: string, adminId: string, userId: string): void {
    this.#admin(id, adminId);
    if (userId === adminId) throw new SharedKbError(400, "bad_request", t().knowledge.cannotRemoveSelf);
    const r = this.#db.prepare("DELETE FROM kb_library_members WHERE library_id=? AND user_id=?").run(id, userId);
    if (!r.changes) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
  }

  transfer(id: string, adminId: string, to: string): void {
    this.#admin(id, adminId);
    if (!this.isMember(id, to)) throw new SharedKbError(400, "not_member", t().knowledge.notMember);
    this.#db.prepare("UPDATE kb_libraries SET admin_id=? WHERE id=?").run(to, id);
  }

  dissolve(id: string, adminId: string): void {
    this.#admin(id, adminId);
    this.#dissolve(id);
  }

  #dissolve(id: string): void {
    this.#db.prepare("DELETE FROM kb_libraries WHERE id=?").run(id);
    this.#dbs.get(id)?.close();
    this.#dbs.delete(id);
    const file = path.join(this.#dir, `${id}.sqlite`);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    this.#log.info("shared library dissolved", { library: id });
  }

  // ----- the mailbox -----

  /** Leave a packet for the library's maintainer; a correction flags its node at once. */
  enqueue(id: string, packet: LibraryPacket): string {
    if (!this.isMember(id, packet.from)) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
    const db = this.db(id);
    if (packet.task) {
      const sent = (db.prepare("SELECT count(*) AS n FROM kb_packets WHERE owner_id=? AND task_id=? AND json_extract(payload_json,'$.from')=?").get(id, packet.task, packet.from) as { n: number }).n;
      if (sent >= PACKETS_PER_TASK) throw new SharedKbError(429, "too_many", `this task already sent ${PACKETS_PER_TASK} items to this library`);
      const same = db.prepare("SELECT id FROM kb_packets WHERE owner_id=? AND task_id=? AND status='pending' AND type=? AND COALESCE(target,'')=? AND json_extract(payload_json,'$.text')=?")
        .get(id, packet.task, packet.type, packet.target ?? "", packet.text) as { id: string } | undefined;
      if (same) return same.id;
    }
    const pid = randomId("kbp");
    db.prepare("INSERT INTO kb_packets (id, owner_id, kind, type, task_id, target, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(pid, id, "propose", packet.type, packet.task, packet.target, JSON.stringify(packet), Date.now());
    this.onPacket?.(id, packet.type !== "add");
    return pid;
  }

  /** The library a node belongs to among those a person may read, or null. */
  libraryOfNode(userId: string, nodeId: string): string | null {
    for (const lib of this.librariesOf(userId)) {
      if (this.db(lib.id).prepare("SELECT 1 FROM kb_nodes WHERE id=? AND owner_id=?").get(nodeId, lib.id)) return lib.id;
    }
    return null;
  }

  /** The same for a claim: its library and node. */
  libraryOfClaim(userId: string, claimId: string): { library: string; node: string } | null {
    for (const lib of this.librariesOf(userId)) {
      const row = this.db(lib.id).prepare("SELECT c.node_id FROM kb_claims c JOIN kb_nodes n ON n.id=c.node_id WHERE c.id=? AND n.owner_id=?").get(claimId, lib.id) as { node_id: string } | undefined;
      if (row) return { library: lib.id, node: row.node_id };
    }
    return null;
  }

  // ----- what members change by hand (docs/SHARED-KB.md §3.4) -----

  #text(value: unknown, max: number, required = true): string {
    const v = clean(value);
    if (!v && required) throw new SharedKbError(400, "bad_request", t().knowledge.required);
    if (chars(v) > max) throw new SharedKbError(400, "too_long", t().knowledge.tooLong(max));
    if (sensitiveReason(v)) throw new SharedKbError(400, "sensitive", t().knowledge.sensitive);
    return v;
  }

  #domain(db: Db, id: string, value: unknown): string {
    const domain = clean(value) || "other";
    if (!db.prepare("SELECT 1 FROM kb_domains WHERE owner_id=? AND name=?").get(id, domain)) throw new SharedKbError(400, "bad_domain", t().knowledge.badDomain);
    return domain;
  }

  #activeNode(db: Db, id: string, nodeId: string): void {
    if (!db.prepare("SELECT 1 FROM kb_nodes WHERE id=? AND owner_id=? AND status='active'").get(nodeId, id)) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
  }

  /** A member's own words, cited as such. */
  #cite(db: Db, id: string, userId: string, item: string, text: string, now: number): void {
    const sid = randomId("kbs");
    db.prepare("INSERT INTO kb_sources (id, owner_id, task_id, path, url, sha256, excerpt, captured_at, kind, contributor) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(sid, id, "", null, null, null, text, now, "manual", userId);
    db.prepare("INSERT INTO kb_cites (item_id, source_id) VALUES (?,?)").run(item, sid);
  }

  #insertClaim(db: Db, id: string, userId: string, nodeId: string, text: string, now: number): string {
    const cid = randomId("kbc");
    db.prepare("INSERT INTO kb_claims (id, node_id, text, certainty, volatility, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(cid, nodeId, text, "user_said", "stable", now, now);
    this.#cite(db, id, userId, cid, text, now);
    return cid;
  }

  createEntry(id: string, userId: string, input: { title?: unknown; kind?: unknown; domain?: unknown; summary?: unknown; claims?: unknown }): string {
    this.member(id, userId);
    const db = this.db(id);
    const title = this.#text(input.title, KB_LIMITS.title);
    const summary = this.#text(input.summary, KB_LIMITS.summary, false);
    const kind = KB_KINDS.includes(input.kind as never) ? String(input.kind) : "fact";
    const domain = this.#domain(db, id, input.domain);
    const claims = (Array.isArray(input.claims) ? input.claims : []).map((c) => this.#text(c, KB_LIMITS.claim, false)).filter(Boolean).slice(0, 20);
    if (!claims.length && !summary) throw new SharedKbError(400, "bad_request", t().knowledge.needContent);
    const nodeId = randomId("kbn");
    tracked(db, { by: userId, kind: "edit", summary: title }, () => {
      const now = Date.now();
      db.prepare("INSERT INTO kb_nodes (id, owner_id, kind, domain, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(nodeId, id, kind, domain, title, summary, now, now);
      for (const c of claims) this.#insertClaim(db, id, userId, nodeId, c, now);
      reindexNode(db, nodeId);
    });
    return nodeId;
  }

  updateNode(id: string, userId: string, nodeId: string, input: { title?: unknown; summary?: unknown; domain?: unknown; kind?: unknown }): void {
    this.member(id, userId);
    const db = this.db(id);
    this.#activeNode(db, id, nodeId);
    const title = input.title === undefined ? null : this.#text(input.title, KB_LIMITS.title);
    const summary = input.summary === undefined ? null : this.#text(input.summary, KB_LIMITS.summary, false);
    const domain = input.domain === undefined ? null : this.#domain(db, id, input.domain);
    const kind = input.kind === undefined ? null : KB_KINDS.includes(input.kind as never) ? String(input.kind) : null;
    const current = db.prepare("SELECT title FROM kb_nodes WHERE id=?").get(nodeId) as { title: string };
    tracked(db, { by: userId, kind: "edit", summary: title ?? current.title }, () => {
      db.prepare("UPDATE kb_nodes SET title=COALESCE(?,title), summary=COALESCE(?,summary), domain=COALESCE(?,domain), kind=COALESCE(?,kind), updated_at=? WHERE id=?")
        .run(title, summary, domain, kind, Date.now(), nodeId);
      reindexNode(db, nodeId);
    });
  }

  addClaim(id: string, userId: string, nodeId: string, text: unknown): string {
    this.member(id, userId);
    const db = this.db(id);
    this.#activeNode(db, id, nodeId);
    const value = this.#text(text, KB_LIMITS.claim);
    const title = (db.prepare("SELECT title FROM kb_nodes WHERE id=?").get(nodeId) as { title: string }).title;
    let cid = "";
    tracked(db, { by: userId, kind: "edit", summary: title }, () => {
      const now = Date.now();
      cid = this.#insertClaim(db, id, userId, nodeId, value, now);
      db.prepare("UPDATE kb_nodes SET updated_at=? WHERE id=?").run(now, nodeId);
      reindexNode(db, nodeId);
    });
    return cid;
  }

  #claimNode(db: Db, id: string, claimId: string): { node_id: string; title: string } {
    const row = db.prepare("SELECT c.node_id, n.title FROM kb_claims c JOIN kb_nodes n ON n.id=c.node_id WHERE c.id=? AND n.owner_id=? AND c.status='active'").get(claimId, id) as { node_id: string; title: string } | undefined;
    if (!row) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
    return row;
  }

  /** A member rewrites a claim: it now rests on their words (the earlier sources stay recorded in the history). */
  updateClaim(id: string, userId: string, claimId: string, text: unknown): void {
    this.member(id, userId);
    const db = this.db(id);
    const { node_id, title } = this.#claimNode(db, id, claimId);
    const value = this.#text(text, KB_LIMITS.claim);
    tracked(db, { by: userId, kind: "edit", summary: title }, () => {
      const now = Date.now();
      db.prepare("UPDATE kb_claims SET text=?, certainty='user_said', updated_at=? WHERE id=?").run(value, now, claimId);
      db.prepare("DELETE FROM kb_cites WHERE item_id=?").run(claimId);
      this.#cite(db, id, userId, claimId, value, now);
      db.prepare("UPDATE kb_nodes SET updated_at=? WHERE id=?").run(now, node_id);
      reindexNode(db, node_id);
    });
  }

  deleteClaim(id: string, userId: string, claimId: string): void {
    this.member(id, userId);
    const db = this.db(id);
    const { node_id, title } = this.#claimNode(db, id, claimId);
    tracked(db, { by: userId, kind: "edit", summary: title }, () => {
      db.prepare("DELETE FROM kb_cites WHERE item_id=?").run(claimId);
      db.prepare("UPDATE kb_claims SET superseded_by=NULL WHERE superseded_by=?").run(claimId);
      db.prepare("DELETE FROM kb_claims WHERE id=?").run(claimId);
      db.prepare("UPDATE kb_nodes SET updated_at=? WHERE id=?").run(Date.now(), node_id);
      reindexNode(db, node_id);
    });
  }

  deleteNode(id: string, userId: string, nodeId: string): void {
    this.member(id, userId);
    const db = this.db(id);
    const title = (db.prepare("SELECT title FROM kb_nodes WHERE id=? AND owner_id=?").get(nodeId, id) as { title: string } | undefined)?.title;
    if (!title || !deleteKbNode(db, id, nodeId, userId, { by: userId, kind: "edit", summary: title })) throw new SharedKbError(404, "not_found", t().knowledge.notFound);
  }

  close(): void {
    for (const db of this.#dbs.values()) db.close();
    this.#dbs.clear();
  }
}
