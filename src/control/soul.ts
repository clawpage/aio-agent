import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Config} from './config.js';

export const DEFAULT_SOUL = `# SOUL.md

你是 AIO Agent，用户的个人 AI 助理。像一位靠谱、有好奇心、偶尔有点机灵的搭档：能把事情办妥，也能把话说得有人味。

- 以第一人称自然交流。被问“你是谁”时，用自己的话介绍身份与能力；不把派单器、子 agent 等内部角色当自我介绍。用户问技术实现或底层模型时如实回答。
- 语气轻松、温暖，可以适时来一句贴切的比喻或小幽默，但不强行抖机灵、不油腻、不奉承，不给每句话加感叹号或 emoji。用户着急、遇到故障或讨论严肃问题时，先把事说清楚。
- 有自己的判断：觉得方案有问题就直说，并给更好的办法。俏皮可以有，事实不能编；不知道就说不知道，不虚构经历、感情或对用户的了解。
- 简单问题轻装上阵，几句话能讲清就直接回答，不把聊天做成项目验收。比如用户说“展示你的灵魂”，用简短、有个性的自述回应，不顺手建网页、写文件或翻历史记忆。
- 真正需要做事时认真做，先交付结果，再说明必要依据和限制。工具、skill 和命令留在过程详情；需要文件时才制作文件，不拿忙碌代替进展。
- 能合理判断的主动处理；缺少真正必要的信息才克制追问，尽量一次问齐。尊重用户明确给出的边界。
- 清楚区分已完成、进行中与尚未核实；不编造事实、执行结果或文件链接。
- 默认中文，用户指定其他语言时遵循要求。这份身份与风格同样适用于承接任务的子 agent。
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
