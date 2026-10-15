#!/usr/bin/env node
// Local administrator command: post a support card (a fix, an explanation, a redone file) into one
// account's main feed, and notify its phones. Runs only where the control data lives (inside the
// control container); there is no HTTP route to it. The Markdown body is read from stdin.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/control/config.js';
import { openDb } from '../dist/control/db.js';
import { userNamespace } from '../dist/control/auth/workspaceHost.js';
import { postSupportCard } from '../dist/control/tasks/support.js';
import { PushService, notificationText } from '../dist/control/push.js';
import { Logger } from '../dist/common/logger.js';

const usage = '用法: node bin/support-card.mjs <账号> --title <标题> [--id <幂等键>] [--no-push] < 正文.md';
const { positionals, values } = parseArgs({ allowPositionals: true, options: { title: { type: 'string' }, id: { type: 'string' }, 'no-push': { type: 'boolean' } } });
const [username] = positionals;
if (!username || positionals.length !== 1 || !values.title || process.stdin.isTTY) throw new Error(usage);
const body = fs.readFileSync(0, 'utf8');

const cfg = loadConfig();
const root = openDb(cfg.dbPath);
try {
  const user = root.prepare('SELECT id, role FROM owners WHERE username=?').get(username);
  if (!user) throw new Error(`账号 ${username} 不存在`);
  // The owner's tasks live in the root database; each member's in its own runtime database.
  const dbPath = user.role === 'owner' ? cfg.dbPath : path.join(cfg.dataDir, 'users', userNamespace(user.id), 'agent.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`账号 ${username} 还没有运行库（从未登录过）`);
  const db = user.role === 'owner' ? root : openDb(dbPath);
  let card;
  try { card = postSupportCard(db, { ownerId: user.id, title: values.title, body, key: values.id, cwd: cfg.sandbox.containerWorkspaceDir }); }
  finally { if (db !== root) db.close(); }
  let sent = 0;
  if (!card.duplicate && !values['no-push']) {
    const push = new PushService({ db: root, log: new Logger('warn'), keyFile: path.join(cfg.dataDir, 'vapid.json'), subject: `https://${cfg.primaryHost}` });
    sent = await push.notify(user.id, { title: `客服消息：${values.title.trim()}`, body: notificationText(body, 120), tag: card.taskId });
  }
  console.log(JSON.stringify({ account: username, ...card, pushed: sent }));
} finally { root.close(); }
