import { randomId } from "../auth/passwords.js";
import type { Db } from "../db.js";

/**
 * Support cards: a message from the people running this deployment (a fix, an
 * explanation, a redone file) placed in one account's main feed as a finished
 * task, so it reads like any answer and can be quoted for a follow-up. Nobody
 * typed it, so the console shows a support note instead of the person's message.
 *
 * Only the local operator posts one: `bin/support-card.mjs`, run inside the
 * control container. There is no HTTP route to it.
 */
export const SUPPORT_PREFIX = "support:";
export const SUPPORT_LIMITS = { title: 60, body: 20_000, key: 120 };

export interface SupportCardInput {
  ownerId: string;
  title: string;
  /** Markdown; workspace images (`![...](/home/gem/workspace/...)`) render from the account's own workspace. */
  body: string;
  /** A key for this card: posting again with the same key returns the card already there. */
  key?: string;
  /** The account's workspace directory, the cwd of a follow-up's executor session. */
  cwd: string;
  now?: number;
}

export function isSupportCard(clientMessageId: string): boolean {
  return clientMessageId.startsWith(SUPPORT_PREFIX);
}

/** Write the card into the account's runtime database. */
export function postSupportCard(db: Db, input: SupportCardInput): { taskId: string; conversationId: string; duplicate: boolean } {
  const title = input.title.trim(), body = input.body.trim(), key = (input.key ?? randomId("card")).trim();
  if (!title || [...title].length > SUPPORT_LIMITS.title) throw new Error(`标题需为 1–${SUPPORT_LIMITS.title} 个字`);
  if (!body || body.length > SUPPORT_LIMITS.body) throw new Error(`正文需为 1–${SUPPORT_LIMITS.body} 个字符`);
  if (!/^[A-Za-z0-9_.:-]+$/.test(key) || key.length > SUPPORT_LIMITS.key) throw new Error("--id 只能用字母、数字和 _ . : -");
  const clientMessageId = SUPPORT_PREFIX + key;
  const existing = db.prepare("SELECT t.id, t.conversation_id, c.owner_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.client_message_id=?").get(clientMessageId) as
    | { id: string; conversation_id: string; owner_id: string }
    | undefined;
  if (existing) {
    if (existing.owner_id !== input.ownerId) throw new Error("这个 --id 已用于另一个账号");
    return { taskId: existing.id, conversationId: existing.conversation_id, duplicate: true };
  }
  // A follow-up that quotes the card reads its plan; nothing is dispatched for the card itself.
  const plan = { title, description: null, related: [], dependencies: [], resources: [], appendTo: null, resume: null, decision: { kind: "new" }, clarification: null };
  const taskId = randomId("task"), conversationId = randomId("conv");
  db.exec("BEGIN IMMEDIATE");
  try {
    const last = db.prepare("SELECT MAX(created_at) AS n FROM tasks").get() as { n: number | null };
    // Strictly after everything already in the feed, as a submitted task is.
    const now = Math.max(input.now ?? Date.now(), (last.n ?? 0) + 1);
    db.prepare("INSERT INTO conversations (id, owner_id, title, model, cwd, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'idle', ?, ?)")
      .run(conversationId, input.ownerId, title, input.cwd, now, now);
    db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,attachments_json,status,plan_json,result,created_at,completed_at) VALUES (?,?,?,?,'','[]','completed',?,?,?,?)")
      .run(taskId, clientMessageId, conversationId, title, JSON.stringify(plan), body, now, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { taskId, conversationId, duplicate: false };
}
