import {it, expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const helper=path.resolve('src/server/browser/scripts/browser-storage.cjs');
async function run(hang:boolean){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-storage-test-'));
 try {
  fs.writeFileSync(path.join(dir,'index.js'), `const fs=require('node:fs');module.exports={chromium:{connectOverCDP:async()=>({contexts:()=>[{_channel:{setStorageState:async()=>{await new Promise(r=>${hang?'void r':'setTimeout(r,120)'});fs.writeFileSync(${JSON.stringify(path.join(dir,'applied'))},'yes')}}}],newBrowserCDPSession:async()=>({}),close:async()=>fs.writeFileSync(${JSON.stringify(path.join(dir,'cleaned'))},'yes')})}}`);
  const state=path.join(dir,'state.json');fs.writeFileSync(state,JSON.stringify({cookies:[{value:'private-test-secret'}],origins:[]}));
  const started=Date.now();
  let output='',code=0;
  try {output=(await exec(process.execPath,[helper,'import','--vendor',dir,'--in',state],{env:{...process.env,BROWSER_STORAGE_DEADLINE_MS:hang?'200':'2000'},timeout:4000})).stdout;}
  catch(error:any){output=error.stdout;code=error.code;}
  expect(output).not.toContain('private-test-secret');
  expect(fs.existsSync(path.join(dir,'cleaned'))).toBe(true);
  if(hang){expect(code).toBe(1);expect(JSON.parse(output).code).toBe('storage_deadline');expect(Date.now()-started).toBeLessThan(3000);}
  else {expect(code).toBe(0);expect(JSON.parse(output).ok).toBe(true);expect(fs.existsSync(path.join(dir,'applied'))).toBe(true);}
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
it('awaits the actual storage import before reporting success',()=>run(false));
it('bounds a hung import and awaits cleanup without exposing state',()=>run(true));
it('closes a probe whose creation response arrives after the deadline',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-late-target-'));
 try{
  const closed=path.join(dir,'closed');
  fs.writeFileSync(path.join(dir,'fetch.cjs'),`global.fetch=async()=>({ok:true,json:async()=>({data:[{index:0,is_active:true}]})});`);
  fs.writeFileSync(path.join(dir,'index.js'),`const fs=require('fs');let created=false;const cdp={send:async(method)=>{if(method==='Target.getTargets')return{targetInfos:[{targetId:'original',type:'page'},...(created?[{targetId:'probe',type:'page'}]:[])]};if(method==='Target.createTarget'){created=true;await new Promise(r=>setTimeout(r,300));return{targetId:'probe'}};if(method==='Target.closeTarget'){created=false;fs.writeFileSync(${JSON.stringify(closed)},'yes');return{success:true}}}};module.exports={chromium:{connectOverCDP:async()=>({contexts:()=>[{}],newBrowserCDPSession:async()=>cdp,close:async()=>{}})}};`);
  let output='';
  try{await exec(process.execPath,['--require',path.join(dir,'fetch.cjs'),helper,'export','--vendor',dir,'--out',path.join(dir,'out'),'--origin','http://test.invalid'],{env:{...process.env,BROWSER_STORAGE_DEADLINE_MS:'150'},timeout:3000});throw new Error('expected deadline');}
  catch(e:any){expect(e.code).toBe(1);output=e.stdout;}
  expect(JSON.parse(output).code).toBe('storage_deadline');expect(fs.existsSync(closed)).toBe(true);
  expect(fs.existsSync(path.join(dir,'out'))).toBe(false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
