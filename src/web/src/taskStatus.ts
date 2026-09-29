import type {Task} from './types';

export const taskStatusLabels:Record<string,string>={planning:'正在分配',needs_input:'等你补充',planning_failed:'分配失败',waiting:'等待执行',queued:'排队中',running:'进行中',stopping:'正在停止',completed:'已完成',failed:'执行失败',interrupted:'已停止',unknown:'结果待核对',blocked:'需要补充',merging:'正在追加',steering:'正在追加',merged:'已补充',merge_failed:'补充失败',merge_unknown:'送达待核对'};
export function taskStatusTone(task:Task):string {
  if(['needs_input','blocked','unknown','merge_unknown'].includes(task.status))return 'attention';
  if(['failed','planning_failed','merge_failed'].includes(task.status))return 'error';
  if(task.status==='completed')return 'done';
  if(['running','planning','queued','waiting','stopping'].includes(task.status))return 'working';
  return 'muted';
}
export interface TaskFeed {tasks:Task[];nextBefore:number|null;connected:boolean}
