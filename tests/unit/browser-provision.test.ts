import {afterEach, it, expect, vi} from 'vitest';
import fs from 'node:fs';
import {BrowserRuntime} from '../../src/control/browser/runtime.js';
import type {Config} from '../../src/control/config.js';
import type {SandboxContainer} from '../../src/control/sandbox/container.js';
import {Logger} from '../../src/common/logger.js';
const cfg={browser:{toolDir:'/opt/aio-browser',snapshotPath:'/state/snapshot.json'}} as Config;
afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const files=new Map<string,string>();const writes:string[]=[];let fail=false;let version='one';
 const read=fs.readFileSync;
 vi.spyOn(fs,'readFileSync').mockImplementation(((p:any,...args:any[])=>{
  if(String(p).endsWith('patchright-core.tgz'))return Buffer.from(version);
  return (read as any)(p,...args);
 }) as any);
 const container={
  async execInSandbox(argv:string[]){
   if(argv[0]==='cat'){const content=files.get(argv[1]!);return{code:content===undefined?1:0,stdout:content??'',stderr:''};}
   if(argv[0]==='bash' && fail)return{code:1,stdout:'',stderr:'test extract failure'};
   return{code:0,stdout:'',stderr:''};
  },
  async writeFileInSandbox(p:string,body:string){writes.push(p);files.set(p,body)},
 } as unknown as SandboxContainer;
 return {files,writes,fail:()=>{fail=true},recover:()=>{fail=false},next:()=>{version='two'},runtime:()=>new BrowserRuntime(cfg,new Logger('error',undefined,false),container)};
}
it('updates the storage bundle even when the Python helper is unchanged',async()=>{
 const f=fixture();await f.runtime().ensureScripts();const python=f.files.get('/opt/aio-browser/.browser-runtime.sha256');
 const storage=f.files.get('/opt/aio-browser/.browser-storage.sha256');f.next();await f.runtime().ensureScripts();
 expect(f.files.get('/opt/aio-browser/.browser-runtime.sha256')).toBe(python);
 expect(f.files.get('/opt/aio-browser/.browser-storage.sha256')).not.toBe(storage);
 expect(f.writes.filter(p=>p.endsWith('browser-runtime.py'))).toHaveLength(1);
 expect(f.writes.filter(p=>p.endsWith('browser-storage.cjs'))).toHaveLength(2);
});
it('retries a failed storage install without recording a false successful provision',async()=>{
 const f=fixture(),rt=f.runtime();f.fail();await expect(rt.ensureScripts()).rejects.toThrow();
 expect(f.files.has('/opt/aio-browser/.browser-runtime.sha256')).toBe(false);
 f.recover();await rt.ensureScripts();expect(f.files.has('/opt/aio-browser/.browser-storage.sha256')).toBe(true);
});
/** A container whose exec answers come from `answer`; files written are remembered. */
function scripted(answer:(argv:string[])=>{code:number;stdout:string;stderr:string}|undefined){
 const read=fs.readFileSync;
 vi.spyOn(fs,'readFileSync').mockImplementation(((p:any,...args:any[])=>
  String(p).endsWith('patchright-core.tgz')?Buffer.from('vendor'):(read as any)(p,...args)) as any);
 const files=new Map<string,string>();const execs:string[][]=[];const writes:string[]=[];
 const container={
  async execInSandbox(argv:string[]){
   execs.push(argv);const scripted=answer(argv);if(scripted)return scripted;
   if(argv[0]==='cat'){const content=files.get(argv[1]!);return{code:content===undefined?1:0,stdout:content??'',stderr:''};}
   return{code:0,stdout:'',stderr:''};
  },
  async writeFileInSandbox(p:string,body:string){writes.push(p);files.set(p,body)},
 } as unknown as SandboxContainer;
 const runtime=new BrowserRuntime({browser:{...cfg.browser,stopTimeoutMs:30_000,wakeTimeoutMs:90_000,helperTimeoutMs:45_000}} as Config,new Logger('error',undefined,false),container);
 return {runtime,execs,writes,files};
}
const isCheck=(argv:string[])=>argv[0]==='python3'&&argv[1]==='-c';
const isHelper=(argv:string[])=>argv[0]==='python3'&&argv[1]==='/opt/aio-browser/browser-runtime.py';
it('blames the directory owner only for a real ownership violation, not a stopped sandbox',async()=>{
 const stopped=scripted(argv=>isCheck(argv)?{code:1,stdout:'',stderr:'container personal-agent-sandbox is not running'}:undefined);
 const err=await stopped.runtime.ensureScripts().then(()=>new Error("resolved"),(e:Error)=>e);
 expect(err.message).not.toContain('必须由 root 管理');
 expect(err.message).toContain('不可达');
 expect(err.message).toContain('not running');
 const owned=scripted(argv=>isCheck(argv)?{code:3,stdout:'',stderr:''}:undefined);
 await expect(owned.runtime.ensureScripts()).rejects.toThrow('浏览器工具目录必须由 root 管理且不可由沙盒用户替换');
 // The check itself exits with the dedicated code for every violation.
 const check=stopped.execs.find(isCheck)![2]!;
 expect(check).not.toMatch(/sys\.exit\(1\)/);
 expect(check.match(/sys\.exit\(3\)/g)).toHaveLength(4);
});
it('provisions the helper again when a recreated container lost it',async()=>{
 let lost=false;
 const f=scripted(argv=>{
  if(!isHelper(argv))return undefined;
  if(lost){lost=false;return{code:2,stdout:'',stderr:"python3: can't open file '/opt/aio-browser/browser-runtime.py': [Errno 2] No such file or directory"};}
  return{code:0,stdout:'{"ok":true,"browserRunning":true}',stderr:''};
 });
 expect((await f.runtime.status()).ok).toBe(true);
 // The container was recreated: its tool directory is gone.
 f.files.clear();lost=true;
 const status=await f.runtime.status();
 expect(status.ok).toBe(true);
 expect(status.browserRunning).toBe(true);
 expect(f.writes.filter(p=>p.endsWith('browser-runtime.py'))).toHaveLength(2);
});
