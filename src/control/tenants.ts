import path from 'node:path';
import {userNamespace,workspaceConfig} from './auth/workspaceHost.js';
import type {Config} from './config.js';
import type {AppContext} from './context.js';
import {bootstrap, startSandboxRuntime, startRuntimeRecovery, startSandboxIdle, type Bootstrapped} from './index.js';
import {startTaskNotifications} from './push.js';
import {startVaultAutofill} from './vault.js';
import type {MemberModelGateway} from './memberModelGateway.js';
import {getUser} from './auth/owner.js';
import {MEMBER_EFFORTS,MEMBER_GPT_MODEL,MEMBER_MODEL,MEMBER_MODELS} from './auth/policy.js';
import type {SandboxNodes} from './sandbox/nodes.js';
import {feedTimeFor} from './tasks/service.js';

/** A stable opaque namespace: no user-controlled paths, names, ports or upstreams. */
export function memberConfig(base: Config, userId: string, port: number, model: string = MEMBER_MODEL, effort?: string, resident = false): Config {
  if(!MEMBER_MODELS.includes(model))throw new Error('Unsupported member model');
  if(effort!==undefined&&!MEMBER_EFFORTS.includes(effort))throw new Error('Unsupported member effort');
  const suffix=userNamespace(userId);
  const dataDir=path.join(base.dataDir,'users',suffix);
  return {...workspaceConfig(base), runtimeUserId:userId, memberRuntime:true, memberModel:model, memberEffort:effort, dataDir,
    dbPath:path.join(dataDir,'agent.sqlite'),logDir:path.join(dataDir,'logs'),
    ownerPassword:'',ownerPasswordReset:false,ownerSecretPath:path.join(dataDir,'unused-secret'),
    agent:{...base.agent,defaultModel:model},
    // A resident member (PA_RESIDENT_MEMBERS) keeps its container and browser running, as the owner does.
    browser:{...base.browser,readyGateway:undefined,releaseWhenIdle:!resident&&base.browser.memberReleaseWhenIdle},
    sandbox:{...base.sandbox,releaseWhenIdle:!resident&&base.sandbox.memberReleaseWhenIdle,hostPort:port,containerName:`aio-user-${suffix}`,
      networkName:`aio-user-${suffix}`,workspaceVolume:`aio-user-${suffix}-workspace`,
      // Owner PA_SANDBOX_EXTRA_ENV is never inherited; only the fixed flag Chromium needs
      // on Docker Desktop (no user namespaces for its zygote), or the browser crash-loops.
      codexVolume:`aio-user-${suffix}-codex`,browserVolume:`aio-user-${suffix}-browser`,extraEnv:['BROWSER_NO_SANDBOX=--no-sandbox']},
    // A GPT member's model is the one its gateway provider serves; a Claude member's runs on Claude Code.
    bridge:{...base.bridge,models:model===MEMBER_GPT_MODEL?[model]:[]},
    // The owner's knowledge-base address is never inherited; the gateway grants a listed member its own.
    kb:undefined,
    // Nor its Home Assistant address: the gateway grants a listed account its own.
    ha:undefined,
    // Nor its printer address: the gateway grants a listed account its own.
    printer:undefined,
    // Nor ever its phone: only the owner reaches it.
    phone:undefined,
    // Nor the owner's schedule tool: the gateway gives every member one that reaches only its own schedules.
    schedule:undefined,
    // Nor its history tool: each account's reaches only its own tasks and agreements.
    history:undefined,
    // Nor its image tool: each account's saves only into its own workspace.
    image:undefined,
  };
}

