import type {Task} from './types';
import {t} from './i18n';

export const taskStatusLabels:Record<string,string>=t.app.taskStatus;
export function taskStatusTone(task:Task):string {
  if(['needs_input','blocked','unknown','merge_unknown'].includes(task.status))return 'attention';
  if(['failed','planning_failed','merge_failed'].includes(task.status))return 'error';
  if(task.status==='completed')return 'done';
  if(['running','planning','queued','waiting','stopping'].includes(task.status))return 'working';
  return 'muted';
}
export interface TaskFeed {tasks:Task[];nextBefore:number|null;connected:boolean}
