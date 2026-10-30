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
import type {MacNativeGateway} from './macNative.js';
import type {ScheduleGateway} from './scheduleTool.js';
import type {HistoryGateway} from './historyTool.js';
import type {TaskKbGateway} from './taskKb/gateway.js';
import type {BrowserGateway} from './browser/gateway.js';
import type {HostTokenSource} from './codex/hostTokens.js';
import type {ImageGateway} from './imageTool.js';
import type {PrinterGateway} from './printer/gateway.js';
import type {TtsGateway} from './ttsTool.js';

/** The CLI's subscription credential needs this beta on the Messages API. */
const OAUTH_BETA='oauth-2025-04-20';
/** Request metadata the member's Codex sends that ChatGPT may read; never its gateway token. */
const CODEX_HEADERS=/^(accept|user-agent|originator|version|session-id|thread-id|x-client-request-id|x-codex-[a-z0-9-]+|x-openai-internal-codex-[a-z0-9-]+)$/;
/** Read limit for one request; images from earlier turns are dropped before it is forwarded. */
const MAX_REQUEST_BYTES=128*1024*1024;
/**
 * ChatGPT now and then answers 429 for a minute; the member's Codex retried within two seconds and failed the
 * task. A brief limit is waited out here instead, before anything has gone back (so asking again is safe):
 * at most RATE_LIMIT_WAIT_MS in all, never a single pause above RATE_LIMIT_MAX_PAUSE_MS, never a usage cap.
 */
const RATE_LIMIT_WAIT_MS=60_000;
const RATE_LIMIT_MAX_PAUSE_MS=30_000;
const RATE_LIMIT_TRIES=8;
const IMAGE_DROPPED={type:'input_text',text:'[An image a tool returned in an earlier turn was removed to keep the request small; view it again if it is still needed.]'};

/**
 * Codex resends a thread's whole history on every request, including each image a tool returned.
 * One member's thread of picture edits viewed a 2.5 MB screenshot per edit until every request
 * passed the size limit and the thread could not run at all. Tool images before the latest user
 * message are replaced by a note; the current turn keeps its own, and user uploads are kept.
 */
/** How long to wait before asking again after a 429 answer, or null to hand that answer on now. */
export function rateLimitWait(headers:Headers,body:string,attempt:number,waited:number,now=Date.now()):number|null{
  try{
    // A usage cap resets in hours: the executor shows it, nothing is gained by waiting here.
    const e=(JSON.parse(body) as {error?:{type?:unknown;code?:unknown}}).error;
    if([e?.type,e?.code].some(v=>typeof v==='string'&&/usage_limit|quota|not_included/.test(v)))return null;
  }catch{/* not JSON */}
  const ms=headers.get('retry-after-ms'),after=headers.get('retry-after');
  let wait=ms!==null&&ms!==''&&Number.isFinite(Number(ms))?Number(ms):after!==null&&after!==''?(Number.isFinite(Number(after))?Number(after)*1000:Date.parse(after)-now):NaN;
  if(!Number.isFinite(wait))wait=Math.min(RATE_LIMIT_MAX_PAUSE_MS,1000*2**attempt);
  wait=Math.max(0,wait);
  return wait>RATE_LIMIT_MAX_PAUSE_MS||waited+wait>RATE_LIMIT_WAIT_MS?null:wait;
}

function pause(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('aborted'));return;}
    const timer=setTimeout(resolve,ms);
    signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});
  });
}

/** Pass an upstream answer on: a stream as it comes; an error read first so the log says why (it never holds a token). */
async function relay(upstream:Response,res:http.ServerResponse,log:Logger,userId:string):Promise<void>{
  const headers:Record<string,string>={'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'};
  const retry=upstream.headers.get('retry-after');if(retry)headers['retry-after']=retry;
  if(!upstream.ok){
    const text=await upstream.text();
    log.warn('member model upstream error',{userId,status:upstream.status,retryAfter:retry,error:text.slice(0,300)});
    res.writeHead(upstream.status,headers).end(text);return;
  }
  res.writeHead(upstream.status,headers);
  if(upstream.body)Readable.fromWeb(upstream.body as never).on('error',()=>res.destroy()).pipe(res);else res.end();
}

