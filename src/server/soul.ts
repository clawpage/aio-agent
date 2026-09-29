import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Config} from './config.js';

export const DEFAULT_SOUL = `# SOUL.md

你是 AIO Agent，用户的个人 AI 助理。

- 以第一人称直接与用户交流，保持自然、简洁、可靠。被问“你是谁”时介绍你作为个人助理的身份与能力，不主动用派单器、子 agent 等内部架构描述自己；用户明确询问技术实现或底层模型时如实回答。
- 优先解决用户的问题，完成后先给结果和交付物。工具、skill 和命令等过程细节默认收在过程里。
- 能合理判断的事情主动处理；只有缺少真正必要的信息时才克制地追问，尽量一次问齐。
- 清楚区分已完成、进行中与尚未核实；不编造事实、执行结果或文件链接。
- 默认使用中文，用户指定其他语言时遵循用户要求。
`;
export const SOUL_MAX_BYTES = 64 * 1024;
export class SoulError extends Error { constructor(public status:number,message:string){super(message);} }
const revision=(content:string)=>createHash('sha256').update(content).digest('hex');
function validate(content:unknown):asserts content is string {
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>SOUL_MAX_BYTES||content.includes('\0'))throw new SoulError(400,'SOUL.md 必须是有效文本，大小不超过 64 KB。');
}
/** Control-plane owned, outside the agent's writable sandbox workspace. */
export function readSoul(cfg:Pick<Config,'dataDir'>) {
  const file=path.join(cfg.dataDir,'SOUL.md');
  fs.mkdirSync(cfg.dataDir,{recursive:true});
  try{fs.writeFileSync(file,DEFAULT_SOUL,{encoding:'utf8',mode:0o600,flag:'wx'});}catch(err){if((err as NodeJS.ErrnoException).code!=='EEXIST')throw err;}
  const content=fs.readFileSync(file,'utf8');validate(content);
  return {content,revision:revision(content)};
}
export function writeSoul(cfg:Pick<Config,'dataDir'>,content:unknown,expectedRevision:unknown) {
  validate(content);
  if(typeof expectedRevision!=='string')throw new SoulError(400,'请先加载 SOUL.md 再保存。');
  if(readSoul(cfg).revision!==expectedRevision)throw new SoulError(409,'SOUL.md 已在其他页面修改，请重新加载后合并你的修改。');
  const file=path.join(cfg.dataDir,'SOUL.md');const temp=`${file}.${randomUUID()}.tmp`;
  try{fs.writeFileSync(temp,content,{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
  return {content,revision:revision(content)};
}
