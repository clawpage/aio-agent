import type {Task} from './types';
import {taskBucket,type TaskFilter} from '../../common/taskList';

export const taskFilters:{id:TaskFilter;label:string}[]=[
  {id:'all',label:'全部'},{id:'attention',label:'轮到你'},{id:'working',label:'进行中'},{id:'done',label:'已完成'},{id:'stopped',label:'失败·停止'},
];
export interface TaskGroup {key:string;label:string;tasks:Task[]}

const DAY=86_400_000;
const WEEKDAYS=['周日','周一','周二','周三','周四','周五','周六'];

/** The moment a row shows and is dated by: when it finished, else when it was asked. */
export const taskTime=(task:Task)=>task.completedAt??task.createdAt;

const startOfDay=(at:number)=>{const d=new Date(at);d.setHours(0,0,0,0);return d.getTime();};

/** Local-calendar bucket: one per day for the last week, one per month before that. */
export function dateBucket(at:number,now:number):{key:string;label:string} {
  const d=new Date(at),today=startOfDay(now),day=startOfDay(at);
  const days=Math.round((today-day)/DAY);
  if(days<=0)return {key:'d0',label:'今天'};
  if(days===1)return {key:'d1',label:'昨天'};
  if(days<7)return {key:`d${days}`,label:`${WEEKDAYS[d.getDay()]} · ${d.getMonth()+1}月${d.getDate()}日`};
  const sameYear=d.getFullYear()===new Date(now).getFullYear();
  return {key:`m${d.getFullYear()}-${d.getMonth()}`,label:sameYear?`${d.getMonth()+1}月`:`${d.getFullYear()}年${d.getMonth()+1}月`};
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
