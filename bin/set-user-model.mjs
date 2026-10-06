#!/usr/bin/env node
// Local administrator command: assign the one model a member runs, and optionally its reasoning effort. Takes effect on the next service restart.
import { loadConfig } from '../dist/control/config.js';
import { openDb } from '../dist/control/db.js';
import { MEMBER_EFFORTS, MEMBER_MODELS } from '../dist/control/auth/policy.js';

const [username, model, effort] = process.argv.slice(2);
if (!username || !MEMBER_MODELS.includes(model) || (effort !== undefined && !MEMBER_EFFORTS.includes(effort))) {
  throw new Error(`用法: node bin/set-user-model.mjs <普通用户账号> <${MEMBER_MODELS.join('|')}> [${MEMBER_EFFORTS.join('|')}]`);
}
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
try {
  const user = db.prepare("SELECT id FROM owners WHERE username=? AND role='member'").get(username);
  if (!user) throw new Error('普通用户不存在');
  const set = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  set.run(`member_model:${user.id}`, model);
  if (effort) set.run(`member_effort:${user.id}`, effort);
  console.log(`已将 ${username} 的模型设为 ${model}${effort ? `、推理强度 ${effort}` : ''}；重启服务后生效`);
} finally { db.close(); }
