import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {it,expect} from 'vitest';
import {startHarness} from '../helpers/harness.js';
import {registerWithInvite,registrationRequiresInvite,SPARE_ACCOUNT_KEY} from '../../src/control/auth/invites.js';
import {userNamespace} from '../../src/control/auth/workspaceHost.js';
import {UserRuntimes} from '../../src/control/tenants.js';
import type {MemberModelGateway} from '../../src/control/memberModelGateway.js';
import type {AppContext} from '../../src/control/context.js';
import type {Config} from '../../src/control/config.js';

const spareId=(ctx:AppContext)=>(ctx.db.prepare('SELECT value FROM meta WHERE key=?').get(SPARE_ACCOUNT_KEY) as {value:string}|undefined)?.value;

it('keeps one sandbox provisioned for the next registration, which takes it over',async()=>{
 const h=await startHarness();
 try{
  h.ctx.cfg.sandbox.autostart=true;
  Object.assign(h.ctx.container,{protectMemberPorts:async()=>{}});
  const made:{config:Config;identity:{id:string;username:string};shut:boolean;calls:string[]}[]=[];
  const factory=async(opts?:{config?:Config;identity?:{id:string;username:string;role:string}})=>{
   const calls:string[]=[];
   const config=opts!.config!;
   const entry={config,identity:opts!.identity!,shut:false,calls};made.push(entry);
   const ctx={cfg:{...config,browser:{...config.browser,enabled:false},sandbox:{...config.sandbox,autostart:false}},log:h.ctx.log,db:h.ctx.db,sandboxSetupError:null,sandboxSurfaces:null,
    agent:{init:async()=>{calls.push('agent.init');},setSandboxGate:()=>{}},tasks:{init:()=>{calls.push('tasks.init');}}} as unknown as AppContext;
   return {ctx,db:h.ctx.db,shutdown:async()=>{entry.shut=true;}};
  };
  const registry=new UserRuntimes(h.ctx,factory as never,{provision:()=>{}} as unknown as MemberModelGateway);
  registry.prepareSpare();
  const first=spareId(h.ctx)!;
  expect(first).toMatch(/^user_[0-9a-f]{24}$/);
  await new Promise(r=>setTimeout(r,0));
  expect(made).toHaveLength(1);
  expect(made[0]!.identity).toMatchObject({id:first,username:'spare'});
  expect(made[0]!.config.agent.dailyFeed).toBe(false);
  // Preparing again keeps the one spare.
  registry.prepareSpare();expect(made).toHaveLength(1);
  // The spare has no account: it cannot sign in and does not count toward the open-registration limit.
  expect(h.ctx.db.prepare('SELECT 1 FROM owners WHERE id=?').get(first)).toBeUndefined();
  expect(registrationRequiresInvite(h.ctx.db)).toBe(false);

  // The spare runtime's database is replaced by the account's own.
  const dbPath=path.join(h.ctx.cfg.dataDir,'users',userNamespace(first),'agent.sqlite');
  mkdirSync(path.dirname(dbPath),{recursive:true});writeFileSync(dbPath,'spare');
  const user=await registerWithInvite(h.ctx.db,{email:'newcomer@example.com',password:'newcomer-secret-123',code:''});
  expect(user.id).toBe(first);
  await registry.resolve(user.id);
  expect(made[0]!.shut).toBe(true);
  expect(existsSync(dbPath)).toBe(false);
  const own=made.find(m=>m.identity.username==='newcomer')!;
  expect(own.identity.id).toBe(first);
  expect(own.config.sandbox.containerName).toBe(made[0]!.config.sandbox.containerName);
  expect(own.config.sandbox.hostPort).toBe(made[0]!.config.sandbox.hostPort);
  expect(own.config.agent.dailyFeed).toBe(true);
  // The next spare is already on its way, under a new id.
  const next=spareId(h.ctx)!;
  expect(next).not.toBe(first);
  expect(made.find(m=>m.identity.id===next)?.identity.username).toBe('spare');

  // A failed registration leaves the spare where it was.
  await expect(registerWithInvite(h.ctx.db,{email:'newcomer@example.com',password:'newcomer-secret-123',code:''})).rejects.toThrow();
  expect(spareId(h.ctx)).toBe(next);
  await registry.shutdown();
  expect(made.every(m=>m.shut)).toBe(true);
 }finally{h.ctx.cfg.sandbox.autostart=false;await h.shutdown();}
});

it('has no spare without managed sandboxes or when switched off',async()=>{
 const h=await startHarness();
 try{
  const registry=new UserRuntimes(h.ctx,(async()=>{throw new Error('not expected');}) as never);
  registry.prepareSpare();
  expect(spareId(h.ctx)).toBeUndefined();
  h.ctx.cfg.sandbox.autostart=true;h.ctx.cfg.sandbox.spare=false;
  registry.prepareSpare();
  expect(spareId(h.ctx)).toBeUndefined();
  const user=await registerWithInvite(h.ctx.db,{email:'plain@example.com',password:'plain-secret-1234',code:''});
  expect(user.id).toMatch(/^user_/);
 }finally{h.ctx.cfg.sandbox.autostart=false;h.ctx.cfg.sandbox.spare=true;await h.shutdown();}
});
