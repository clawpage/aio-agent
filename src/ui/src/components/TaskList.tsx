import { InlineLoading } from "./Brand";
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api,ApiError} from '../api';
import type {Task} from '../types';
import type {TaskCounts,TaskFilter} from '../../../common/taskList';
import {taskStatusLabels,taskStatusTone,type TaskFeed} from '../taskStatus';
import {groupTasks,taskFilters,taskTime} from '../taskGroups';
import {MessageTime,TaskDuration,useDisplayClock} from './MessageTime';
import {t} from '../i18n';

const PAGE=30;
/** Work still going (or waiting for the person) can be stopped; a result never confirmed can be set aside. */
const STOPPABLE=new Set(['needs_input','blocked','planning','waiting','queued','running','merging']);
const endAction=(task:Task):'stop'|'archive'|null=>task.mergedInto?null:STOPPABLE.has(task.status)?'stop':task.status==='unknown'?'archive':null;

/**
 * The server counts, filters, searches and orders; this keeps the pages it has
 * loaded and asks for the next one as the end of the list scrolls into view.
 * A change in the inbox's live feed re-reads the counts and the loaded range.
 */
export function TaskList({feed,active,onDetails,onExpired}:{feed:TaskFeed;active:boolean;onDetails:(task:Task)=>void;onExpired:()=>void}) {
  const [filter,setFilter]=useState<TaskFilter>('all');
  const [typed,setTyped]=useState('');
  const [query,setQuery]=useState('');
  const [rows,setRows]=useState<Task[]>([]);
  const [counts,setCounts]=useState<TaskCounts|null>(null);
  const [next,setNext]=useState<string|null>(null);
  const [loading,setLoading]=useState<'reset'|'more'|null>(null);
  const [error,setError]=useState<string|null>(null);
  const seq=useRef(0);
  const loaded=useRef(false);
  const scroller=useRef<HTMLDivElement>(null);
  const sentinel=useRef<HTMLDivElement>(null);

  useEffect(()=>{const id=setTimeout(()=>setQuery(typed.trim()),250);return()=>clearTimeout(id);},[typed]);

  /** `reset` starts over, `refresh` re-reads the range already shown, `more` continues after it. */
  const fetchPage=useCallback(async(mode:'reset'|'refresh'|'more',from:{cursor:string|null;shown:number})=>{
    const ticket=++seq.current;
    if(mode!=='refresh')setLoading(mode==='more'?'more':'reset');
    try{
      const limit=mode==='refresh'?Math.min(Math.max(from.shown,PAGE),200):PAGE;
      const page=await api.taskPage({filter,query,cursor:mode==='more'?from.cursor:null,limit});
      if(ticket!==seq.current)return;
      setCounts(page.counts);setNext(page.nextCursor);setError(null);loaded.current=true;
      setRows(old=>{
        if(mode!=='more')return page.tasks;
        const seen=new Set(old.map(t=>t.id));return [...old,...page.tasks.filter(t=>!seen.has(t.id))];
      });
    }catch(err){
      if(ticket!==seq.current)return;
      if(err instanceof ApiError&&err.status===401)onExpired();
      setError(err instanceof Error?err.message:t.tasks.list.loadFailed);
    }finally{if(ticket===seq.current)setLoading(null);}
  },[filter,query,onExpired]);

  const state=useRef({next,shown:rows.length,loading});
  state.current={next,shown:rows.length,loading};

  // A new filter or search starts from the top; coming back to the page re-reads what it showed.
  useEffect(()=>{if(active)void fetchPage(loaded.current?'refresh':'reset',{cursor:null,shown:state.current.shown});},[active]);
  useEffect(()=>{loaded.current=false;scroller.current?.scrollTo({top:0});if(active)void fetchPage('reset',{cursor:null,shown:0});},[fetchPage]);
  // Statuses move between filters as work runs; follow the live feed while the page is open.
  useEffect(()=>{
    if(!active||!loaded.current)return;
    const id=setTimeout(()=>void fetchPage('refresh',{cursor:null,shown:state.current.shown}),400);
    return()=>clearTimeout(id);
  },[feed.tasks]);

  const more=useCallback(()=>{
    const s=state.current,box=scroller.current,end=sentinel.current;
    if(!active||!s.next||s.loading||!box||!end)return;
    if(end.getBoundingClientRect().top-box.getBoundingClientRect().bottom<400)void fetchPage('more',{cursor:s.next,shown:s.shown});
  },[active,fetchPage]);
  useEffect(()=>{
    const box=scroller.current,end=sentinel.current;
    if(!box||!end)return;
    const observer=new IntersectionObserver(()=>more(),{root:box,rootMargin:'0px 0px 400px 0px'});
    observer.observe(end);return()=>observer.disconnect();
  },[more]);
  // A short page leaves the end in view without a scroll: keep filling.
  useEffect(()=>{if(!loading)more();},[rows,next,loading,more]);

  // Between reads, show the feed's newer copy of a row so its status never lags.
  const shown=useMemo(()=>{
    const live=new Map(feed.tasks.map(t=>[t.id,t]));
    return rows.map(t=>{const l=live.get(t.id);return l&&l.revision>=t.revision?{...t,...l}:t;});
  },[rows,feed.tasks]);
  const now=useDisplayClock(shown.some(t=>['running','stopping'].includes(t.status)));
  const groups=useMemo(()=>groupTasks(shown,filter,now),[shown,filter,now]);
  const narrowed=filter!=='all'||query!=='';
  const clear=()=>{setFilter('all');setTyped('');setQuery('');};
  const [confirming,setConfirming]=useState<string|null>(null);
  const [ending,setEnding]=useState<string|null>(null);
  const end=async(task:Task,action:'stop'|'archive')=>{
    setEnding(task.id);setError(null);
    try{
      await (action==='stop'?api.stopTask(task.id):api.archiveTask(task.id));
      setConfirming(null);
      await fetchPage('refresh',{cursor:null,shown:state.current.shown});
    }catch(err){
      if(err instanceof ApiError&&err.status===401)onExpired();
      setError(err instanceof Error?err.message:(action==='stop'?t.tasks.end.stopFailed:t.tasks.end.archiveFailed));
    }finally{setEnding(null);}
  };

  return <section className="task-list-page" aria-label={t.tasks.list.title}>
    <header className="chat-head"><div className="chat-title"><h2>{t.tasks.list.title}</h2><span className="task-list-sub muted tiny">{feed.connected?`${counts?t.tasks.list.count(counts.all):''}${t.tasks.list.live}`:t.tasks.list.reconnecting}</span></div></header>
    <div className="task-list-scroll" ref={scroller}>
      {!feed.connected&&<p className="banner warn" role="status">{t.tasks.list.reconnectBanner}</p>}
      {counts&&counts.all===0&&!query&&<div className="empty"><h3>{t.tasks.list.emptyTitle}</h3><p>{t.tasks.list.emptyBody}</p></div>}
      {counts&&(counts.all>0||query)&&<div className="task-list-tools">
        <div className="task-filters" role="group" aria-label={t.tasks.list.filterGroup}>{taskFilters.map(f=><button key={f.id} type="button" className={`task-filter ${f.id}`} aria-pressed={filter===f.id} onClick={()=>setFilter(f.id)}>
          {f.label}<span className={`task-filter-count${f.id==='attention'&&counts.attention?' due':''}`}>{counts[f.id]}</span>
        </button>)}</div>
        <input type="search" className="task-search" placeholder={t.tasks.list.search} aria-label={t.tasks.list.search} value={typed} onChange={e=>setTyped(e.target.value)}/>
      </div>}
      {counts&&narrowed&&!rows.length&&!loading&&<div className="empty"><h3>{t.tasks.list.noMatchTitle}</h3><p>{t.tasks.list.noMatchBody}</p><button type="button" className="ghost" onClick={clear}>{t.tasks.list.clearFilters}</button></div>}
      {groups.map(g=><section key={g.key} className="task-group" data-group={g.key} aria-label={g.label}>
        <h3 className="task-group-head">{g.label}{(g.key==='attention'||g.key==='working')&&counts&&<span className="task-group-count">{counts[g.key]}</span>}</h3>
        <ul className="task-list">{g.tasks.map(task=>{const action=endAction(task);const stop=action==='stop';return <li key={task.id} data-task-id={task.id} className={action?'task-list-row ends':'task-list-row'}>
          <button className="task-list-item" onClick={()=>onDetails(task)} aria-label={t.tasks.list.open(task.title)}>
            <div className="task-list-top"><strong>{task.title}</strong><span className={`task-status-badge ${taskStatusTone(task)}`}>{task.waitReason?.label??taskStatusLabels[task.status]??task.status}</span></div>
            <p className="task-list-summary">{task.clarification||task.description||task.text}</p>
            <div className="task-list-meta"><MessageTime at={taskTime(task)} now={now}/><TaskDuration task={task} now={now}/>{task.schedule&&<span className="task-tag" title={t.tasks.list.scheduled(task.schedule.title)}>{t.tasks.list.scheduledTag}</span>}<span className="spacer"/><span aria-hidden="true">›</span></div>
          </button>
          {action&&<div className="task-list-end-action">{confirming===task.id
            ?<><button type="button" className="ghost tiny" disabled={ending===task.id} onClick={()=>setConfirming(null)}>{t.tasks.end.cancel}</button><button type="button" className="danger tiny" disabled={ending===task.id} onClick={()=>void end(task,action)}>{ending===task.id?(stop?t.tasks.end.stopping:t.tasks.end.archiving):(stop?t.tasks.end.confirmStop:t.tasks.end.confirmArchive)}</button></>
            :<button type="button" className="ghost tiny" aria-label={stop?t.tasks.end.stopLabel(task.title):t.tasks.end.archiveLabel(task.title)} title={stop?t.tasks.end.stopHint:t.tasks.end.archiveHint} onClick={()=>setConfirming(task.id)}>{stop?t.tasks.end.stop:t.tasks.end.archive}</button>}</div>}
        </li>;})}</ul>
      </section>)}
      {error&&<p className="error" role="alert">{error}{loading===null&&<> <button type="button" className="ghost" onClick={()=>void fetchPage(rows.length?'more':'reset',{cursor:next,shown:rows.length})}>{t.tasks.list.retry}</button></>}</p>}
      <div ref={sentinel} className="task-list-end" aria-live="polite">{loading?<span className="muted tiny"><InlineLoading label={t.tasks.list.loading}/></span>:rows.length>0&&!next?<span className="muted tiny">{t.tasks.list.noMore}</span>:null}</div>
    </div>
  </section>;
}
