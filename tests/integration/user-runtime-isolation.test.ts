import {it,expect} from 'vitest';
import {startHarness,login,rawUpgrade} from '../helpers/harness.js';
import {createMember} from '../../src/server/auth/owner.js';
import {memberWorkspacePrefix,workspaceConfig} from '../../src/server/auth/workspaceHost.js';
import {memberConfig,UserRuntimes} from '../../src/server/tenants.js';

it('binds workspace tickets, HTTP, WebSocket and API collaborators to the authenticated member by path, never owner',async()=>{
 const root=await startHarness(), member=await startHarness();
 try{
  const user=await createMember(root.ctx.db,'isolated-user','member-secret-123');
  member.ctx.db.prepare("INSERT INTO owners(id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,'member','x','x','{}',0)").run(user.id,user.username);
  member.ctx.sessions=root.ctx.sessions;member.ctx.tickets=root.ctx.tickets;
  const prefix=memberWorkspacePrefix(user.id);member.ctx.cfg={...member.ctx.cfg,...workspaceConfig(root.ctx.cfg),sandbox:member.ctx.cfg.sandbox};
  root.ctx.runtimeForUser=async id=>{if(id==='owner_1')return root.ctx;if(id===user.id)return member.ctx;throw Error('unknown');};
  const owner=await login(root);
  const ownerConv=root.ctx.agent.createConversation({title:'private owner conversation'});
  const m=root.ctx.sessions.create(user.id,'primary');
  const headers={cookie:`pa_session=${m.token}; pa_csrf=${m.csrfToken}`,'x-csrf-token':m.csrfToken,'content-type':'application/json'};
  const main=await root.request('/api/main',{headers});expect(main.status).toBe(200);expect(await main.text()).not.toContain(ownerConv.id);
  expect((await root.request('/api/conversations/'+ownerConv.id,{headers})).status).toBe(404);
  expect((await root.request('/api/settings',{headers})).status).toBe(403);
  await root.request('/api/sandbox/shell-sessions',{headers});
  expect(member.sandbox.requests.some(r=>r.url==='/v1/shell/sessions')).toBe(true);
  expect(root.sandbox.requests.some(r=>r.url==='/v1/shell/sessions')).toBe(false);

  // The member ticket points at the shared companion origin under the member's own path.
  const ticket=await root.request('/api/workspace/ticket',{method:'POST',headers,body:JSON.stringify({next:'/terminal'})});
  const link=new URL((await ticket.json() as {url:string}).url);
  expect(link.pathname).toBe(`${prefix}/_bootstrap`);
  expect(link.searchParams.get('next')).toBe(`${prefix}/terminal`);
  const boot=await root.request(link.pathname+link.search,{host:'workspace'});
  expect(boot.status).toBe(303);
  expect(boot.headers.get('location')).toBe(`${prefix}/terminal`);
  const cookies=boot.headers.getSetCookie().map(c=>c.split(';')[0]!).join('; ');
  const token=/pa_ws_session=([^;]+)/.exec(cookies)![1];
  expect(root.ctx.sessions.resolve('workspace',token)?.ownerId).toBe(user.id);

  // Prefixed requests reach the member sandbox with the prefix removed.
  expect((await root.request(`${prefix}/set-cookie`,{host:'workspace',headers:{cookie:cookies}})).status).toBe(200);
  // Absolute sub-resources without the prefix follow the workspace session's own account.
  expect((await root.request('/set-cookie?absolute=1',{host:'workspace',headers:{cookie:cookies}})).status).toBe(200);
  expect(member.sandbox.requests.filter(r=>r.url.startsWith('/set-cookie')).map(r=>r.url)).toEqual(['/set-cookie','/set-cookie?absolute=1']);
  expect(root.sandbox.requests.some(r=>r.url.startsWith('/set-cookie')||r.url.startsWith('/u/'))).toBe(false);
  const ws=await rawUpgrade(root.primaryPort,`${prefix}/v1/shell/ws`,{Host:`127.0.0.1:${root.primaryPort}`,Origin:`http://127.0.0.1:${root.primaryPort}`,Cookie:cookies,'Sec-WebSocket-Key':'isolation'});
  expect(ws.statusLine).toContain('101');
  expect((await root.request('/api/workspace/session',{host:'workspace',headers:{cookie:cookies}})).status).toBe(200);

  // Fail closed: another account's session never opens this member's path, and an unknown path is not found.
  const ownerWs=root.ctx.sessions.create('owner_1','workspace');
  expect((await root.request(`${prefix}/set-cookie`,{host:'workspace',headers:{cookie:`pa_ws_session=${ownerWs.token}`}})).status).toBe(401);
  expect((await root.request('/u/00000000000000000000/set-cookie',{host:'workspace',headers:{cookie:cookies}})).status).toBe(404);
  expect(member.sandbox.requests.filter(r=>r.url.startsWith('/set-cookie'))).toHaveLength(2);

  root.ctx.runtimeForUser=async id=>{if(id==='owner_1')return root.ctx;throw Error('failed');};
  expect((await root.request('/api/main',{headers})).status).toBe(503);
  expect((await root.request(`${prefix}/set-cookie`,{host:'workspace',headers:{cookie:cookies}})).status).toBe(503);
  expect((await root.request('/api/main',{headers:{cookie:owner.cookie}})).status).toBe(200);
 }finally{await member.shutdown();await root.shutdown();}
});

it('derives disjoint persistent data, volumes and networks, coalesces concurrent creation and denies unknown accounts',async()=>{
 const h=await startHarness();
 try{
  const u=await createMember(h.ctx.db,'independent-user','member-secret-123');
  const a=memberConfig(h.ctx.cfg,u.id,19001),b=memberConfig(h.ctx.cfg,'user_other',19002);
  for(const key of ['dbPath','dataDir','logDir'] as const)expect(a[key]).not.toBe(b[key]);
  for(const key of ['workspaceVolume','codexVolume','browserVolume','networkName','containerName','hostPort'] as const){expect(a.sandbox[key]).not.toBe(b.sandbox[key]);expect(a.sandbox[key]).not.toBe(h.ctx.cfg.sandbox[key]);}
  expect(a.memberRuntime).toBe(true);expect(a.bridge.models).toEqual(['deepseek-v4.1-flash']);
  let calls=0;
  const registry=new UserRuntimes(h.ctx,async opts=>{calls++;expect(opts?.identity?.id).toBe(u.id);return {ctx:h.ctx,db:h.ctx.db,shutdown:async()=>{}};});
  await Promise.all([registry.resolve(u.id),registry.resolve(u.id)]);expect(calls).toBe(1);
  expect(await registry.resolve('owner_1')).toBe(h.ctx);
  await expect(registry.resolve('user_unknown')).rejects.toThrow('Unknown account');
  await registry.shutdown();
 }finally{await h.shutdown();}
});
