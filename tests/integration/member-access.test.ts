import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';
import { createMember } from '../../src/server/auth/owner.js';
import {readSoul} from '../../src/server/soul.js';
import { MEMBER_MODEL } from '../../src/server/auth/policy.js';
let h:TestHarness, dir:string, userId:string;
let member:Record<string,string>, owner:Record<string,string>;
const planner=vi.fn(async(_prompt:string,_soul?:string,_model?:string)=>JSON.stringify({title:'处理请求',related:[],dependencies:[],resources:[]}));
beforeAll(async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-members-'));
 const secret=path.join(dir,'bridge.env');fs.writeFileSync(secret,'LITELLM_MASTER_KEY=test-member-key\n',{mode:0o600});
 h=await startHarness({PA_OPENCODE_GO_SECRETS_FILE:secret,PA_MAX_CONCURRENT_TURNS:'3'});
 Object.assign(h.codex,{planTask:planner});
 userId=(await createMember(h.ctx.db,'yzmy','member-password-123')).id;
 const res=await h.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'yzmy',password:'member-password-123'})});
 expect(res.status).toBe(200);expect(await res.json()).toMatchObject({username:'yzmy',role:'member'});
 const cookies=res.headers.getSetCookie().map(s=>s.split(';')[0]!);
 member={cookie:cookies.join('; '),'x-csrf-token':decodeURIComponent(cookies.find(s=>s.startsWith('pa_csrf='))!.slice(8)),'content-type':'application/json'};
 const auth=await login(h);owner={cookie:auth.cookie,'x-csrf-token':auth.csrf,'content-type':'application/json'};
});
afterAll(async()=>{await h?.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
const submit=async(headers:Record<string,string>,text:string,extra={})=>{
 const r=await h.request('/api/tasks',{method:'POST',headers,body:JSON.stringify({text,clientMessageId:text,...extra})});
 return {status:r.status,body:await r.json() as any};
};
it('authenticates the requested username and protects owner configuration',async()=>{
 const session=await h.request('/api/auth/session',{headers:member});expect(await session.json()).toMatchObject({username:'yzmy',role:'member'});
 const wrong=await h.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'member-password-123'})});expect(wrong.status).toBe(401);
 for(const url of ['/api/settings','/api/SETTINGS/','/api/Settings/Soul','/api/settings/soul','/api/settings/recall','/api/models','/api/capabilities','/api/sandbox/context']) {
  expect((await h.request(url,{headers:member})).status,url).toBe(403);
 }
 expect((await h.request('/api/settings',{method:'PUT',headers:member,body:JSON.stringify({model:'gpt-6-sol',effort:'low'})})).status).toBe(403);
 expect((await h.request('/api/settings/soul',{method:'PUT',headers:member,body:JSON.stringify({content:'override'})})).status).toBe(403);
 expect((await h.request('/api/settings',{headers:owner})).status).toBe(200);
 const recall=await h.request('/api/settings/recall?days=30',{headers:owner});expect(recall.status).toBe(200);expect(((await recall.json()) as {stats:{days:number;cap:number}}).stats).toMatchObject({days:30,cap:10});
 expect((await h.request('/api/status',{headers:member})).status).toBe(200);
});
it('isolates ledger reads, references, stops, events, replay IDs and planner context',async()=>{
 const a=await submit(owner,'owner-private-task');expect(a.status).toBe(202);
 await vi.waitFor(()=>expect(h.codex.startedTurns.length).toBe(1));
 await h.codex.runTurn(h.codex.startedTurns[0]!.turnId,{text:'owner private result'});
 const start=vi.spyOn(h.codex,'startThread');const resume=vi.spyOn(h.codex,'resumeThread');
 const b=await submit(member,'member-own-task',{model:'gpt-6-sol',effort:'low',userId:'owner_1'});expect(b.status).toBe(202);
 await vi.waitFor(()=>expect(h.codex.startedTurns.some(t=>t.model===MEMBER_MODEL), JSON.stringify(h.ctx.tasks.get(b.body.task.id))).toBe(true));
 const run=h.codex.startedTurns.find(t=>t.model===MEMBER_MODEL)!;expect(run.effort).toBe('high');expect(h.codex.threadProviders.get(run.threadId)).toBe('opencode_go');
 expect(start).toHaveBeenLastCalledWith(expect.objectContaining({developerInstructions:readSoul(h.ctx.cfg).content,model:MEMBER_MODEL}));
 const planned=planner.mock.calls.find(c=>c[2]===MEMBER_MODEL)!;expect(planned).toBeDefined();expect(planned[1]).toBe(readSoul(h.ctx.cfg).content);expect(planned[0]).not.toContain('owner-private-task');
 const feed=await h.request('/api/main',{headers:member});expect((await feed.json() as any).tasks.map((t:any)=>t.id)).toEqual([b.body.task.id]);
 const ownerFeed=await h.request('/api/main',{headers:owner});expect((await ownerFeed.json() as any).tasks.map((t:any)=>t.id)).not.toContain(b.body.task.id);
 for(const suffix of ['', '/events?format=json','/turns']) expect((await h.request(`/api/conversations/${a.body.task.conversationId}${suffix}`,{headers:member})).status).toBe(404);
 for(const suffix of ['stop','retry-planning']) expect((await h.request(`/api/tasks/${a.body.task.id}/${suffix}`,{method:'POST',headers:member,body:'{}'})).status).toBe(404);
 expect((await submit(member,'cross-ref',{relatedTaskId:a.body.task.id})).status).toBe(400);
 expect((await submit(member,'owner-private-task')).status).toBe(409);
 const detail=await h.request(`/api/conversations/${b.body.task.conversationId}`,{headers:member});expect(await detail.text()).not.toMatch(/"model"|"effort"|model_provider/);
 const events=await h.request(`/api/conversations/${b.body.task.conversationId}/events?format=json`,{headers:member});expect(await events.text()).not.toContain(MEMBER_MODEL);
 expect(h.ctx.agent.resolveSubmitSettings({conversationId:b.body.task.conversationId,text:'bypass',clientMessageId:'x',frozenSettings:{model:'gpt-6-sol',effort:'low'}})).toEqual({model:MEMBER_MODEL,effort:'high'});
 expect(h.ctx.db.prepare('SELECT owner_id FROM conversations WHERE id=?').get(b.body.task.conversationId)).toMatchObject({owner_id:userId});
 await h.codex.runTurn(run.turnId,{text:'member result'});
 const resumed=await submit(member,'resume-my-task',{relatedTaskId:b.body.task.id,model:'gpt-6-sol'});expect(resumed.status).toBe(202);
 await vi.waitFor(()=>expect(h.codex.startedTurns.length).toBe(3));
 expect(h.codex.startedTurns.at(-1)).toMatchObject({threadId:run.threadId,model:MEMBER_MODEL,effort:'high'});
 expect(h.codex.resumedThreads).toContain(run.threadId);
 expect(resume).toHaveBeenLastCalledWith(run.threadId,readSoul(h.ctx.cfg).content);
 expect(h.codex.titleCalls).toHaveLength(0);

});
it('fails closed when the fixed provider is unavailable instead of using GPT',async()=>{
 const disabled=await startHarness({PA_OPENCODE_GO_ENABLED:'off'});
 try {const user=await createMember(disabled.ctx.db,'member2','member-password-456');
 expect(()=>disabled.ctx.tasks.submit({userId:user.id,text:'hi',clientMessageId:'blocked'})).toThrow('服务暂时不可用');
 expect(disabled.codex.startedTurns).toHaveLength(0);
 } finally {await disabled.shutdown();}
});
