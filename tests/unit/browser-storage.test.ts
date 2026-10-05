import {it, expect} from 'vitest';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const helper=path.resolve('src/control/browser/scripts/browser-storage.cjs');
async function run(hang:boolean){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-storage-test-'));
 try {
  fs.writeFileSync(path.join(dir,'index.js'), `const fs=require('node:fs');module.exports={chromium:{connectOverCDP:async()=>({contexts:()=>[{cookies:async()=>[],addCookies:async()=>{await new Promise(r=>${hang?'void r':'setTimeout(r,120)'});fs.writeFileSync(${JSON.stringify(path.join(dir,'applied'))},'yes')}}],newBrowserCDPSession:async()=>({}),close:async()=>fs.writeFileSync(${JSON.stringify(path.join(dir,'cleaned'))},'yes')})}}`);
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

// A real Chromium: a profile that already holds cookies keeps them (and gets back
// only the session cookies a restart lost); an empty profile is rebuilt whole.
const hasChromium=fs.existsSync(chromium.executablePath());
async function freePort(){return new Promise<number>(resolve=>{const srv=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=srv.address() as net.AddressInfo;srv.close(()=>resolve(port));});});}
async function withBrowser(fn:(endpoint:string)=>Promise<void>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-storage-real-'));
 const port=await freePort();
 const proc=spawn(chromium.executablePath(),['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(dir,'profile')}`,'--no-first-run','about:blank'],{stdio:'ignore'});
 const endpoint=`http://127.0.0.1:${port}`;
 try{
  for(let i=0;i<100;i++){try{if((await fetch(`${endpoint}/json/version`)).ok)break;}catch{/* starting */}await new Promise(r=>setTimeout(r,100));}
  await fn(endpoint);
 }finally{const gone=new Promise(r=>proc.once('exit',r));proc.kill('SIGKILL');await gone;fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
async function importState(endpoint:string,state:unknown){
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'browser-storage-in-')),'state.json');
 fs.writeFileSync(file,JSON.stringify({schema:1,state}));
 try{return JSON.parse((await exec(process.execPath,[helper,'import','--vendor',path.resolve('node_modules/playwright-core'),'--endpoint',endpoint,'--in',file],{timeout:20000})).stdout);}
 finally{fs.rmSync(path.dirname(file),{recursive:true,force:true});}
}
const later=Math.floor(Date.now()/1000)+86400*365;
const snapshot={cookies:[
 {name:'a1',value:'old-device',domain:'.example.test',path:'/',expires:later,httpOnly:false,secure:false,sameSite:'Lax'},
 {name:'web_session',value:'old-session',domain:'.example.test',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'},
 {name:'lost_on_restart',value:'s',domain:'.example.test',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'},
 {name:'stale',value:'x',domain:'.example.test',path:'/',expires:Math.floor(Date.now()/1000)-60,httpOnly:false,secure:false,sameSite:'Lax'},
],origins:[]};
it.skipIf(!hasChromium)('never rolls a live profile back to a snapshot, and adds back only what it lost',()=>withBrowser(async(endpoint)=>{
 const browser=await chromium.connectOverCDP(endpoint);
 try{
  const context=browser.contexts()[0]!;
  // Since the snapshot the person signed in again and the site renewed its device id.
  await context.addCookies([
   {name:'a1',value:'new-device',domain:'.example.test',path:'/',expires:later},
   {name:'web_session',value:'new-session',domain:'.example.test',path:'/',expires:later},
   {name:'since',value:'1',domain:'.example.test',path:'/',expires:later},
  ]);
  const out=await importState(endpoint,snapshot);
  expect(out).toMatchObject({ok:true,merged:{kept:3,added:1}});
  const jar=Object.fromEntries((await context.cookies()).map(c=>[c.name,c.value]));
  expect(jar).toEqual({a1:'new-device',web_session:'new-session',since:'1',lost_on_restart:'s'});
 }finally{await browser.close();}
}),30000);
it.skipIf(!hasChromium)('rebuilds an empty profile from the snapshot whole',()=>withBrowser(async(endpoint)=>{
 const out=await importState(endpoint,snapshot);
 expect(out.ok).toBe(true);
 expect(out.merged).toBeUndefined();
 const browser=await chromium.connectOverCDP(endpoint);
 try{
  const jar=Object.fromEntries((await browser.contexts()[0]!.cookies()).map(c=>[c.name,c.value]));
  expect(jar).toMatchObject({a1:'old-device',web_session:'old-session',lost_on_restart:'s'});
 }finally{await browser.close();}
}),30000);
it.skipIf(!hasChromium)('rebuilding an empty cookie jar never clears what the profile already holds',()=>withBrowser(async(endpoint)=>{
 const browser=await chromium.connectOverCDP(endpoint);
 try{
  const page=await browser.contexts()[0]!.newPage();
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<html></html>'}));
  await page.goto('https://example.test/');
  // Signed out (no cookies), but the profile still holds this site's local data.
  await page.evaluate(async()=>{
   localStorage.setItem('kept','live');localStorage.setItem('shared','live');
   await new Promise((resolve,reject)=>{const open=indexedDB.open('live-db',1);open.onupgradeneeded=()=>open.result.createObjectStore('s');open.onsuccess=()=>{open.result.close();resolve(null);};open.onerror=reject;});
   const file=await (await navigator.storage.getDirectory()).getFileHandle('draft.txt',{create:true});
   const writer=await file.createWritable();await writer.write('unsaved');await writer.close();
  });
  const out=await importState(endpoint,{cookies:snapshot.cookies,origins:[{origin:'https://example.test',
   localStorage:[{name:'shared',value:'old'},{name:'restored',value:'old'}],
   indexedDB:[{name:'old-db',version:2,stores:[{name:'s',autoIncrement:false,indexes:[],records:[
    {key:'plain',value:{a:1}},{key:'when',valueEncoded:{d:'2026-01-02T03:04:05.000Z'}}]}]}]}]});
  expect(out.ok).toBe(true);
  const after=await page.evaluate(async()=>{
   const read=(key:string)=>new Promise(resolve=>{const open=indexedDB.open('old-db');open.onsuccess=()=>{const get=open.result.transaction('s').objectStore('s').get(key);get.onsuccess=()=>{open.result.close();resolve(get.result);};};});
   const when=await read('when') as Date;
   return {ls:{...localStorage},dbs:(await indexedDB.databases()).map(d=>d.name).sort(),plain:await read('plain'),when:when instanceof Date?when.toISOString():null,
    opfs:await (await (await (await navigator.storage.getDirectory()).getFileHandle('draft.txt')).getFile()).text()};
  });
  expect(after).toEqual({ls:{kept:'live',shared:'live',restored:'old'},dbs:['live-db','old-db'],plain:{a:1},when:'2026-01-02T03:04:05.000Z',opfs:'unsaved'});
  const jar=Object.fromEntries((await browser.contexts()[0]!.cookies()).map(c=>[c.name,c.value]));
  expect(jar).toMatchObject({a1:'old-device',web_session:'old-session',lost_on_restart:'s'});
  expect(jar.stale).toBeUndefined();
 }finally{await browser.close();}
}),30000);
