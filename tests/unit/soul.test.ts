import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readSoul,writeSoul,DEFAULT_SOUL,SOUL_MAX_BYTES} from '../../src/control/soul.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
describe('SOUL.md persistence',()=>{
 it('creates a private default, preserves exact text, rejects stale saves and allows clearing',()=>{
  const cfg={dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aio-soul-'))};dirs.push(cfg.dataDir);
  const original=readSoul(cfg);expect(original.content).toBe(DEFAULT_SOUL);
  expect(fs.statSync(path.join(cfg.dataDir,'SOUL.md')).mode&0o777).toBe(0o600);
  const content='# Soul\r\n\n你是小助理。  \n';const saved=writeSoul(cfg,content,original.revision);
  expect(readSoul(cfg)).toEqual(saved);expect(saved.content).toBe(content);
  expect(()=>writeSoul(cfg,'overwrite',original.revision)).toThrow('其他页面');
  expect(readSoul(cfg)).toEqual(saved);
  expect(()=>writeSoul(cfg,'a'.repeat(SOUL_MAX_BYTES+1),saved.revision)).toThrow('64 KB');
  expect(()=>writeSoul(cfg,'\0',saved.revision)).toThrow('有效文本');
  expect(writeSoul(cfg,'',saved.revision).content).toBe('');expect(readSoul(cfg).content).toBe('');
 });
});
