import {it,expect,vi} from 'vitest';
import {startHarness} from '../helpers/harness.js';
import {readSoul,writeSoul} from '../../src/control/soul.js';
import {EXPERIENCE_POLICY} from '../../src/control/codex/experience.js';

it('reads current SOUL for planning, new execution and resume without rewriting user text or the active turn',async()=>{
 const h=await startHarness();
 try {
  const start=vi.spyOn(h.codex,'startThread');const resume=vi.spyOn(h.codex,'resumeThread');
  const plan=vi.fn().mockResolvedValue(JSON.stringify({title:'身份测试',related:[],dependencies:[],resources:[]}));
  Object.assign(h.codex,{planTask:plan});
  const firstSoul='# SOUL.md\n你是 AIO 个人助理。';
  writeSoul(h.ctx.cfg,firstSoul,readSoul(h.ctx.cfg).revision);
  const task=h.ctx.tasks.submit({text:'你是谁',clientMessageId:'soul-identity'}).task;
  await vi.waitFor(()=>expect(h.codex.startedTurns.length).toBe(1));
  expect(plan).toHaveBeenCalledWith(expect.stringContaining('你是谁'),firstSoul);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({developerInstructions:`${firstSoul}\n\n${EXPERIENCE_POLICY}`}));
  expect(h.codex.startedTurns[0]!.text).not.toContain(firstSoul);
  const prompt=h.codex.startedTurns[0]!.text;
  expect(prompt).toContain('默认在对话中直接给出完整回答');
  expect(prompt).toContain('只有确实需要写文件时才创建任务目录');
  expect(prompt).toContain('身份与风格以已注入的 SOUL.md 为准');
  expect(prompt).not.toContain('完整内容放在文档');
  const nextSoul='# SOUL.md\n轻松一点，偶尔幽默，认真办事。';
  writeSoul(h.ctx.cfg,nextSoul,readSoul(h.ctx.cfg).revision);
  expect(resume).not.toHaveBeenCalled();expect(h.codex.startedTurns.length).toBe(1);
  h.codex.completeTurn(h.codex.startedTurns[0]!.turnId);
  await vi.waitFor(()=>expect(h.ctx.tasks.get(task.id)?.status).toBe('completed'));
  h.ctx.tasks.submit({text:'继续',clientMessageId:'soul-resume',relatedTaskId:task.id});
  await vi.waitFor(()=>expect(h.codex.startedTurns.length).toBe(2));
  expect(resume).toHaveBeenLastCalledWith(h.codex.startedTurns[0]!.threadId,`${nextSoul}\n\n${EXPERIENCE_POLICY}`);
  expect(start).toHaveBeenCalledTimes(1);
  h.codex.completeTurn(h.codex.startedTurns[1]!.turnId);
 }finally{await h.shutdown();}
});
