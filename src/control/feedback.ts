import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { SupportError } from './support.js';
import { t } from './i18n/index.js';

/**
 * A person's 👍 / 👎 on one AI reply, kept centrally (`message_feedback`) for the owner to read.
 * One per account and task: voting again replaces it, `null` takes it back. A 👎 may carry a
 * note, and then keeps the reply itself (up to 20,000 characters) so the owner sees what it was
 * about; the dialog that takes the note says so. Reporting the reply stays a support request.
 */
export type Rating = 'up' | 'down';

export function setFeedback(db: Db, userId: string, taskId: string, input: Record<string, unknown>, taskDb: Db = db, now = Date.now()): Rating | null {
  const rating = input.rating;
  if (rating !== 'up' && rating !== 'down' && rating !== null) throw new SupportError(400, 'bad_request', t().http.support.feedbackRating);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 2000) throw new SupportError(400, 'bad_request', t().http.support.describe);
  const task = taskDb.prepare('SELECT t.title,t.result FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.owner_id=?').get(taskId, userId) as {title: string; result: string | null} | undefined;
  if (!task?.result) throw new SupportError(404, 'not_found', t().http.support.noReply);
  if (rating === null) { db.prepare('DELETE FROM message_feedback WHERE owner_id=? AND task_id=?').run(userId, taskId); return null; }
  const content = rating === 'down' && note ? task.result.slice(0, 20000) : '';
  db.prepare(`INSERT INTO message_feedback(id,owner_id,task_id,rating,title,content,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,task_id) DO UPDATE SET rating=excluded.rating,title=excluded.title,content=excluded.content,note=excluded.note,updated_at=excluded.updated_at`)
    .run(randomUUID(), userId, taskId, rating, task.title, content, rating === 'down' ? note : '', now, now);
  return rating;
}

/** The account's votes, by task, for the console to show which it gave. */
export function feedbackOf(db: Db, userId: string): Record<string, Rating> {
  const rows = db.prepare('SELECT task_id,rating FROM message_feedback WHERE owner_id=?').all(userId) as {task_id: string; rating: Rating}[];
  return Object.fromEntries(rows.map(r => [r.task_id, r.rating]));
}

/** The latest votes of every account, for the owner's support page. */
export function feedbackQueue(db: Db) {
  return db.prepare(`SELECT f.id,f.task_id,f.rating,f.title,f.content,f.note,f.updated_at,o.username AS account_username
    FROM message_feedback f LEFT JOIN owners o ON o.id=f.owner_id ORDER BY f.updated_at DESC LIMIT 200`).all() as
    {id: string; task_id: string; rating: Rating; title: string; content: string; note: string; updated_at: number; account_username: string | null}[];
}
