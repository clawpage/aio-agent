import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import type {Config} from './config.js';
import {BridgeModel} from './bridgeModel.js';
import type {Logger} from '../common/logger.js';
import {ClaudeCodeHarness,MEMBER_GATEWAY_TOKEN_KEY} from './claudeCode.js';
import {MEMBER_CLAUDE_MODEL,MEMBER_EFFORT,MEMBER_GPT_MODEL} from './auth/policy.js';
import type {ShareStore} from './share.js';
import type {DecisionGateway} from './decision.js';
import type {KbGateway} from './kb.js';
import type {ScheduleGateway} from './scheduleTool.js';
import type {HostTokenSource} from './codex/hostTokens.js';

/** The CLI's subscription credential needs this beta on the Messages API. */
const OAUTH_BETA='oauth-2025-04-20';
/** Request metadata the member's Codex sends that ChatGPT may read; never its gateway token. */
const CODEX_HEADERS=/^(accept|user-agent|originator|version|session-id|thread-id|x-client-request-id|x-codex-[a-z0-9-]+|x-openai-internal-codex-[a-z0-9-]+)$/;

/**
 * Member capabilities authorize stateless DeepSeek inference only, never bridge admin/history APIs,
 * and, for a member assigned Claude, the Messages API on that one model with the owner's
 * credential added here on the host. A member assigned GPT gets the same stateless Responses
 * route, sent to ChatGPT with the control plane's own login added here.
 */
