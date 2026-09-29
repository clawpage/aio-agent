import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import type {Config} from './config.js';
import {BridgeModel} from './bridgeModel.js';
import type {Logger} from './logger.js';

/** Member capabilities authorize stateless DeepSeek inference only, never bridge admin/history APIs. */
export class MemberModelGateway {
  private tokens=new Map<string,string>();
  private server:http.Server|null=null;
  constructor(private cfg:Config,private log:Logger){}
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
  }
  get port():number {return (this.server?.address() as {port:number}|null)?.port??this.cfg.memberModelPort??4902;}
  async start():Promise<void>{
    const bridge=new BridgeModel(this.cfg,this.log);
    this.server=http.createServer(async(req,res)=>{
      const match=/^\/u\/(user_[a-zA-Z0-9]+)\/v1\/responses$/.exec(req.url??'');
      const expected=match?this.tokens.get(match[1]):null;
      const supplied=(req.headers.authorization??'').replace(/^Bearer /,'');
      if(req.method!=='POST'||!expected||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){res.writeHead(403).end();return;}
      const abort=new AbortController();res.on('close',()=>abort.abort());
      try{
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
        if(input.previous_response_id||input.conversation||input.background){res.writeHead(400).end();return;}
        const state=bridge.status();if(!state.enabled||!state.secret)throw new Error('Provider unavailable');
        input.model='deepseek-v4.1-flash';input.reasoning={effort:'high'};input.store=false;
        const base=new URL(state.baseUrl);if(base.hostname==='host.docker.internal')base.hostname='127.0.0.1';
        const upstream=await fetch(base.toString().replace(/\/$/,'')+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${state.secret}`},body:JSON.stringify(input),signal:abort.signal});
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
        if(upstream.body)Readable.fromWeb(upstream.body as never).on('error',()=>res.destroy()).pipe(res);else res.end();
      }catch{if(!res.headersSent)res.writeHead(502);res.end();}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.cfg.memberModelPort??4902,'0.0.0.0',resolve);});
  }
  close(){this.server?.closeAllConnections();this.server?.close();}
}
