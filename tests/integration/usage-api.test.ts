import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHarness, login, type TestHarness } from '../helpers/harness.js';
import { createMember } from '../../src/control/auth/owner.js';
import { UsageLedger } from '../../src/control/usage.js';
let h: TestHarness, owner: Record<string,string>, member: Record<string,string>;
beforeAll(async () => {
  h=await startHarness(); const auth=await login(h); owner={cookie:auth.cookie};
  await createMember(h.ctx.db,'member','member-password-123');
  const res=await h.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'member',password:'member-password-123'})});
  member={cookie:res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
});
afterAll(async () => { await h?.shutdown(); });
it('owner gets all accounts; member and anonymous cannot access aggregate statistics or start a runtime', async () => {
  h.ctx.runtimeForUser=vi.fn(async()=>{throw new Error('must not initialize a sandbox');});
  expect((await h.request('/api/usage')).status).toBe(401);
  for (const url of ['/api/usage','/api/USAGE/','/api/usage?userId=owner_1']) expect((await h.request(url,{headers:member})).status).toBe(403);
  const res=await h.request('/api/usage?days=7',{headers:owner});expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('no-store');
  const report=await res.json() as any;expect(report.days).toBe(7);expect(report.accounts.map((a:any)=>a.username)).toEqual(['owner','member']);
  expect(h.ctx.runtimeForUser).not.toHaveBeenCalled();
});
it('validates ranges and exposes only numeric counters, not prompts, thread ids or credentials', async () => {
  for(const days of ['0','-1','999','abc'])expect((await h.request(`/api/usage?days=${days}`,{headers:owner})).status).toBe(400);
  new UsageLedger(h.ctx.db).codex({threadId:'secret-thread',tokenUsage:{total:{inputTokens:25,outputTokens:5},last:{inputTokens:25,outputTokens:5}}});
  const res=await h.request('/api/usage?days=30',{headers:owner});const text=await res.text();
  expect(JSON.parse(text).accounts[0].totals).toMatchObject({input:25,output:5,total:30});expect(text).not.toMatch(/secret-thread|password|hash|salt|payload/);
});