export class MemberModelGateway {
  private tokens=new Map<string,string>();
  private claudeModels=new Map<string,string>();
  private gptUsers=new Set<string>();
  private server:http.Server|null=null;
  constructor(private cfg:Config,private log:Logger,private share?:ShareStore,private decision?:DecisionGateway,private kb?:KbGateway,private schedule?:ScheduleGateway,private hostTokens?:Pick<HostTokenSource,'getTokens'|'invalidate'>){}
  provision(cfg:Config):void {
    fs.mkdirSync(cfg.dataDir,{recursive:true,mode:0o700});
    const file=path.join(cfg.dataDir,'model-token');
    let token:string;
    try{token=fs.readFileSync(file,'utf8').trim();}catch{token=randomBytes(32).toString('hex');fs.writeFileSync(file,token,{mode:0o600,flag:'wx'});}
    this.tokens.set(cfg.runtimeUserId!,token);
    const envKey='AIO_MEMBER_MODEL_TOKEN';
    const secret=path.join(cfg.dataDir,'model.env');
    fs.writeFileSync(secret,`${envKey}=${token}\n`,{mode:0o600});
    cfg.bridge={...cfg.bridge,envKey,secretsFile:secret,enabled:'on',baseUrl:`http://host.docker.internal:${this.cfg.memberModelPort??4902}/u/${cfg.runtimeUserId}/v1`};
    this.share?.provision(cfg);
    this.decision?.provision(cfg);
    this.kb?.provision(cfg);
    this.schedule?.provision(cfg);
    if(cfg.memberModel===MEMBER_GPT_MODEL)this.gptUsers.add(cfg.runtimeUserId!);else this.gptUsers.delete(cfg.runtimeUserId!);
    if(cfg.memberModel!==MEMBER_CLAUDE_MODEL){this.claudeModels.delete(cfg.runtimeUserId!);return;}
    const claudeSecret=path.join(cfg.dataDir,'claude.env');
    fs.writeFileSync(claudeSecret,`${MEMBER_GATEWAY_TOKEN_KEY}=${token}\n`,{mode:0o600});
    this.claudeModels.set(cfg.runtimeUserId!,cfg.memberModel);
    cfg.claudeCode={...cfg.claudeCode,enabled:'on',secretsFile:claudeSecret,gatewayUrl:`http://host.docker.internal:${this.cfg.memberModelPort??4902}/u/${cfg.runtimeUserId}/anthropic`};
  }
  get port():number {return (this.server?.address() as {port:number}|null)?.port??this.cfg.memberModelPort??4902;}
  async start():Promise<void>{
    const bridge=new BridgeModel(this.cfg,this.log);
    const claude=new ClaudeCodeHarness(this.cfg,this.log);
    this.server=http.createServer(async(req,res)=>{
      // The same sandbox-to-host channel carries share publishing, under its own per-runtime token.
      if(this.share&&(req.url??'').startsWith('/share/')){await this.share.handleApi(req,res);return;}
      if(this.decision&&(req.url??'').startsWith('/decision/')){await this.decision.handle(req,res);return;}
      if(this.kb&&(req.url??'').startsWith('/kb/')){await this.kb.handle(req,res);return;}
      if(this.schedule&&(req.url??'').startsWith('/schedule/')){await this.schedule.handle(req,res);return;}
      const match=/^\/u\/(user_[a-zA-Z0-9]+)\/v1\/responses$/.exec(req.url??'');
      const messages=/^\/u\/(user_[a-zA-Z0-9]+)\/anthropic(\/v1\/messages(?:\/count_tokens)?)(\?beta=true)?$/.exec(req.url??'');
      const userId=match?.[1]??messages?.[1];
      const expected=userId&&(match||this.claudeModels.has(userId))?this.tokens.get(userId):null;
      const supplied=(req.headers.authorization??'').replace(/^Bearer /,'');
      if(req.method!=='POST'||!expected||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){res.writeHead(403).end();return;}
      const abort=new AbortController();res.on('close',()=>abort.abort());
      try{
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
        if(messages){
          const state=claude.status();if(!state.enabled||!state.secret)throw new Error('Provider unavailable');
          input.model=this.claudeModels.get(userId!);
          const oauth=state.envKey==='CLAUDE_CODE_OAUTH_TOKEN';
          const betas=String(req.headers['anthropic-beta']??'').split(',').map(b=>b.trim()).filter(Boolean);
          if(oauth&&!betas.includes(OAUTH_BETA))betas.push(OAUTH_BETA);
          const headers:Record<string,string>={'content-type':'application/json','anthropic-version':String(req.headers['anthropic-version']??'2023-06-01'),
            ...(betas.length?{'anthropic-beta':betas.join(',')}:{}),...(req.headers['user-agent']?{'user-agent':String(req.headers['user-agent'])}:{}),
            ...(oauth?{authorization:`Bearer ${state.secret}`}:{'x-api-key':state.secret})};
          const upstream=await fetch(this.cfg.claudeCode.apiBaseUrl.replace(/\/$/,'')+messages[2]+(messages[3]??''),{method:'POST',headers,body:JSON.stringify(input),signal:abort.signal});
          res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
          if(upstream.body)Readable.fromWeb(upstream.body as never).on('error',()=>res.destroy()).pipe(res);else res.end();
          return;
        }
        if(input.previous_response_id||input.conversation||input.background){res.writeHead(400).end();return;}
        if(this.gptUsers.has(userId!)){
          // Fails closed (502) when the control plane has no ChatGPT login; it never falls back to DeepSeek.
          if(!this.hostTokens)throw new Error('Provider unavailable');
          const tokens=await this.hostTokens.getTokens();
          const reasoning=input.reasoning&&typeof input.reasoning==='object'?input.reasoning:{};
          input.model=MEMBER_GPT_MODEL;input.reasoning={...reasoning,effort:MEMBER_EFFORT};input.store=false;delete input.service_tier;
          const headers:Record<string,string>={'content-type':'application/json',authorization:`Bearer ${tokens.accessToken}`,'chatgpt-account-id':tokens.chatgptAccountId};
          for(const [name,value] of Object.entries(req.headers))if(typeof value==='string'&&CODEX_HEADERS.test(name))headers[name]=value;
          const upstream=await fetch(this.cfg.hostCodex.chatgptUrl.replace(/\/$/,'')+'/responses',{method:'POST',headers,body:JSON.stringify(input),signal:abort.signal});
          // A rejected token is fetched afresh on the next request.
          if(upstream.status===401)this.hostTokens.invalidate();
          res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
          if(upstream.body)Readable.fromWeb(upstream.body as never).on('error',()=>res.destroy()).pipe(res);else res.end();
          return;
        }
        const state=bridge.status();if(!state.enabled||!state.secret)throw new Error('Provider unavailable');
        input.model='deepseek-v4.1-flash';input.reasoning={effort:'high'};input.store=false;
        const upstream=await fetch(this.cfg.bridge.upstreamUrl.replace(/\/$/,'')+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${state.secret}`},body:JSON.stringify(input),signal:abort.signal});
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
        if(upstream.body)Readable.fromWeb(upstream.body as never).on('error',()=>res.destroy()).pipe(res);else res.end();
      }catch{if(!res.headersSent)res.writeHead(502);res.end();}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.cfg.memberModelPort??4902,'0.0.0.0',resolve);});
  }
  close(){this.server?.closeAllConnections();this.server?.close();}
}
