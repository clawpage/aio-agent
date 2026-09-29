import {it,expect,vi} from 'vitest';
import {startHarness} from '../helpers/harness.js';
import {readSoul,writeSoul} from '../../src/server/soul.js';

it('reads current SOUL for planning, new execution and resume without rewriting user text or the active turn',async()=>{
 const h=await startHarness({PA_AUTO_TITLE:'0'});
 try {
  const start=vi.spyOn(h.codex,'startThread');const resume=vi.spyOn(h.codex,'resumeThread');
  const plan=vi.fn().mockResolvedValue(JSON.stringify({title:'身份测试',related:[],dependencies:[],resources:[]}));
  Object.assign(h.codex,{planTask:plan});
  const firstSoul='# SOUL.md\n你是 AIO 个人助理。';
  writeSoul(h.ctx.cfg,firstSoul,readSoul(h.ctx.cfg).revision);
  const task=h.ctx.tasks.submit({text:'你是谁',clientMessageId:'soul-identity'}).task;
  await vi.waitFor(()=>expect(h.codex.startedTurns.length).toBe(1));
  expect(plan).toHaveBeenCalledWith(expect.stringContaining('你是谁'),firstSoul);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({developerInstructions:firstSoul}));
  expect(h.codex.startedTurns[0]!.text).not.toContain(firstSoul);
  writeSoul(h.ctx.cfg,'',readSoul(h.ctx.cfg).revision);
  expect(resume).not.toHaveBeenCalled();expect(h.codex.startedTurns.length).toBe(1);
  h.codex.completeTurn(h.codex.startedTurns[0]!.turnId);
  await vi.waitFor(()=>expect(h.ctx.tasks.get(task.id)?.status).toBe('completed'));
  h.ctx.tasks.submit({text:'继续',clientMessageId:'soul-resume',relatedTaskId:task.id});
  await vi.waitFor(()=>expect(h.codex.startedTurns.length).toBe(2));
  expect(resume).toHaveBeenLastCalledWith(h.codex.startedTurns[0]!.threadId,'');
  expect(start).toHaveBeenCalledTimes(1);
  h.codex.completeTurn(h.codex.startedTurns[1]!.turnId);
 }finally{await h.shutdown();}
});
