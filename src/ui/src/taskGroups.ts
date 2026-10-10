import type {Task} from './types';
import {taskBucket,type TaskFilter} from '../../common/taskList';
import {t} from './i18n';

export const taskFilters:{id:TaskFilter;label:string}[]=[
  {id:'all',label:t.app.taskFilters.all},{id:'attention',label:t.app.taskFilters.attention},{id:'working',label:t.app.taskFilters.working},{id:'done',label:t.app.taskFilters.done},{id:'stopped',label:t.app.taskFilters.stopped},
];
export interface TaskGroup {key:string;label:string;tasks:Task[]}

const DAY=86_400_000;

/** The moment a row shows and is dated by: when it finished, else when it was asked. */
export const taskTime=(task:Task)=>task.completedAt??task.createdAt;

const startOfDay=(at:number)=>{const d=new Date(at);d.setHours(0,0,0,0);return d.getTime();};

/** Local-calendar bucket: one per day for the last week, one per month before that. */
export function dateBucket(at:number,now:number):{key:string;label:string} {
  const d=new Date(at),today=startOfDay(now),day=startOfDay(at);
  const days=Math.round((today-day)/DAY);
  if(days<=0)return {key:'d0',label:t.time.groups.today};
  if(days===1)return {key:'d1',label:t.time.groups.yesterday};
  if(days<7)return {key:`d${days}`,label:t.time.groups.weekday(d.getDay(),d.getMonth()+1,d.getDate())};
  const sameYear=d.getFullYear()===new Date(now).getFullYear();
  return {key:`m${d.getFullYear()}-${d.getMonth()}`,label:sameYear?t.time.groups.month(d.getMonth()+1):t.time.groups.yearMonth(d.getFullYear(),d.getMonth()+1)};
}

/**
 * Places rows, in the order the server sent them, under headings. Under "all"
 * the server puts the person's turn and running work first; they get their own
 * groups, and everything else is grouped by date.
 */
export function groupTasks(tasks:Task[],filter:TaskFilter,now:number):TaskGroup[] {
  const groups=new Map<string,TaskGroup>();
  for(const t of tasks){
    const bucket=taskBucket(t.status,Boolean(t.browser?.request));
    const pinned=filter==='all'&&(bucket==='attention'||bucket==='working');
    const {key,label}=pinned?{key:bucket,label:taskFilters.find(f=>f.id===bucket)!.label}:dateBucket(taskTime(t),now);
    let group=groups.get(key);
    if(!group){group={key,label,tasks:[]};groups.set(key,group);}
    group.tasks.push(t);
  }
  return [...groups.values()];
}
