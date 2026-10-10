import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import type {Config} from './config.js';
import type {Logger} from '../common/logger.js';
import {ClaudeCodeHarness,MEMBER_GATEWAY_TOKEN_KEY} from './claudeCode.js';
import {MEMBER_CLAUDE_MODEL,MEMBER_EFFORT,MEMBER_EFFORTS,MEMBER_GPT_MODEL} from './auth/policy.js';
import type {ShareStore} from './share.js';
import type {DecisionGateway} from './decision.js';
import type {KbGateway} from './kb.js';
import type {HaGateway} from './ha.js';
import type {PhoneGateway} from './phone.js';
import type {ScheduleGateway} from './scheduleTool.js';
import type {HistoryGateway} from './historyTool.js';
import type {BrowserGateway} from './browser/gateway.js';
import type {HostTokenSource} from './codex/hostTokens.js';
import type {ImageGateway} from './imageTool.js';
import type {PrinterGateway} from './printer/gateway.js';

/** The CLI's subscription credential needs this beta on the Messages API. */
const OAUTH_BETA='oauth-2025-04-20';
/** Request metadata the member's Codex sends that ChatGPT may read; never its gateway token. */
const CODEX_HEADERS=/^(accept|user-agent|originator|version|session-id|thread-id|x-client-request-id|x-codex-[a-z0-9-]+|x-openai-internal-codex-[a-z0-9-]+)$/;

/**
 * Member capabilities authorize stateless inference on the member's one assigned model only:
 * a member assigned GPT gets the Responses route, sent to ChatGPT with the control plane's own
 * login added here on the host; a member assigned Claude gets the Messages API on that model
 * with the owner's credential added here. Nothing else is forwarded.
 */
export class MemberModelGateway {
  private tokens=new Map<string,string>();
  private claudeModels=new Map<string,string>();
  private gptUsers=new Set<string>();
  private server:http.Server|null=null;
  constructor(private cfg:Config,private log:Logger,private share?:ShareStore,private decision?:DecisionGateway,private kb?:KbGateway,private schedule?:ScheduleGateway,private hostTokens?:Pick<HostTokenSource,'getTokens'|'invalidate'>,private image?:ImageGateway,private browser?:BrowserGateway,private ha?:HaGateway,private printer?:PrinterGateway,private phone?:PhoneGateway,private history?:HistoryGateway){}
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
    this.ha?.provision(cfg);
    this.printer?.provision(cfg);
    this.schedule?.provision(cfg);
    this.history?.provision(cfg);
    this.image?.provision(cfg);
    this.browser?.provision(cfg);
    if(cfg.memberModel===MEMBER_GPT_MODEL)this.gptUsers.add(cfg.runtimeUserId!);else this.gptUsers.delete(cfg.runtimeUserId!);
    if(cfg.memberModel!==MEMBER_CLAUDE_MODEL){this.claudeModels.delete(cfg.runtimeUserId!);return;}
    const claudeSecret=path.join(cfg.dataDir,'claude.env');
    fs.writeFileSync(claudeSecret,`${MEMBER_GATEWAY_TOKEN_KEY}=${token}\n`,{mode:0o600});
    this.claudeModels.set(cfg.runtimeUserId!,cfg.memberModel);
    cfg.claudeCode={...cfg.claudeCode,enabled:'on',secretsFile:claudeSecret,gatewayUrl:`http://host.docker.internal:${this.cfg.memberModelPort??4902}/u/${cfg.runtimeUserId}/anthropic`};
  }
  get port():number {return (this.server?.address() as {port:number}|null)?.port??this.cfg.memberModelPort??4902;}
  async start():Promise<void>{
    const claude=new ClaudeCodeHarness(this.cfg,this.log);
    this.server=http.createServer(async(req,res)=>{
      // The same sandbox-to-host channel carries share publishing, under its own per-runtime token.
      if(this.share&&(req.url??'').startsWith('/share/')){await this.share.handleApi(req,res);return;}
      if(this.decision&&(req.url??'').startsWith('/decision/')){await this.decision.handle(req,res);return;}
      if(this.kb&&(req.url??'').startsWith('/kb/')){await this.kb.handle(req,res);return;}
      if(this.ha?.owns(req.url)){await this.ha.handle(req,res);return;}
      if(this.printer&&(req.url??'').startsWith('/printer/')){await this.printer.handle(req,res);return;}
      // Only the owner runtime holds a phone token (index.ts); members are never provisioned one.
      if(this.phone?.owns(req.url)){await this.phone.handle(req,res);return;}
      if(this.schedule&&(req.url??'').startsWith('/schedule/')){await this.schedule.handle(req,res);return;}
      if(this.history&&(req.url??'').startsWith('/history/')){await this.history.handle(req,res);return;}
      if(this.image&&(req.url??'').startsWith('/image/')){await this.image.handle(req,res);return;}
      if(this.browser&&(req.url??'').startsWith('/browser/')){await this.browser.handle(req,res);return;}
      const match=/^\/u\/(user_[a-zA-Z0-9]+)\/v1\/responses$/.exec(req.url??'');
      const messages=/^\/u\/(user_[a-zA-Z0-9]+)\/anthropic(\/v1\/messages(?:\/count_tokens)?)(\?beta=true)?$/.exec(req.url??'');
      const userId=match?.[1]??messages?.[1];
      const expected=userId&&((match&&this.gptUsers.has(userId))||(messages&&this.claudeModels.has(userId)))?this.tokens.get(userId):null;
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
          // Fails closed (502) when the control plane has no ChatGPT login; there is nothing to fall back to.
          if(!this.hostTokens)throw new Error('Provider unavailable');
          const tokens=await this.hostTokens.getTokens();
          const reasoning=input.reasoning&&typeof input.reasoning==='object'?input.reasoning:{};
          // The member's executor runs at high; its dispatcher may ask for less. Never more than high.
          const asked=(reasoning as {effort?:unknown}).effort;
          // Anything else (xhigh and up, or none) runs at high.
          const effort=typeof asked==='string'&&MEMBER_EFFORTS.includes(asked)?asked:MEMBER_EFFORT;
          input.model=MEMBER_GPT_MODEL;input.reasoning={...reasoning,effort};input.store=false;delete input.service_tier;
          const headers:Record<string,string>={'content-type':'application/json',authorization:`Bearer ${tokens.accessToken}`,'chatgpt-account-id':tokens.chatgptAccountId};
          for(const [name,value] of Object.entries(req.headers))if(typeof value==='string'&&CODEX_HEADERS.test(name))headers[name]=value;
          const upstream=await fetch(this.cfg.hostCodex.chatgptUrl.replace(/\/$/,'')+'/responses',{method:'POST',headers,body:JSON.stringify(input),signal:abort.signal});
          // A rejected token is fetched afresh on the next request.
          if(upstream.status===401)this.hostTokens.invalidate();
          res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
          if(upstream.body)Readable.fromWeb(upstream.body as never).on('error',()=>res.destroy()).pipe(res);else res.end();
          return;
        }
        res.writeHead(403).end();
      }catch{if(!res.headersSent)res.writeHead(502);res.end();}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.cfg.memberModelPort??4902,'0.0.0.0',resolve);});
  }
  close(){this.server?.closeAllConnections();this.server?.close();}
}
