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
it('sends only a GPT-assigned member to ChatGPT on its model, adding the control plane login on the host',async()=>{
 const h=await startHarness();const seen:any[]=[];
 const upstream=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);seen.push({url:req.url,headers:req.headers,body});
  if(body.input==='expired'){res.writeHead(401).end();return;}
  res.setHeader('content-type','text/event-stream');res.end('data: {"type":"response.completed"}\n\n');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const port=(upstream.address() as any).port;
 const file=path.join(h.dataDir,'bridge-key');fs.writeFileSync(file,'LITELLM_MASTER_KEY=master-private-key\n',{mode:0o600});
 let loggedIn=true,invalidated=0;
 const hostTokens={getTokens:async()=>{if(!loggedIn)throw new Error('本部署未启用宿主 Codex 登录（PA_HOST_CODEX=off）');return {accessToken:'owner-chatgpt-access',chatgptAccountId:'acct_owner',planType:'pro',expiresAt:Date.now()+3600_000};},invalidate:()=>{invalidated++;}};
 const cfg={...h.ctx.cfg,memberModelPort:0,hostCodex:{...h.ctx.cfg.hostCodex,chatgptUrl:`http://127.0.0.1:${port}/backend-api/codex/`},
  bridge:{...h.ctx.cfg.bridge,enabled:'on',secretsFile:file,upstreamUrl:`http://127.0.0.1:${port}/v1`}};
 const gateway=new MemberModelGateway(cfg,h.ctx.log,undefined,undefined,undefined,undefined,hostTokens);await gateway.start();
 try{
  const a=memberConfig(cfg,'user_alpha',18082,'gpt-6.1-sol'),b=memberConfig(cfg,'user_beta',18083),c=memberConfig(cfg,'user_gamma',18084,'claude-sonnet-5-5');
  gateway.provision(a);gateway.provision(b);gateway.provision(c);
  const token=(m:typeof a)=>fs.readFileSync(path.join(m.dataDir,'model-token'),'utf8');
  // The member sandbox only ever gets its own gateway token and address.
  expect(a.bridge.models).toEqual(['gpt-6.1-sol']);
  expect(a.bridge.baseUrl).toBe(`http://host.docker.internal:${cfg.memberModelPort}/u/user_alpha/v1`);
  expect(a.claudeCode.gatewayUrl).toBeUndefined();
  for(const name of fs.readdirSync(a.dataDir))expect(fs.readFileSync(path.join(a.dataDir,name),'utf8')).not.toContain('owner-chatgpt-access');
  const url=(id:string)=>`http://127.0.0.1:${gateway.port}/u/${id}/v1/responses`;
  const post=(id:string,credential:string,data:any,extra:Record<string,string>={})=>fetch(url(id),{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json',...extra},body:JSON.stringify(data)});
  expect((await post('user_alpha',token(b),{})).status).toBe(403);
  expect((await post('user_alpha',token(a),{previous_response_id:'owner-response'})).status).toBe(400);
  expect((await fetch(`http://127.0.0.1:${gateway.port}/u/user_alpha/anthropic/v1/messages`,{method:'POST',headers:{authorization:`Bearer ${token(a)}`},body:'{}'})).status).toBe(403);
  expect(seen).toHaveLength(0);
  const r=await post('user_alpha',token(a),{model:'gpt-6-astra',reasoning:{effort:'max',context:'all_turns'},store:true,service_tier:'priority',input:'hi',stream:true},
   {originator:'personal-agent','session-id':'s1','x-codex-turn-metadata':'{"turn_id":"t1"}','x-openai-internal-codex-responses-lite':'true','x-openai-account-routing-override':'other-workspace',cookie:'x=1'});
  expect(r.status).toBe(200);expect(await r.text()).toContain('response.completed');
  expect(seen[0].url).toBe('/backend-api/codex/responses');
  expect(seen[0].body).toEqual({model:'gpt-6.1-sol',reasoning:{effort:'high',context:'all_turns'},store:false,input:'hi',stream:true});
  expect(seen[0].headers).toMatchObject({authorization:'Bearer owner-chatgpt-access','chatgpt-account-id':'acct_owner',originator:'personal-agent','session-id':'s1','x-codex-turn-metadata':'{"turn_id":"t1"}','x-openai-internal-codex-responses-lite':'true'});
  expect(seen[0].headers['x-openai-account-routing-override']).toBeUndefined();expect(seen[0].headers.cookie).toBeUndefined();
  // A rejected token is dropped so the next request fetches a fresh one.
  expect((await post('user_alpha',token(a),{input:'expired'})).status).toBe(401);expect(invalidated).toBe(1);
  // The DeepSeek and Claude members' Responses route is unchanged.
  for(const m of [b,c]){expect((await post(m.runtimeUserId!,token(m),{model:'gpt-6.1-sol',input:'hi'})).status).toBe(200);
   expect(seen.at(-1).url).toBe('/v1/responses');expect(seen.at(-1).body.model).toBe('deepseek-v4.1-flash');expect(seen.at(-1).headers.authorization).toBe('Bearer master-private-key');}
  // Without the control plane's ChatGPT login a GPT member fails closed, never on DeepSeek.
  loggedIn=false;const count=seen.length;
  expect((await post('user_alpha',token(a),{input:'hi'})).status).toBe(502);expect(seen).toHaveLength(count);
 }finally{gateway.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await h.shutdown();}
});