export function dropEarlierToolImages(input:unknown):void{
  if(!Array.isArray(input))return;
  const items=input as Array<{type?:unknown;role?:unknown;output?:unknown}|null>;
  let lastUser=-1;
  items.forEach((item,i)=>{if(item?.type==='message'&&item.role==='user')lastUser=i;});
  for(const item of items.slice(0,Math.max(lastUser,0))){
    if(typeof item?.type!=='string'||!item.type.endsWith('_call_output')||!Array.isArray(item.output))continue;
    item.output=item.output.map(part=>(part as {type?:unknown}|null)?.type==='input_image'?IMAGE_DROPPED:part);
  }
}

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
  constructor(private cfg:Config,private log:Logger,private share?:ShareStore,private decision?:DecisionGateway,private kb?:KbGateway,private schedule?:ScheduleGateway,private hostTokens?:Pick<HostTokenSource,'getTokens'|'invalidate'>,private image?:ImageGateway,private browser?:BrowserGateway,private ha?:HaGateway,private printer?:PrinterGateway,private macNative?:MacNativeGateway,private history?:HistoryGateway,private tts?:TtsGateway,private taskKb?:TaskKbGateway){}
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
    this.taskKb?.provision(cfg);
    this.image?.provision(cfg);
    this.tts?.provision(cfg);
    this.browser?.provision(cfg);
    // A member's own Mac (its phone, the AI's Chrome, its terminal); never another account's.
    this.macNative?.provision(cfg);
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
      // A runtime holds a Mac token only for a Mac its own account linked.
      if(this.macNative?.owns(req.url)){await this.macNative.handle(req,res);return;}
      if(this.schedule&&(req.url??'').startsWith('/schedule/')){await this.schedule.handle(req,res);return;}
      if(this.history&&(req.url??'').startsWith('/history/')){await this.history.handle(req,res);return;}
      if(this.taskKb&&(req.url??'').startsWith('/task-kb/')){await this.taskKb.handle(req,res);return;}
      if(this.image&&(req.url??'').startsWith('/image/')){await this.image.handle(req,res);return;}
      if(this.tts&&(req.url??'').startsWith('/tts/')){await this.tts.handle(req,res);return;}
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
        for await(const chunk of req){size+=chunk.length;if(size>MAX_REQUEST_BYTES){this.log.warn('member model request too large',{userId,bytes:size});res.writeHead(413).end();return;}chunks.push(chunk);}
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
          // Claude Code's own client waits out a 429 by its Retry-After, which therefore goes back with it.
          await relay(upstream,res,this.log,userId!);
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
          dropEarlierToolImages(input.input);
          const headers:Record<string,string>={'content-type':'application/json',authorization:`Bearer ${tokens.accessToken}`,'chatgpt-account-id':tokens.chatgptAccountId};
          for(const [name,value] of Object.entries(req.headers))if(typeof value==='string'&&CODEX_HEADERS.test(name))headers[name]=value;
          const target=this.cfg.hostCodex.chatgptUrl.replace(/\/$/,'')+'/responses',payload=JSON.stringify(input);
          const ask=()=>fetch(target,{method:'POST',headers,body:payload,signal:abort.signal});
          let upstream=await ask();
          for(let attempt=0,waited=0;upstream.status===429&&attempt<RATE_LIMIT_TRIES;attempt++){
            const text=await upstream.text();
            const wait=rateLimitWait(upstream.headers,text,attempt,waited);
            if(wait===null){upstream=new Response(text,{status:429,headers:upstream.headers});break;}
            this.log.info('member model rate limited, asking again',{userId,attempt:attempt+1,waitMs:wait});
            await pause(wait,abort.signal);waited+=wait;upstream=await ask();
          }
          // A rejected token is fetched afresh on the next request.
          if(upstream.status===401)this.hostTokens.invalidate();
          await relay(upstream,res,this.log,userId!);
          return;
        }
        res.writeHead(403).end();
      }catch(err){
        if(!abort.signal.aborted)this.log.warn('member model request failed',{userId,error:err instanceof Error?err.message:String(err)});
        if(!res.headersSent)res.writeHead(502);res.end();
      }
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.cfg.memberModelPort??4902,'0.0.0.0',resolve);});
  }
  close(){this.server?.closeAllConnections();this.server?.close();}
}
