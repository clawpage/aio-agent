import {afterEach, it, expect, vi} from 'vitest';
import fs from 'node:fs';
import {BrowserRuntime} from '../../src/server/browser/runtime.js';
import type {Config} from '../../src/server/config.js';
import type {SandboxContainer} from '../../src/server/docker/sandbox.js';
import {Logger} from '../../src/server/logger.js';
const cfg={browser:{toolDir:'/opt/aio-browser',snapshotPath:'/state/snapshot.json'}} as Config;
afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const files=new Map<string,string>();const writes:string[]=[];let fail=false;let version='one';
 const read=fs.readFileSync;
 vi.spyOn(fs,'readFileSync').mockImplementation(((p:any,...args:any[])=>{
  if(String(p).endsWith('playwright-core.tgz'))return Buffer.from(version);
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
