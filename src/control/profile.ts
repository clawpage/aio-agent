import type { Db } from "./db.js";
import type { AppContext } from "./context.js";
import { randomId } from "./auth/passwords.js";
import { readLocale } from "./locale.js";
import { runInLocale, t } from "./i18n/index.js";
import { deleteKbNode, reindexNode, sensitiveReason, sha256 } from "./taskKb/kernel.js";

/**
 * What a person tells about themselves (docs/FEATURES.md「个人资料」): every field optional, kept in
 * the central database (`profiles`). The executor never gets it pasted into a prompt: a copy is one
 * node of the account's personal knowledge base (domain `profile`), found with kb_search when it
 * matters, and rewritten in place whenever the profile changes.
 */

export const PROFILE_FIELDS = ["nickname", "preferredName", "location", "language", "occupation", "interests", "notes"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type Profile = Record<ProfileField, string>;

/** At most this many characters each; a knowledge base claim holds up to 400. */
export const PROFILE_LIMITS: Record<ProfileField, number> = { nickname: 40, preferredName: 40, location: 80, language: 60, occupation: 80, interests: 300, notes: 400 };

const COLUMNS: Record<ProfileField, string> = { nickname: "nickname", preferredName: "preferred_name", location: "location", language: "language", occupation: "occupation", interests: "interests", notes: "notes" };

/** The knowledge base domain the profile's node lives in. */
export const PROFILE_DOMAIN = "profile";
const PROFILE_DOMAIN_DESCRIPTION = "The person's own profile, as they wrote it in the console's settings (nickname, how to address them, location or time zone, languages, occupation, interests, preferences)";
/** Which node holds the copy, and what it was made from (in the account's own database). */
const NODE_KEY = "profile.kb_node";
const HASH_KEY = "profile.kb_hash";

export class ProfileError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface ProfileState { profile: Profile; onboarding: boolean }

const chars = (s: string) => [...s].length;

type Row = Record<string, string | number | null>;
const rowOf = (db: Db, userId: string) => db.prepare("SELECT * FROM profiles WHERE owner_id=?").get(userId) as Row | undefined;
const profileOf = (row: Row | undefined): Profile =>
  Object.fromEntries(PROFILE_FIELDS.map((f) => [f, row ? String(row[COLUMNS[f]] ?? "") : ""])) as Profile;

export function readProfile(db: Db, userId: string): ProfileState {
  const row = rowOf(db, userId);
  return { profile: profileOf(row), onboarding: row?.onboarding === 1 };
}

/** Whether the account still has the first step after registering ahead of it. */
export function onboardingPending(db: Db, userId: string): boolean {
  return rowOf(db, userId)?.onboarding === 1;
}

/** A new account: its first step asks for a profile. */
export function startOnboarding(db: Db, userId: string, now = Date.now()): void {
  db.prepare("INSERT INTO profiles (owner_id, onboarding, updated_at) VALUES (?,1,?) ON CONFLICT(owner_id) DO NOTHING").run(userId, now);
}

/** The first step is over (saved or skipped): it never comes back. */
export function finishOnboarding(db: Db, userId: string, now = Date.now()): void {
  db.prepare("INSERT INTO profiles (owner_id, onboarding, updated_at) VALUES (?,0,?) ON CONFLICT(owner_id) DO UPDATE SET onboarding=0").run(userId, now);
}

/** One field as given: trimmed, without control characters; the free text keeps its line breaks. */
function field(name: ProfileField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ProfileError(400, "bad_request", t().http.profile.invalid);
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");
  const v = (name === "notes" ? text.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ")).trim();
  if (chars(v) > PROFILE_LIMITS[name]) throw new ProfileError(400, "too_long", t().http.profile.tooLong(t().http.profile.fields[name], PROFILE_LIMITS[name]));
  if (sensitiveReason(v)) throw new ProfileError(400, "sensitive", t().http.profile.sensitive);
  return v;
}

/** Replace the whole profile (a field left out is empty); also ends the first step. */
export function saveProfile(db: Db, userId: string, input: unknown, now = Date.now()): Profile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProfileError(400, "bad_request", t().http.profile.invalid);
  const given = input as Record<string, unknown>;
  const profile = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, field(f, given[f])])) as Profile;
  const columns = PROFILE_FIELDS.map((f) => COLUMNS[f]);
  db.prepare(`INSERT INTO profiles (owner_id, ${columns.join(", ")}, onboarding, updated_at) VALUES (?, ${columns.map(() => "?").join(", ")}, 0, ?)
    ON CONFLICT(owner_id) DO UPDATE SET ${columns.map((c) => `${c}=excluded.${c}`).join(", ")}, onboarding=0, updated_at=excluded.updated_at`)
    .run(userId, ...PROFILE_FIELDS.map((f) => profile[f]), now);
  return profile;
}

/**
 * A new account's runtime (its sandbox container, browser and agent session) starts while the person
 * fills in the first step; nothing on screen says so (a failure shows up, as always, when they use it).
 */
export function warmNewAccount(context: Pick<AppContext, "runtimeForUser" | "log">, userId: string): void {
  context.runtimeForUser?.(userId).catch((err: unknown) => context.log.warn("new account's runtime not prepared", { error: err instanceof Error ? err.message : String(err) }));
}

