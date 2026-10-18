import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readSoul,writeSoul,DEFAULT_SOUL,PREVIOUS_DEFAULTS,SOUL_MAX_BYTES} from '../../src/control/soul.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
describe('SOUL.md persistence',()=>{
 it('creates a private default, preserves exact text, rejects stale saves and allows clearing',()=>{
  const cfg={dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aio-soul-'))};dirs.push(cfg.dataDir);
  const original=readSoul(cfg);expect(original.content).toBe(DEFAULT_SOUL);
  expect(fs.statSync(path.join(cfg.dataDir,'SOUL.md')).mode&0o777).toBe(0o600);
  const content='# Soul\r\n\n你是小助理。  \n';const saved=writeSoul(cfg,content,original.revision);
  expect(readSoul(cfg)).toEqual(saved);expect(saved.content).toBe(content);
  expect(()=>writeSoul(cfg,'overwrite',original.revision)).toThrow('another page');
  expect(readSoul(cfg)).toEqual(saved);
  expect(()=>writeSoul(cfg,'a'.repeat(SOUL_MAX_BYTES+1),saved.revision)).toThrow('64 KB');
  expect(()=>writeSoul(cfg,'\0',saved.revision)).toThrow('valid text');
  expect(writeSoul(cfg,'',saved.revision).content).toBe('');expect(readSoul(cfg).content).toBe('');
 });
 it('moves an unedited earlier default (both Chinese ones) to the English one and leaves an edited one alone',()=>{
  expect(DEFAULT_SOUL).toContain('You are Clawpage Agent');
  expect(PREVIOUS_DEFAULTS.map(d=>d.split('\n')[2])).toEqual(['你是一站（英文名 Clawpage Agent），用户的个人 AI 助理。像一位靠谱、有好奇心、偶尔有点机灵的搭档：能把事情办妥，也能把话说得有人味。','你是 AIO Agent，用户的个人 AI 助理。像一位靠谱、有好奇心、偶尔有点机灵的搭档：能把事情办妥，也能把话说得有人味。']);
  for(const old of PREVIOUS_DEFAULTS){
   const cfg={dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aio-soul-'))};dirs.push(cfg.dataDir);
   const file=path.join(cfg.dataDir,'SOUL.md');
   fs.writeFileSync(file,old,{mode:0o600});
   expect(readSoul(cfg).content).toBe(DEFAULT_SOUL);expect(fs.readFileSync(file,'utf8')).toBe(DEFAULT_SOUL);
   expect(fs.statSync(file).mode&0o777).toBe(0o600);
   fs.writeFileSync(file,old+'\n我的补充\n');
   expect(readSoul(cfg).content).toBe(old+'\n我的补充\n');
  }
 });
});
