import { afterAll, beforeAll, expect, it } from 'vitest';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';
import { createMember } from '../../src/control/auth/owner.js';

let h: TestHarness;
let owner: Record<string,string>, member: Record<string,string>, userId: string;
const json = {'content-type':'application/json'};
beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h); owner = {...json,cookie:auth.cookie,'x-csrf-token':auth.csrf};
  userId = (await createMember(h.ctx.db,'rating-member','member-password-123')).id;
  const res = await h.request('/api/auth/login',{method:'POST',headers:json,body:JSON.stringify({username:'rating-member',password:'member-password-123'})});
  const cookies = res.headers.getSetCookie();
  member = {...json,cookie:cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':decodeURIComponent(/pa_csrf=([^;]+)/.exec(cookies.join(';'))![1])};
  h.ctx.db.prepare('INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run('rated-conv',userId,'member',1,1);
  h.ctx.db.prepare('INSERT INTO tasks(id,client_message_id,conversation_id,title,input_text,result,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run('rated-task','rated-message','rated-conv','Reply title','private request','b'.repeat(25000),'completed',1);
});
afterAll(async () => { await h?.shutdown(); });
const vote = (body: unknown, headers = member, task = 'rated-task') => h.request(`/api/support/feedback/${task}`,{method:'PUT',headers,body:JSON.stringify(body)});
const row = () => h.ctx.db.prepare('SELECT rating,title,content,note FROM message_feedback WHERE owner_id=? AND task_id=?').get(userId,'rated-task');

it('keeps one vote per reply: 👍, then 👎 with a note and the reply, then taken back', async () => {
  expect(await (await vote({rating:'up'})).json()).toEqual({rating:'up'});
  expect(row()).toEqual({rating:'up',title:'Reply title',content:'',note:''});
  expect(await (await h.request('/api/support/feedback',{headers:member})).json()).toEqual({ratings:{'rated-task':'up'}});
  // A note is kept only with a 👎, and only then the reply itself, bounded.
  await vote({rating:'down',note:'  It misread the question.  '});
  expect(row()).toEqual({rating:'down',title:'Reply title',content:'b'.repeat(20000),note:'It misread the question.'});
  await vote({rating:'down'});
  expect(row()).toMatchObject({rating:'down',content:'',note:''});
  expect(await (await vote({rating:null})).json()).toEqual({rating:null});
  expect(row()).toBeUndefined();
  expect(await (await h.request('/api/support/feedback',{headers:member})).json()).toEqual({ratings:{}});
});

it('refuses another account\'s reply, an unknown rating and a request without CSRF', async () => {
  expect((await vote({rating:'up'},owner)).status).toBe(404);
  expect((await vote({rating:'great'})).status).toBe(400);
  expect((await vote({rating:'down',note:'x'.repeat(2001)})).status).toBe(400);
  expect((await vote({rating:'up'},{...json,cookie:member.cookie})).status).toBe(403);
  expect((await h.request('/api/support/feedback')).status).toBe(401);
});

it('only the owner reads every account\'s votes', async () => {
  await vote({rating:'down',note:'Too long.'});
  expect((await h.request('/api/settings/support/feedback',{headers:member})).status).toBe(403);
  const res = await h.request('/api/settings/support/feedback',{headers:owner});
  expect(res.status).toBe(200);
  expect((await res.json() as {feedback:unknown[]}).feedback).toEqual([expect.objectContaining({task_id:'rated-task',rating:'down',note:'Too long.',title:'Reply title',account_username:'rating-member'})]);
});
