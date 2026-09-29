#!/usr/bin/env node
// Local administrator command. Never accepts or prints plaintext passwords.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/server/config.js';
import { openDb } from '../dist/server/db.js';
import { createMember } from '../dist/server/auth/owner.js';
import { generateSecret } from '../dist/server/auth/passwords.js';

const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_-]{2,40}$/.test(username) || username === 'owner') throw new Error('用法: node bin/create-user.mjs <普通用户账号>');
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
try {
  if (db.prepare('SELECT 1 FROM owners WHERE username=?').get(username)) throw new Error('账号已存在；不会重置密码');
  const dir = path.join(cfg.dataDir, 'user-secrets');
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const file = path.join(dir, `${username}.txt`);
  const password = generateSecret(24);
  fs.writeFileSync(file, password + '\n', {flag:'wx',mode:0o600});
  try { await createMember(db, username, password); }
  catch (err) { fs.unlinkSync(file); throw err; }
  console.log(`已创建普通用户 ${username}；密码保存在 ${file}（0600）`);
} finally { db.close(); }