/** Fail closed: a missing/failed member runtime can never fall through to owner. */
export class UserRuntimes {
  private entries=new Map<string,Promise<Bootstrapped>>();
  private recoveries: Array<{stop():void}>=[];
  constructor(private root: AppContext, private factory=bootstrap, private gateway?:MemberModelGateway, private nodes?:SandboxNodes) {}
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
    // The administrator's assignment (`member_model:<id>`); members cannot change it.
    const assigned=this.root.db.prepare('SELECT value FROM meta WHERE key=?').get(`member_model:${user.id}`) as {value:string}|undefined;
    const effort=this.root.db.prepare('SELECT value FROM meta WHERE key=?').get(`member_effort:${user.id}`) as {value:string}|undefined;
    // An assignment no longer offered (DeepSeek, before it was removed) falls back to the default.
    const config=memberConfig(this.root.cfg,user.id,port,assigned&&MEMBER_MODELS.includes(assigned.value)?assigned.value:MEMBER_MODEL,
      effort&&MEMBER_EFFORTS.includes(effort.value)?effort.value:undefined,this.root.cfg.sandbox.residentMembers.includes(user.username));
    // The daily feed's slot (`feed_slot:<id>`, kept like the port): a few minutes apart per account,
    // so the members' sandboxes do not all wake on the node at the owner's 08:00.
    const slotKey=`feed_slot:${user.id}`;
    let slot=Number((this.root.db.prepare('SELECT value FROM meta WHERE key=?').get(slotKey) as {value:string}|undefined)?.value??0);
    if(!slot){
      const taken=new Set((this.root.db.prepare("SELECT value FROM meta WHERE key LIKE 'feed_slot:%'").all() as {value:string}[]).map(x=>Number(x.value)));
      slot=1;while(taken.has(slot))slot++;
      this.root.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(slotKey,String(slot));
    }
    config.agent={...config.agent,dailyFeedAt:feedTimeFor(slot)};
    if(config.sandbox.autostart&&!this.gateway)throw new Error("Member gateway unavailable");
    this.gateway?.provision(config);
    // A member keeps the node its sandbox was created on; a new one goes where there is room.
    const node=this.nodes&&config.sandbox.autostart?await this.nodes.assign(this.root.db,user.id,Boolean(row)):undefined;
    const runtime=await this.factory({config,skipOwner:true,identity:user,deferAgentInit:true,...(node?{node}:{})});
    // Authentication remains central; all agent/files/browser collaborators and
    // their state stores belong exclusively to the member runtime.
    runtime.ctx.sessions=this.root.sessions;
    runtime.ctx.tickets=this.root.tickets;
    runtime.ctx.limiter=this.root.limiter;
    runtime.ctx.push=this.root.push;
    // A container found stopped stays stopped: its account's first use starts it, so a
    // service start no longer wakes every account. Only where idle stopping is on;
    // without it nothing would start the container later.
    let asleep=false;
    if(runtime.ctx.cfg.sandbox.autostart){
      try{
        const state=runtime.ctx.cfg.sandbox.releaseWhenIdle?await runtime.ctx.container.inspect():null;
        asleep=Boolean(state?.exists&&!state.running);
        if(!asleep)await runtime.ctx.container.ensureRunning();
      }catch(err){await runtime.shutdown();throw err;}
    }
    if(runtime.ctx.cfg.sandbox.autostart){
      const ports=(this.root.db.prepare("SELECT value FROM meta WHERE key LIKE 'sandbox_port:%'").all() as {value:string}[]).map(x=>Number(x.value));
      try{await this.root.container.protectMemberPorts(ports);}catch(err){await runtime.shutdown();throw err;}
    }
    // The gate goes in before queued work resumes, or it would run against the stopped container.
    let idle=asleep?startSandboxIdle(runtime.ctx,undefined,true):null;
    await runtime.ctx.agent.init({cold:asleep});runtime.ctx.tasks.init();
    if(runtime.ctx.push)this.recoveries.push(startTaskNotifications(runtime.ctx,runtime.ctx.push));
    this.recoveries.push(startVaultAutofill(runtime.ctx));
    if(runtime.ctx.cfg.sandbox.autostart){
      if(asleep)runtime.ctx.log.info('sandbox left stopped at start');
      else{
        await startSandboxRuntime(runtime.ctx);
        if(runtime.ctx.sandboxSetupError){await runtime.shutdown();throw new Error('用户独立环境启动失败');}
      }
      const recovery=startRuntimeRecovery(runtime.ctx);this.recoveries.push(recovery);
      idle??=startSandboxIdle(runtime.ctx);if(idle)this.recoveries.push(idle);
    }
    return runtime;
  }
  async shutdown():Promise<void>{
    for(const recovery of this.recoveries)recovery.stop();
    await Promise.allSettled([...this.entries.values()].map(async p=>(await p).shutdown()));
  }
}
