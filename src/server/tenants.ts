import path from 'node:path';
import {userNamespace,workspaceConfig} from './auth/workspaceHost.js';
import type {Config} from './config.js';
import type {AppContext} from './context.js';
import {bootstrap, startSandboxRuntime, startRuntimeRecovery, type Bootstrapped} from './index.js';
import type {MemberModelGateway} from './memberModelGateway.js';
import {getUser} from './auth/owner.js';

/** A stable opaque namespace: no user-controlled paths, names, ports or upstreams. */
export function memberConfig(base: Config, userId: string, port: number): Config {
  const suffix=userNamespace(userId);
  const dataDir=path.join(base.dataDir,'users',suffix);
  return {...workspaceConfig(base), runtimeUserId:userId, memberRuntime:true, dataDir,
    dbPath:path.join(dataDir,'agent.sqlite'),logDir:path.join(dataDir,'logs'),
    ownerPassword:'',ownerPasswordReset:false,ownerSecretPath:path.join(dataDir,'unused-secret'),
    agent:{...base.agent,defaultModel:'deepseek-v4.1-flash'},
    sandbox:{...base.sandbox,hostPort:port,containerName:`aio-user-${suffix}`,
      networkName:`aio-user-${suffix}`,workspaceVolume:`aio-user-${suffix}-workspace`,
      // Owner PA_SANDBOX_EXTRA_ENV is never inherited; only the fixed flag Chromium needs
      // on Docker Desktop (no user namespaces for its zygote), or the browser crash-loops.
      codexVolume:`aio-user-${suffix}-codex`,browserVolume:`aio-user-${suffix}-browser`,extraEnv:['BROWSER_NO_SANDBOX=--no-sandbox']},
    bridge:{...base.bridge,models:['deepseek-v4.1-flash']},
  };
}

/** Fail closed: a missing/failed member runtime can never fall through to owner. */
export class UserRuntimes {
  private entries=new Map<string,Promise<Bootstrapped>>();
  private recoveries: Array<ReturnType<typeof startRuntimeRecovery>>=[];
  constructor(private root: AppContext, private factory=bootstrap, private gateway?:MemberModelGateway) {}
  async resolve(id:string):Promise<AppContext> {
    const user=getUser(this.root.db,id);
    if(!user) throw new Error('Unknown account');
    if(user.role==='owner') return this.root;
    let pending=this.entries.get(id);
    if(!pending){
      pending=this.create(user);
      this.entries.set(id,pending);
      pending.catch(()=>{if(this.entries.get(id)===pending)this.entries.delete(id);});
    }
    return (await pending).ctx;
  }
  private async create(user:{id:string;username:string;role:string}):Promise<Bootstrapped> {
    // Stored allocation survives account deletion/recreation and service restarts.
    const key=`sandbox_port:${user.id}`;
    const row=this.root.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;
    let port=row?Number(row.value):0;
    if(!port){
      const used=this.root.db.prepare("SELECT value FROM meta WHERE key LIKE 'sandbox_port:%'").all() as {value:string}[];
      port=Math.max(this.root.cfg.sandbox.hostPort,...used.map(x=>Number(x.value)))+1;
      if(port>65535)throw new Error('No sandbox ports available');
      this.root.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key,String(port));
    }
    const config=memberConfig(this.root.cfg,user.id,port);
    if(config.sandbox.autostart&&!this.gateway)throw new Error("Member gateway unavailable");
    this.gateway?.provision(config);
    const runtime=await this.factory({config,skipOwner:true,identity:user,deferAgentInit:true});
    // Authentication remains central; all agent/files/browser collaborators and
    // their state stores belong exclusively to the member runtime.
    runtime.ctx.sessions=this.root.sessions;
    runtime.ctx.tickets=this.root.tickets;
    runtime.ctx.limiter=this.root.limiter;
    if(runtime.ctx.cfg.sandbox.autostart){
      try{await runtime.ctx.container.ensureRunning();}catch(err){await runtime.shutdown();throw err;}
    }
    if(runtime.ctx.cfg.sandbox.autostart){
      const ports=(this.root.db.prepare("SELECT value FROM meta WHERE key LIKE 'sandbox_port:%'").all() as {value:string}[]).map(x=>Number(x.value));
      try{await this.root.container.protectMemberPorts(ports);}catch(err){await runtime.shutdown();throw err;}
    }
    await runtime.ctx.agent.init();runtime.ctx.tasks.init();
    if(runtime.ctx.cfg.sandbox.autostart){
      await startSandboxRuntime(runtime.ctx);
      if(runtime.ctx.sandboxSetupError){await runtime.shutdown();throw new Error('用户独立环境启动失败');}
      const recovery=startRuntimeRecovery(runtime.ctx);this.recoveries.push(recovery);
    }
    return runtime;
  }
  async shutdown():Promise<void>{
    for(const recovery of this.recoveries)recovery.stop();
    await Promise.allSettled([...this.entries.values()].map(async p=>(await p).shutdown()));
  }
}
