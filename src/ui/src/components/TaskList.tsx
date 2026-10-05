import {useMemo,useState} from 'react';
import {api,ApiError} from '../api';
import type {Task} from '../types';
import {taskStatusLabels,taskStatusTone,type TaskFeed} from '../taskStatus';
import {filterCounts,groupTasks,matchesQuery,taskFilters,taskTime,type TaskFilter} from '../taskGroups';
import {MessageTime,TaskDuration,useDisplayClock} from './MessageTime';

/** Shares the inbox's live feed; browsing tasks never starts a second poller. */
export function TaskList({feed,onDetails,onExpired}:{feed:TaskFeed;onDetails:(task:Task)=>void;onExpired:()=>void}) {
  const [older,setOlder]=useState<Task[]>([]);
  const [cursor,setCursor]=useState<number|null|undefined>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [filter,setFilter]=useState<TaskFilter>('all');
  const [query,setQuery]=useState('');
  const tasks=useMemo(()=>{
    const map=new Map(older.map(t=>[t.id,t]));for(const t of feed.tasks){if(!map.has(t.id)||t.revision>=map.get(t.id)!.revision)map.set(t.id,t);}
    return [...map.values()].filter(t=>!t.mergedInto);
  },[older,feed.tasks]);
  const now=useDisplayClock(tasks.some(t=>['running','stopping'].includes(t.status)));
  const found=useMemo(()=>tasks.filter(t=>matchesQuery(t,query)),[tasks,query]);
  const counts=useMemo(()=>filterCounts(found),[found]);
  const groups=useMemo(()=>groupTasks(found,filter,now),[found,filter,now]);
  const narrowed=filter!=='all'||query.trim()!=='';
  const next=cursor===undefined?feed.nextBefore:cursor;
  const load=async()=>{
    if(busy||next===null)return;setBusy(true);setError(null);
    try{const data=await api.main(next);setOlder(old=>[...old,...data.tasks]);setCursor(data.nextBefore);}
    catch(err){if(err instanceof ApiError&&err.status===401)onExpired();setError(err instanceof Error?err.message:'读取失败');}
    finally{setBusy(false);}
  };
  return <section className="task-list-page" aria-label="任务列表">
    <header className="chat-head"><div className="chat-title"><h2>任务列表</h2><span className="task-list-sub muted tiny">{feed.connected?`${narrowed?`${groups.reduce((n,g)=>n+g.tasks.length,0)} / `:''}${tasks.length} 项任务 · 状态实时更新`:'正在重新连接…'}</span></div></header>
    <div className="task-list-scroll">
      {!feed.connected&&<p className="banner warn" role="status">连接恢复后自动更新任务状态。</p>}
      {feed.connected&&!tasks.length&&<div className="empty"><h3>还没有任务</h3><p>在主会话交代事情后，就会显示在这里。</p></div>}
      {tasks.length>0&&<div className="task-list-tools">
        <div className="task-filters" role="group" aria-label="按状态筛选">{taskFilters.map(f=><button key={f.id} type="button" className={`task-filter ${f.id}`} aria-pressed={filter===f.id} onClick={()=>setFilter(f.id)}>
          {f.label}<span className={`task-filter-count${f.id==='attention'&&counts.attention?' due':''}`}>{counts[f.id]}</span>
        </button>)}</div>
        <input type="search" className="task-search" placeholder="搜索任务" aria-label="搜索任务" value={query} onChange={e=>setQuery(e.target.value)}/>
      </div>}
      {tasks.length>0&&!groups.length&&<div className="empty"><h3>没有符合条件的任务</h3><p>{next!==null?'只在已加载的任务里查找，可以加载更早的任务再看。':'换个条件试试。'}</p><button type="button" className="ghost" onClick={()=>{setFilter('all');setQuery('');}}>清除筛选</button></div>}
      {groups.map(g=><section key={g.key} className="task-group" data-group={g.key} aria-label={g.label}>
        <h3 className="task-group-head">{g.label}<span className="task-group-count">{g.tasks.length}</span></h3>
        <ul className="task-list">{g.tasks.map(t=><li key={t.id} data-task-id={t.id}>
          <button className="task-list-item" onClick={()=>onDetails(t)} aria-label={`打开任务：${t.title}`}>
            <div className="task-list-top"><strong>{t.title}</strong><span className={`task-status-badge ${taskStatusTone(t)}`}>{t.waitReason?.label??taskStatusLabels[t.status]??t.status}</span></div>
            <p className="task-list-summary">{t.clarification||t.description||t.text}</p>
            <div className="task-list-meta"><MessageTime at={taskTime(t)} now={now}/><TaskDuration task={t} now={now}/>{t.schedule&&<span className="task-tag" title={`定时任务：${t.schedule.title}`}>定时</span>}<span className="spacer"/><span aria-hidden="true">›</span></div>
          </button>
        </li>)}</ul>
      </section>)}
      {error&&<p className="error" role="alert">{error}</p>}
      {next!==null&&<button className="ghost task-list-more" disabled={busy} onClick={()=>void load()}>{busy?'加载中…':'加载更早的任务'}</button>}
    </div>
  </section>;
}
