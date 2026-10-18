#!/usr/bin/env node
// Re-runs the recognizer on the voice inputs kept by PA_VOICE_LOG_USERS (src/control/voiceLog.ts)
// and compares what it hears now with what it heard then, and with "expected" where someone wrote it
// into a record's JSON. Usage (compose: docker exec aio-control-1 node bin/voice-replay.mjs ...):
//   node bin/voice-replay.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--user NAME] [--limit N]
//                             [--asr URL]... [--polish] [--out report.json]
// Without --asr it uses PA_ASR_URL. --polish also runs the polisher on what each recognizer heard,
// with the vocabulary that recognizer answers with, as /api/asr does.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/control/config.js';
import { Logger } from '../dist/common/logger.js';
import { Dictation } from '../dist/control/dictation.js';

const { values: opt } = parseArgs({ options: {
  since: { type: 'string' }, until: { type: 'string' }, user: { type: 'string' }, limit: { type: 'string' },
  asr: { type: 'string', multiple: true }, polish: { type: 'boolean' }, out: { type: 'string' }, dir: { type: 'string' },
} });
const cfg = loadConfig();
const dir = opt.dir ?? cfg.voiceLog.dir;
const urls = opt.asr?.length ? opt.asr : [cfg.asrUrl].filter(Boolean);
if (!urls.length) throw new Error('没有识别服务：用 --asr 指定，或配置 PA_ASR_URL');
const dictation = opt.polish ? new Dictation(cfg, new Logger('warn')) : null;

/** Characters that count: letters and digits, case-folded; punctuation and spaces are the polisher's business. */
const norm = (s) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function cer(hyp, ref) {
  const a = [...norm(hyp)], b = [...norm(ref)];
  if (!b.length) return a.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / b.length;
}

const days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
const records = [];
for (const day of days) {
  if ((opt.since && day < opt.since) || (opt.until && day > opt.until)) continue;
  for (const f of fs.readdirSync(path.join(dir, day)).filter((f) => f.endsWith('.json')).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, day, f), 'utf8'));
    if (opt.user && meta.user !== opt.user) continue;
    records.push({ meta, wav: path.join(dir, day, f.replace(/\.json$/, '.wav')) });
  }
}
if (opt.limit) records.splice(0, Math.max(0, records.length - Number(opt.limit)));
if (!records.length) { console.log(`${dir} 里没有符合条件的录音`); process.exit(0); }

const report = [];
const stats = urls.map((url) => ({ url, ms: [], changed: 0, cer: [], polishedCer: [], model: null }));
for (const { meta, wav } of records) {
  const audio = fs.readFileSync(wav);
  const row = { id: meta.id, user: meta.user, seconds: meta.seconds, then: meta.asr?.text ?? null, thenPolished: meta.polish?.text ?? null, expected: meta.expected ?? null, now: [] };
  console.log(`\n${meta.id}  ${meta.seconds}s${meta.expected ? `\n  期望      ${meta.expected}` : ''}\n  当时识别  ${row.then ?? `（${meta.error ?? '无'}）`}${row.thenPolished ? `\n  当时润色  ${row.thenPolished}` : ''}`);
  for (const [i, url] of urls.entries()) {
    const s = stats[i];
    const started = Date.now();
    let text = null, model = null, error = null, polished = null, terms = [];
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      text = String(json.text ?? '').trim();
      model = json.model ?? null;
      if (Array.isArray(json.words)) terms = json.words.filter((w) => typeof w === 'string');
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
    const ms = Date.now() - started;
    if (text !== null) {
      s.ms.push(ms); s.model ??= model;
      if (text !== row.then) s.changed++;
      if (row.expected) s.cer.push(cer(text, row.expected));
      if (dictation && text) {
        polished = (await dictation.polish(text, { names: meta.user === 'owner' || cfg.kbMcp.members.includes(meta.user), terms })).text;
        if (row.expected) s.polishedCer.push(cer(polished, row.expected));
      }
    }
    row.now.push({ url, model, ms, text, polished, error });
    const tag = urls.length > 1 ? `#${i + 1}` : '现在';
    console.log(`  ${tag.padEnd(8)}  ${text ?? `（${error}）`}  ${ms}ms${row.expected && text !== null ? `  CER ${(cer(text, row.expected) * 100).toFixed(1)}%` : ''}${polished ? `\n  ${''.padEnd(8)}  → ${polished}` : ''}`);
  }
  report.push(row);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : NaN);
console.log(`\n共 ${records.length} 段录音`);
for (const [i, s] of stats.entries()) {
  console.log(`#${i + 1} ${s.url}${s.model ? ` (${s.model})` : ''}\n   耗时均值 ${mean(s.ms).toFixed(0)}ms，P90 ${p90(s.ms)}ms；与当时识别不同 ${s.changed} 段` +
    (s.cer.length ? `；有期望的 ${s.cer.length} 段 CER ${(mean(s.cer) * 100).toFixed(1)}%` : '') +
    (s.polishedCer.length ? `，润色后 ${(mean(s.polishedCer) * 100).toFixed(1)}%` : ''));
}
if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify({ urls, stats, records: report }, null, 2)); console.log(`报告：${opt.out}`); }
