import type {Task} from './types';

export type TaskFilter='all'|'attention'|'working'|'done'|'stopped';
export const taskFilters:{id:TaskFilter;label:string}[]=[
  {id:'all',label:'全部'},{id:'attention',label:'轮到你'},{id:'working',label:'进行中'},{id:'done',label:'已完成'},{id:'stopped',label:'失败·停止'},
];
export interface TaskGroup {key:string;label:string;tasks:Task[]}

const ATTENTION=['needs_input','blocked','unknown','merge_unknown'];
const WORKING=['planning','waiting','queued','running','stopping','merging','steering'];
const DAY=86_400_000;
const WEEKDAYS=['周日','周一','周二','周三','周四','周五','周六'];

/** Which filter a task falls under; a browser waiting on the person counts as their turn. */
export function taskFilterOf(task:Task):Exclude<TaskFilter,'all'> {
  if(ATTENTION.includes(task.status)||task.browser?.request)return 'attention';
  if(WORKING.includes(task.status))return 'working';
  return ['completed','merged'].includes(task.status)?'done':'stopped';
}

/** The moment a row shows and is dated by: when it finished, else when it was asked. */
export const taskTime=(task:Task)=>task.completedAt??task.createdAt;

export function matchesQuery(task:Task,query:string):boolean {
  const q=query.trim().toLowerCase();
  return !q||[task.title,task.description,task.clarification,task.text,task.schedule?.title].some(s=>s?.toLowerCase().includes(q));
}

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
 * Newest first. Under "all", what is the person's turn and what is still running
 * come first as their own groups; everything else is grouped by date.
 */
export function groupTasks(tasks:Task[],filter:TaskFilter,now:number):TaskGroup[] {
  const sorted=[...tasks].sort((a,b)=>taskTime(b)-taskTime(a));
  const groups:TaskGroup[]=[];
  const dated=new Map<string,TaskGroup>();
  if(filter==='all')for(const id of ['attention','working'] as const){
    const rows=sorted.filter(t=>taskFilterOf(t)===id);
    if(rows.length)groups.push({key:id,label:taskFilters.find(f=>f.id===id)!.label,tasks:rows});
  }
  for(const t of sorted){
    if(filter==='all'?['attention','working'].includes(taskFilterOf(t)):taskFilterOf(t)!==filter)continue;
    const {key,label}=dateBucket(taskTime(t),now);
    let group=dated.get(key);
    if(!group){group={key,label,tasks:[]};dated.set(key,group);groups.push(group);}
    group.tasks.push(t);
  }
  return groups;
}

export function filterCounts(tasks:Task[]):Record<TaskFilter,number> {
  const counts:Record<TaskFilter,number>={all:tasks.length,attention:0,working:0,done:0,stopped:0};
  for(const t of tasks)counts[taskFilterOf(t)]++;
  return counts;
}
