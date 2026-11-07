#!/usr/bin/env node
// Local administrator command: stop a member account (auth/suspension.ts), or lift that with --lift.
// Signing in and its sessions stop at once and its published pages go offline; its runtime (tasks,
// schedules) stops with the next service restart. Nothing of the account is deleted.
import { loadConfig } from '../dist/control/config.js';
import { openDb } from '../dist/control/db.js';
import { suspensionKey } from '../dist/control/auth/suspension.js';

const [username, flag] = process.argv.slice(2);
if (!username || (flag !== undefined && flag !== '--lift')) throw new Error('用法: node bin/suspend-user.mjs <普通用户账号> [--lift]');
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
try {
  const user = db.prepare("SELECT id FROM owners WHERE username=? AND role='member'").get(username);
  if (!user) throw new Error('普通用户不存在');
  if (flag === '--lift') {
    db.prepare('DELETE FROM meta WHERE key=?').run(suspensionKey(user.id));
    console.log(`已恢复 ${username}；重启服务后其运行环境重新启动`);
  } else {
    db.exec('BEGIN');
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(suspensionKey(user.id), String(Date.now()));
    const revoked = db.prepare('UPDATE sessions SET revoked_at=? WHERE owner_id=? AND revoked_at IS NULL').run(Date.now(), user.id).changes;
    db.exec('COMMIT');
    console.log(`已停用 ${username}，登出 ${revoked} 个会话；重启服务后其任务与定时任务不再运行`);
  }
} finally { db.close(); }