/** The account's public id: a UUID, the same on every clawpage it signs in to (owners.public_id). */
export function publicIdOf(db: Db, userId: string): string | null {
  return (db.prepare("SELECT public_id FROM owners WHERE id=?").get(userId) as { public_id: string | null } | undefined)?.public_id ?? null;
}

/**
 * Who an account is to a clawpage it signs in to: its public id and its nickname, or without one a
 * name made from that id ("Clawpage user 3F2A"), so neither its username nor its email ever reaches a page.
 */
export function pageIdentity(db: Db, userId: string): { id: string; name: string } | null {
  const id = publicIdOf(db, userId);
  if (!id) return null;
  const nickname = (db.prepare("SELECT nickname FROM profiles WHERE owner_id=?").get(userId) as { nickname: string } | undefined)?.nickname;
  return { id, name: nickname || t().http.profile.anonymous(id.slice(0, 4).toUpperCase()) };
}

/**
 * Keep the account's knowledge base copy of its profile: one node, its claims rewritten in place
 * (never added to), gone when the profile is empty. Written in the account's language, naming it by
 * its username as every knowledge base entry does. Skipped when nothing changed since the last copy,
 * so a person who deleted the node on the knowledge page keeps it deleted until they edit the profile.
 * Returns whether it wrote anything.
 */
export function syncProfileMemory(central: Db, accountDb: Db, userId: string, now = Date.now()): boolean {
  const username = (central.prepare("SELECT username FROM owners WHERE id=?").get(userId) as { username: string } | undefined)?.username;
  if (!username) return false;
  const { profile } = readProfile(central, userId);
  return runInLocale(readLocale(accountDb), () => {
    const m = t().http.profile.memory;
    const claims = PROFILE_FIELDS.filter((f) => profile[f]).map((f) => m.claims[f](username, profile[f].replace(/\s+/g, " ")));
    const hash = sha256(JSON.stringify([m.title(username), claims]));
    const meta = (key: string) => (accountDb.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
    const setMeta = (key: string, value: string) => accountDb.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
    if (meta(HASH_KEY) === hash) return false;
    const existing = meta(NODE_KEY);
    const node = existing && (accountDb.prepare("SELECT id FROM kb_nodes WHERE id=? AND owner_id=? AND status='active'").get(existing, userId) as { id: string } | undefined)?.id;
    if (!claims.length) {
      if (node) deleteKbNode(accountDb, userId, node, userId);
      setMeta(HASH_KEY, hash);
      return Boolean(node);
    }
    accountDb.exec("BEGIN IMMEDIATE");
    try {
      const id = node || randomId("kbn");
      accountDb.prepare("INSERT OR IGNORE INTO kb_domains (owner_id, name, description, created_at) VALUES (?,?,?,?)").run(userId, PROFILE_DOMAIN, PROFILE_DOMAIN_DESCRIPTION, now);
      if (node) {
        // Only the claims this copy wrote (cited to the person's own words); anything the maintainer added stays.
        const own = accountDb.prepare(`SELECT DISTINCT c.id FROM kb_claims c JOIN kb_cites x ON x.item_id=c.id JOIN kb_sources s ON s.id=x.source_id
          WHERE c.node_id=? AND s.kind='manual'`).all(id) as Array<{ id: string }>;
        for (const c of own) {
          accountDb.prepare("DELETE FROM kb_cites WHERE item_id=?").run(c.id);
          accountDb.prepare("UPDATE kb_claims SET superseded_by=NULL WHERE superseded_by=?").run(c.id);
          accountDb.prepare("DELETE FROM kb_claims WHERE id=?").run(c.id);
        }
        accountDb.prepare("DELETE FROM kb_sources WHERE owner_id=? AND kind='manual' AND id NOT IN (SELECT source_id FROM kb_cites)").run(userId);
        accountDb.prepare("UPDATE kb_nodes SET title=?, summary=?, domain=?, updated_at=? WHERE id=?").run(m.title(username), m.summary(username), PROFILE_DOMAIN, now, id);
      } else {
        accountDb.prepare("INSERT INTO kb_nodes (id, owner_id, kind, domain, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(id, userId, "entity", PROFILE_DOMAIN, m.title(username), m.summary(username), now, now);
      }
      for (const text of claims) {
        const claim = randomId("kbc"), source = randomId("kbs");
        accountDb.prepare("INSERT INTO kb_claims (id, node_id, text, certainty, volatility, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(claim, id, text, "user_said", "stable", now, now);
        accountDb.prepare("INSERT INTO kb_sources (id, owner_id, task_id, path, url, sha256, excerpt, captured_at, kind, contributor) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(source, userId, "", null, null, null, text, now, "manual", userId);
        accountDb.prepare("INSERT INTO kb_cites (item_id, source_id) VALUES (?,?)").run(claim, source);
      }
      accountDb.prepare("INSERT INTO kb_revisions (owner_id, packets, object_id, op, detail_json, at) VALUES (?,?,?,?,?,?)").run(userId, "", id, "profile", JSON.stringify({ claims: claims.length }), now);
      reindexNode(accountDb, id);
      setMeta(NODE_KEY, id);
      setMeta(HASH_KEY, hash);
      accountDb.exec("COMMIT");
    } catch (err) {
      accountDb.exec("ROLLBACK");
      throw err;
    }
    return true;
  });
}
