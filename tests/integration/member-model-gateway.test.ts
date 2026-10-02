import {it,expect} from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {startHarness} from '../helpers/harness.js';
import {MemberModelGateway} from '../../src/control/memberModelGateway.js';
import {memberConfig} from '../../src/control/tenants.js';
it('exposes only stateless high-effort DeepSeek, never the bridge master key or response lookup',async()=>{
 const h=await startHarness();let body:any,auth:string|undefined;
 const upstream=http.createServer(async(req,res)=>{auth=req.headers.authorization;let data='';for await(const chunk of req)data+=chunk;body=JSON.parse(data);res.setHeader('content-type','text/event-stream');res.end('data: {"ok":true}\n\n');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const file=path.join(h.dataDir,'bridge-key');fs.writeFileSync(file,'LITELLM_MASTER_KEY=master-private-key\n',{mode:0o600});
 const cfg={...h.ctx.cfg,memberModelPort:0,bridge:{...h.ctx.cfg.bridge,enabled:'on',secretsFile:file,baseUrl:`http://host.docker.internal:${(upstream.address() as any).port}/v1`,upstreamUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`}};
 const gateway=new MemberModelGateway(cfg,h.ctx.log);await gateway.start();
 try{
  const a=memberConfig(cfg,'user_alpha',18082),b=memberConfig(cfg,'user_beta',18083);gateway.provision(a);gateway.provision(b);
  const token=fs.readFileSync(path.join(a.dataDir,'model-token'),'utf8');
  expect(fs.readFileSync(a.bridge.secretsFile,'utf8')).not.toContain('master-private-key');
  const url=`http://127.0.0.1:${gateway.port}/u/user_alpha/v1/responses`;
  const post=(data:any,credential=token,target=url)=>fetch(target,{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify(data)});
  expect((await post({},'é'.repeat(64))).status).toBe(403);
  expect((await post({},token,url.replace('user_alpha','user_beta'))).status).toBe(403);
  expect((await fetch(url+'/another-response',{headers:{authorization:`Bearer ${token}`}})).status).toBe(403);
  expect((await post({previous_response_id:'owner-response'})).status).toBe(400);
  const r=await post({model:'gpt-6-sol',reasoning:{effort:'low'},store:true,input:'hi',stream:true});
  expect(r.status).toBe(200);expect(await r.text()).toContain('"ok":true');
  expect(body).toMatchObject({model:'deepseek-v4.1-flash',reasoning:{effort:'high'},store:false});
  expect(auth).toBe('Bearer master-private-key');
 }finally{gateway.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await h.shutdown();}
});
it('forwards only a Claude-assigned member to the Messages API on its model, adding the owner credential on the host',async()=>{
 const h=await startHarness();const seen:any[]=[];
 const upstream=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;seen.push({url:req.url,headers:req.headers,body:JSON.parse(data)});res.setHeader('content-type','text/event-stream');res.end('event: message_stop\ndata: {}\n\n');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const owner=path.join(h.dataDir,'claude-code.env');fs.writeFileSync(owner,'CLAUDE_CODE_OAUTH_TOKEN=owner-oauth-secret\n',{mode:0o600});
 const saved=process.env.CLAUDE_CODE_OAUTH_TOKEN;delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
 const cfg={...h.ctx.cfg,memberModelPort:0,claudeCode:{...h.ctx.cfg.claudeCode,enabled:'auto',secretsFile:owner,apiBaseUrl:`http://127.0.0.1:${(upstream.address() as any).port}`}};
 const gateway=new MemberModelGateway(cfg,h.ctx.log);await gateway.start();
 try{
  const a=memberConfig(cfg,'user_alpha',18082,'claude-sonnet-5-5'),b=memberConfig(cfg,'user_beta',18083);gateway.provision(a);gateway.provision(b);
  const token=fs.readFileSync(path.join(a.dataDir,'model-token'),'utf8'),other=fs.readFileSync(path.join(b.dataDir,'model-token'),'utf8');
  // The member sandbox gets its own token and the gateway address, never the owner's credential.
  expect(a.claudeCode.gatewayUrl).toBe(`http://host.docker.internal:${cfg.memberModelPort}/u/user_alpha/anthropic`);
  expect(fs.readFileSync(a.claudeCode.secretsFile,'utf8')).toBe(`ANTHROPIC_AUTH_TOKEN=${token}\n`);
  expect(b.claudeCode.gatewayUrl).toBeUndefined();
  const url=`http://127.0.0.1:${gateway.port}/u/user_alpha/anthropic/v1/messages?beta=true`;
  const post=(credential:string,target=url,data:any={model:'claude-fable-5-1',max_tokens:8,messages:[]})=>fetch(target,{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'claude-code-20250219'},body:JSON.stringify(data)});
  expect((await post(other)).status).toBe(403);
  // A member on DeepSeek has no Claude route even with its own valid token.
  expect((await post(other,url.replace('user_alpha','user_beta'))).status).toBe(403);
  expect((await post(token,url.replace('/v1/messages','/v1/messages/batches'))).status).toBe(403);
  expect((await post(token,url.replace('/anthropic/v1/messages?beta=true','/anthropic/v1/models'))).status).toBe(403);
  expect(seen).toHaveLength(0);
  const r=await post(token);
  expect(r.status).toBe(200);expect(await r.text()).toContain('message_stop');
  const count=await post(token,url.replace('/v1/messages','/v1/messages/count_tokens'));expect(count.status).toBe(200);
  expect(seen.map(s=>s.url)).toEqual(['/v1/messages?beta=true','/v1/messages/count_tokens?beta=true']);
  for(const s of seen){
   expect(s.body.model).toBe('claude-sonnet-5-5');
   expect(s.headers.authorization).toBe('Bearer owner-oauth-secret');
   expect(s.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20');
  }
 }finally{if(saved!==undefined)process.env.CLAUDE_CODE_OAUTH_TOKEN=saved;gateway.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await h.shutdown();}
});
