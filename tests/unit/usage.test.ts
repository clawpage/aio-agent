import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/control/db.js';
import { UsageLedger, usageReport } from '../../src/control/usage.js';
import { testConfig } from '../helpers/harness.js';
import { userNamespace } from '../../src/control/auth/workspaceHost.js';

const stores: Db[] = [], dirs: string[] = [];
const db = (file = ':memory:') => { const value = openDb(file); stores.push(value); return value; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir,{recursive:true,force:true}); });
const user = (db: Db, id = 'owner_1', username = 'owner', role = 'owner') => db.prepare("INSERT INTO owners VALUES (?,?,?,'hash','salt','{}',0)").run(id,username,role);
const snapshot = (threadId: string, input: number, output: number, lastInput = input, cached = 0) => ({threadId,tokenUsage:{total:{inputTokens:input,outputTokens:output,cachedInputTokens:cached},last:{inputTokens:lastInput,outputTokens:output,cachedInputTokens:0}}});
const sum = (db: Db) => db.prepare('SELECT SUM(input) input,SUM(output) output,SUM(cached) cached,SUM(cache_write) cacheWrite FROM token_usage').get();

it('differences cumulative Codex snapshots across restarts, duplicate and delayed events', () => {
  const store = db(); const ledger = new UsageLedger(store);
  const first = snapshot('old-thread',1000,10,100);
  ledger.codex(first,1);ledger.codex(first,2);
  new UsageLedger(store).codex(snapshot('old-thread',1200,20,200,100),3);
  ledger.codex(first,4);ledger.codex(snapshot('old-thread',1200,20,200,100),5);
  expect(sum(store)).toMatchObject({input:300,output:20,cached:100});
  expect(store.prepare('SELECT COUNT(*) n FROM token_usage').get()).toMatchObject({n:2});
});
it('counts Claude cache reads and writes in input, whole-tree cumulative spend once on resume', () => {
  const store = db(), ledger = new UsageLedger(store);
  const result = (inputTokens: number, outputTokens: number) => ({modelUsage:{opus:{inputTokens,outputTokens,cacheReadInputTokens:100,cacheCreationInputTokens:20}}});
  ledger.claude(result(10,5),'session',false,1);
  ledger.claude(result(10,5),'session',false,2);
  new UsageLedger(store).claude(result(30,10),'session',true,3);
  expect(sum(store)).toMatchObject({input:150,output:10,cached:100,cacheWrite:20});
});
it('first observed Claude resume does not attribute old session totals to today', () => {
  const store=db(), ledger=new UsageLedger(store);
  const first={uuid:'result-1',usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:20},modelUsage:{sonnet:{inputTokens:10000,outputTokens:300,cacheReadInputTokens:1000}}};
  ledger.claude(first,'existing',true,1);ledger.claude(first,'existing',true,2);
  ledger.claude({modelUsage:{sonnet:{inputTokens:10010,outputTokens:305,cacheReadInputTokens:1020}}},'existing',true,3);
  expect(sum(store)).toMatchObject({input:60,output:8,cached:40});
});
it('fallback result usage deduplicates UUID, rejects malformed counters instead of guessing', () => {
  const store=db(), ledger=new UsageLedger(store);
  const result={uuid:'r',usage:{input_tokens:4,output_tokens:2,cache_creation_input_tokens:5}};
  ledger.claude(result,'s',false,1);ledger.claude(result,'s',false,2);
  ledger.codex({threadId:'bad',tokenUsage:{total:{inputTokens:-1,outputTokens:9}}});
  ledger.codex({threadId:'bad',tokenUsage:{total:{inputTokens:2,outputTokens:9,cachedInputTokens:8}}});
  ledger.claude({usage:{input_tokens:10,output_tokens:2}},'s',false);
  expect(sum(store)).toMatchObject({input:9,output:2,cacheWrite:5});
});
it('backfills only this account, with provider deltas and original timestamps; repeat is idempotent', () => {
  const store=db(); user(store);user(store,'other','other','member');
  store.prepare("INSERT INTO conversations (id,owner_id,title,created_at,updated_at) VALUES ('c','owner_1','private',0,0),('other','other','private',0,0)").run();
  const insert=store.prepare("INSERT INTO events(conversation_id,type,payload,created_at) VALUES (?,'thread/tokenUsage/updated',?,?)");
  insert.run('c',JSON.stringify(snapshot('t',100,3)),10);insert.run('c',JSON.stringify(snapshot('t',100,3)),11);insert.run('c',JSON.stringify(snapshot('t',150,5)),20);
  insert.run('other',JSON.stringify(snapshot('o',9000,90)),30);
  const ledger=new UsageLedger(store);ledger.backfill();new UsageLedger(store).backfill();
  expect(sum(store)).toMatchObject({input:150,output:5});
  expect(store.prepare('SELECT created_at FROM token_usage ORDER BY id').all()).toEqual([{created_at:10},{created_at:20}]);
});
it('aggregates all central account stores without initializing a runtime, partitions local days over DST', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-usage-'));dirs.push(dir);
  const root=db(), cfg=testConfig(dir,1);user(root);user(root,'m','member','member');user(root,'new','new','member');
  new UsageLedger(root).codex(snapshot('owner',100,4),Date.parse('2026-11-01T06:59:59Z')); // Oct 31 LA
  const member=db(path.join(dir,'users',userNamespace('m'),'agent.sqlite'));
  const ledger=new UsageLedger(member,'m');
  ledger.codex(snapshot('member',200,5),Date.parse('2026-11-01T07:00:00Z'));
  ledger.codex(snapshot('member',250,7),Date.parse('2026-11-02T07:59:59Z')); // still Nov 1
  const result=usageReport(root,cfg,7,Date.parse('2026-11-02T09:00:00Z'));
  expect(result.dates).toEqual(['2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01','2026-11-02']);
  expect(result.accounts.find(a=>a.username==='owner')!.days.find(d=>d.date==='2026-10-31')?.total).toBe(104);
  expect(result.accounts.find(a=>a.username==='member')!.days.find(d=>d.date==='2026-11-01')?.total).toBe(257);
  expect(result.accounts.find(a=>a.username==='new')!.totals.total).toBe(0);expect(result.accounts.find(a=>a.username==='new')!.collectionStartedAt).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/hash|salt|private|source_key/);
});
it('reads cold historical member stores in memory and reports corrupt stores as unavailable', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-usage-'));dirs.push(dir);const root=db(),cfg=testConfig(dir,1);user(root);user(root,'m','member','member');
  const file=path.join(dir,'users',userNamespace('m'),'agent.sqlite'),member=db(file);
  member.prepare("INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES ('c','m','secret',0,0)").run();
  member.prepare("INSERT INTO events(conversation_id,type,payload,created_at) VALUES ('c','thread/tokenUsage/updated',?,?)").run(JSON.stringify(snapshot('old',70,2)),Date.now()-100);
  expect(usageReport(root,cfg,7).accounts.find(a=>a.username==='member')!.totals.total).toBe(72);
  expect(member.prepare("SELECT name FROM sqlite_master WHERE name='token_usage'").get()).toBeUndefined();
  user(root,'corrupt','corrupt','member');const corrupt=path.join(dir,'users',userNamespace('corrupt'),'agent.sqlite');fs.mkdirSync(path.dirname(corrupt),{recursive:true});fs.writeFileSync(corrupt,'broken');
  expect(usageReport(root,cfg,7).accounts.find(a=>a.username==='corrupt')!.available).toBe(false);
});
