#!/usr/bin/env node
// Local administrator command. Never accepts or prints plaintext passwords.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/control/config.js';
import { openDb } from '../dist/control/db.js';
import { generateSecret, hashPassword } from '../dist/control/auth/passwords.js';
const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_-]{2,40}$/.test(username) || username === 'owner') throw new Error('用法: node bin/reset-user-password.mjs <普通用户账号>');
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
try {
  const user = db.prepare("SELECT id FROM owners WHERE username=? AND role='member'").get(username);
  if (!user) throw new Error('没有这个普通用户；owner 用 PA_OWNER_PASSWORD_RESET');
  const dir = path.join(cfg.dataDir, 'user-secrets');
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const file = path.join(dir, `${username}.txt`);
  const password = generateSecret(24);
  const rec = await hashPassword(password);
  // The new file replaces the old one only once it is complete.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, password + '\n', {flag:'wx',mode:0o600});
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE owners SET password_hash=?,password_salt=?,password_params=? WHERE id=?').run(rec.hash, rec.salt, rec.params, user.id);
    const revoked = db.prepare('UPDATE sessions SET revoked_at=? WHERE owner_id=? AND revoked_at IS NULL').run(Date.now(), user.id).changes;
    fs.renameSync(tmp, file);
    db.exec('COMMIT');
    console.log(`已重置普通用户 ${username} 的密码，登出 ${revoked} 个会话；新密码保存在 ${file}（0600）`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    fs.rmSync(tmp, {force:true});
    throw err;
  }
} finally { db.close(); }
