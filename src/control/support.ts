import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export class SupportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type SupportKind = 'content' | 'deletion' | 'privacy';
export function createSupportRequest(db: Db, userId: string | null, input: Record<string, unknown>, now = Date.now(), taskDb: Db = db): string {
  const kind = input.kind;
  if (!['content', 'deletion', 'privacy'].includes(String(kind))) throw new SupportError(400, 'bad_request', '请选择请求类型');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!note || note.length > 2000) throw new SupportError(400, 'bad_request', '请填写说明（最多 2000 字）');
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if ((!userId || email) && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) || username.length > 254)
    throw new SupportError(400, 'bad_request', '请填写可联系的邮箱和有效的账号');
  let title = '', content = '', taskId: string | null = null;
  if (kind === 'content') {
    if (!userId) throw new SupportError(401, 'unauthenticated', '请先登录');
    taskId = typeof input.taskId === 'string' ? input.taskId : '';
    const task = taskDb.prepare('SELECT t.title,t.result FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.owner_id=?').get(taskId, userId) as {title: string; result: string | null} | undefined;
    if (!task?.result) throw new SupportError(404, 'not_found', '未找到可举报的回复');
    title = task.title; content = task.result.slice(0, 20000);
  }
  if (userId) {
    const recent = db.prepare('SELECT COUNT(*) AS n FROM support_requests WHERE owner_id=? AND created_at>?').get(userId, now - 86400000) as {n: number};
    if (recent.n >= 20) throw new SupportError(429, 'rate_limited', '今日提交次数已达上限，请稍后重试');
  }
  const id = randomUUID();
  db.prepare('INSERT INTO support_requests(id,owner_id,kind,email,username,task_id,title,content,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, userId, kind as string, email, userId ? '' : username, taskId, title, content, note, now);
  return id;
}
export function supportQueue(db: Db) {
  return db.prepare(`SELECT s.*,o.username AS account_username,COALESCE(CASE WHEN o.email_placeholder=0 THEN o.email END,g.email) AS account_email FROM support_requests s LEFT JOIN owners o ON o.id=s.owner_id LEFT JOIN google_identities g ON g.owner_id=s.owner_id ORDER BY (s.status='pending') DESC,CASE WHEN s.status='pending' THEN s.created_at END ASC,s.created_at DESC LIMIT 200`).all();
}
export function reviewSupportRequest(db: Db, id: string, decision: unknown, now = Date.now()): void {
  if (typeof decision !== 'string' || !decision.trim() || decision.length > 2000) throw new SupportError(400, 'bad_request', '请记录核实情况和处理结果');
  const result = db.prepare("UPDATE support_requests SET status='reviewed',decision=?,reviewed_at=? WHERE id=?").run(decision.trim(), now, id);
  if (!result.changes) throw new SupportError(404, 'not_found', '请求不存在');
}
