import {useMemo,useState} from 'react';
import {api,ApiError} from '../api';
import type {Task} from '../types';
import {taskStatusLabels,taskStatusTone,type TaskFeed} from '../taskStatus';
import {MessageTime,TaskDuration,useDisplayClock} from './MessageTime';

/** Shares the inbox's live feed; browsing tasks never starts a second poller. */
export function TaskList({feed,onDetails,onExpired}:{feed:TaskFeed;onDetails:(task:Task)=>void;onExpired:()=>void}) {
  const [older,setOlder]=useState<Task[]>([]);
  const [cursor,setCursor]=useState<number|null|undefined>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const tasks=useMemo(()=>{
    const map=new Map(older.map(t=>[t.id,t]));for(const t of feed.tasks){if(!map.has(t.id)||t.revision>=map.get(t.id)!.revision)map.set(t.id,t);}
    return [...map.values()].filter(t=>!t.mergedInto).sort((a,b)=>{
      const priority=(t:Task)=>['needs_input','blocked'].includes(t.status)?0:['planning','running','waiting','queued','stopping'].includes(t.status)?1:2;
      return priority(a)-priority(b)||(b.completedAt??b.createdAt)-(a.completedAt??a.createdAt);
    });
  },[older,feed.tasks]);
  const now=useDisplayClock(tasks.some(t=>['running','stopping'].includes(t.status)));
  const next=cursor===undefined?feed.nextBefore:cursor;
  const load=async()=>{
    if(busy||next===null)return;setBusy(true);setError(null);
    try{const data=await api.main(next);setOlder(old=>[...old,...data.tasks]);setCursor(data.nextBefore);}
    catch(err){if(err instanceof ApiError&&err.status===401)onExpired();setError(err instanceof Error?err.message:'读取失败');}
    finally{setBusy(false);}
  };
  return <section className="task-list-page" aria-label="任务列表">
    <header className="chat-head"><div className="chat-title"><h2>任务列表</h2><span className="task-list-sub muted tiny">{feed.connected?`${tasks.length} 项任务 · 状态实时更新`:'正在重新连接…'}</span></div></header>
    <div className="task-list-scroll">
      {!feed.connected&&<p className="banner warn" role="status">连接恢复后自动更新任务状态。</p>}
      {feed.connected&&!tasks.length&&<div className="empty"><h3>还没有任务</h3><p>在主会话交代事情后，就会显示在这里。</p></div>}
      <ul className="task-list">{tasks.map(t=><li key={t.id} data-task-id={t.id}>
        <button className="task-list-item" onClick={()=>onDetails(t)} aria-label={`打开任务：${t.title}`}>
          <div className="task-list-top"><strong>{t.title}</strong><span className={`task-status-badge ${taskStatusTone(t)}`}>{t.waitReason?.label??taskStatusLabels[t.status]??t.status}</span></div>
          <p className="task-list-summary">{t.clarification||t.description||t.text}</p>
          <div className="task-list-meta"><MessageTime at={t.completedAt??t.createdAt} now={now}/><TaskDuration task={t} now={now}/><span className="spacer"/><span aria-hidden="true">›</span></div>
        </button>
      </li>)}</ul>
      {error&&<p className="error" role="alert">{error}</p>}
      {next!==null&&<button className="ghost" disabled={busy} onClick={()=>void load()}>{busy?'加载中…':'加载更早的任务'}</button>}
    </div>
  </section>;
}
