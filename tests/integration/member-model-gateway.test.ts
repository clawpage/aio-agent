import {it,expect} from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {startHarness} from '../helpers/harness.js';
import {MemberModelGateway} from '../../src/server/memberModelGateway.js';
import {memberConfig} from '../../src/server/tenants.js';
it('exposes only stateless high-effort DeepSeek, never the bridge master key or response lookup',async()=>{
 const h=await startHarness();let body:any,auth:string|undefined;
 const upstream=http.createServer(async(req,res)=>{auth=req.headers.authorization;let data='';for await(const chunk of req)data+=chunk;body=JSON.parse(data);res.setHeader('content-type','text/event-stream');res.end('data: {"ok":true}\n\n');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const file=path.join(h.dataDir,'bridge-key');fs.writeFileSync(file,'LITELLM_MASTER_KEY=master-private-key\n',{mode:0o600});
 const cfg={...h.ctx.cfg,memberModelPort:0,bridge:{...h.ctx.cfg.bridge,enabled:'on',secretsFile:file,baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`}};
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
