import { afterAll, beforeAll, expect, it } from 'vitest';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';
import { createMember } from '../../src/control/auth/owner.js';
import { openDb } from '../../src/control/db.js';
import { createSupportRequest, supportQueue } from '../../src/control/support.js';
let h: TestHarness;
let owner: Record<string,string>, member: Record<string,string>, userId: string;
const json = {'content-type':'application/json'};
beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h); owner = {...json,cookie:auth.cookie,'x-csrf-token':auth.csrf};
  userId = (await createMember(h.ctx.db,'support-member','member-password-123')).id;
  const res = await h.request('/api/auth/login',{method:'POST',headers:json,body:JSON.stringify({username:'support-member',password:'member-password-123'})});
  const cookies = res.headers.getSetCookie();
  member = {...json,cookie:cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':decodeURIComponent(/pa_csrf=([^;]+)/.exec(cookies.join(';'))![1])};
});
afterAll(async () => { await h?.shutdown(); });
const send = (body: unknown, headers = member) => h.request('/api/support/requests',{method:'POST',headers,body:JSON.stringify(body)});
it('accepts an authenticated deletion request without deleting or revoking the account', async () => {
  const result = await send({kind:'deletion',note:'Delete my account and all associated data.'});
  expect(result.status).toBe(201);
  expect(h.ctx.db.prepare('SELECT id FROM owners WHERE id=?').get(userId)).toBeDefined();
  expect(await (await h.request('/api/auth/session',{headers:member})).json()).toMatchObject({authenticated:true});
  const {id} = await result.json() as {id:string};
  expect(h.ctx.db.prepare('SELECT owner_id,kind,status FROM support_requests WHERE id=?').get(id)).toMatchObject({owner_id:userId,kind:'deletion',status:'pending'});
});
it('requires CSRF for a signed-in request and denies other origins and companion host', async () => {
  const body = {kind:'deletion',note:'test'};
  expect((await send(body,{...json,cookie:member.cookie})).status).toBe(403);
  expect((await send({...body,email:'a@example.com'},{...json,origin:'https://evil.example.com'})).status).toBe(403);
  expect((await h.request('/api/support/requests',{host:'workspace',method:'POST',headers:json,body:JSON.stringify({...body,email:'a@example.com'})})).status).toBe(404);
});
it('allows an external request without revealing whether the account exists, then rate limits', async () => {
  for (let i=0;i<4;i++) {
    const res = await send({kind:'deletion',email:'requester@example.com',username:'does-not-exist',note:'Please verify my identity.'},json);
    expect(res.status).toBe(201); expect(await res.json()).toEqual({id:expect.any(String)});
  }
  expect((await send({kind:'privacy',email:'requester@example.com',note:'question'},json)).status).toBe(429);
});
it('only the owner can read and record support outcomes', async () => {
  expect((await h.request('/api/settings/support',{headers:member})).status).toBe(403);
  expect((await h.request('/api/settings/support')).status).toBe(401);
  const res = await h.request('/api/settings/support',{headers:owner}); expect(res.status).toBe(200);
  const rows = (await res.json() as {requests:Array<{id:string}>}).requests; expect(rows.length).toBeGreaterThan(0);
  const id = rows[0].id;
  expect((await h.request(`/api/settings/support/${id}/review`,{method:'POST',headers:member,body:JSON.stringify({decision:'pretend processed'})})).status).toBe(403);
  expect((await h.request(`/api/settings/support/${id}/review`,{method:'POST',headers:owner,body:'{}'})).status).toBe(400);
  expect((await h.request(`/api/settings/support/${id}/review`,{method:'POST',headers:owner,body:JSON.stringify({decision:'Identity verification requested; deletion not yet completed.'})})).status).toBe(200);
});
it('validates report ownership in a separate member ledger, ignores client supplied reply content, and bounds the snapshot', async () => {
  const ledger = openDb(':memory:');
  try {
    ledger.prepare('INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run('member-conv',userId,'member',1,1);
    ledger.prepare('INSERT INTO tasks(id,client_message_id,conversation_id,title,input_text,result,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run('member-task','member-message','member-conv','Reply title','private request','a'.repeat(25000),'completed',1);
    expect(() => createSupportRequest(h.ctx.db,'owner_1',{kind:'content',taskId:'member-task',note:'cross-account'},Date.now(),ledger)).toThrow('未找到');
    const id = createSupportRequest(h.ctx.db,userId,{kind:'content',taskId:'member-task',note:'Unsafe content',content:'forged reply'},Date.now(),ledger);
    const row = supportQueue(h.ctx.db).find(r=>r.id===id)!;
    expect(row.content).toBe('a'.repeat(20000)); expect(JSON.stringify(row)).not.toContain('private request');
    expect(() => createSupportRequest(h.ctx.db,null,{kind:'content',email:'a@example.com',note:'test'},Date.now(),ledger)).toThrow('请先登录');
  } finally { ledger.close(); }
});
it('routes member reports to their ledger while keeping the review queue at central authentication', async () => {
  const ledger = openDb(':memory:');
  const previous = h.ctx.runtimeForUser;
  try {
    ledger.prepare('INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run('isolated-conv',userId,'member',1,1);
    ledger.prepare('INSERT INTO tasks(id,client_message_id,conversation_id,title,input_text,result,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run('isolated-task','isolated-message','isolated-conv','Isolated reply','question','isolated member reply','completed',1);
    h.ctx.runtimeForUser = async id => { if(id === 'owner_1') return h.ctx; if(id === userId) return {...h.ctx,db:ledger}; throw new Error('unknown account'); };
    const res = await send({kind:'content',taskId:'isolated-task',note:'Test report for moderation.'});
    expect(res.status).toBe(201);
    const {id} = await res.json() as {id:string};
    expect(h.ctx.db.prepare('SELECT content,owner_id FROM support_requests WHERE id=?').get(id)).toMatchObject({content:'isolated member reply',owner_id:userId});
    expect(ledger.prepare('SELECT COUNT(*) AS n FROM support_requests').get()).toMatchObject({n:0});
    expect((await h.request('/api/settings/support',{headers:member})).status).toBe(403);
    const rows = await (await h.request('/api/settings/support',{headers:owner})).text();
    expect(rows).toContain('isolated member reply');
    expect((await send({kind:'content',taskId:'missing',note:'cannot disclose another user'})).status).toBe(404);
  } finally { h.ctx.runtimeForUser = previous; ledger.close(); }
});
it('keeps older pending requests visible when the reviewed history exceeds the page limit', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO support_requests(id,kind,note,created_at) VALUES('old-pending','deletion','verify me',1)").run();
    const insert = db.prepare("INSERT INTO support_requests(id,kind,note,status,created_at) VALUES(?,'privacy','reviewed','reviewed',?)");
    for (let i=0;i<210;i++) insert.run('reviewed-'+i,100+i);
    expect(supportQueue(db)[0]).toMatchObject({id:'old-pending',status:'pending'});
  } finally { db.close(); }
});
