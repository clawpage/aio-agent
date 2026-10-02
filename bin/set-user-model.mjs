#!/usr/bin/env node
// Local administrator command: assign the one model a member runs. Takes effect on the next service restart.
import { loadConfig } from '../dist/control/config.js';
import { openDb } from '../dist/control/db.js';
import { MEMBER_MODELS } from '../dist/control/auth/policy.js';

const [username, model] = process.argv.slice(2);
if (!username || !MEMBER_MODELS.includes(model)) throw new Error(`用法: node bin/set-user-model.mjs <普通用户账号> <${MEMBER_MODELS.join('|')}>`);
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
try {
  const user = db.prepare("SELECT id FROM owners WHERE username=? AND role='member'").get(username);
  if (!user) throw new Error('普通用户不存在');
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`member_model:${user.id}`, model);
  console.log(`已将 ${username} 的模型设为 ${model}；重启服务后生效`);
} finally { db.close(); }
