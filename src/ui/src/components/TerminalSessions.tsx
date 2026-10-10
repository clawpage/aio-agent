import {useEffect, useRef, useState} from "react";
import {api} from "../api";
import {t} from "../i18n";

type Session = Awaited<ReturnType<typeof api.terminalSessions>>["sessions"][number];
const labels: Record<string,string> = t.workspace.terminal.status;
const shortId=(id:string)=>id.length>16?`${id.slice(0,8)}…${id.slice(-4)}`:id;
const sortSessions=(sessions:Session[])=>[...sessions].sort((a,b)=>Number(b.status==='running')-Number(a.status==='running') || (b.lastUsedAt??'').localeCompare(a.lastUsedAt??'') || a.id.localeCompare(b.id));

export function TerminalSessions({active,selectedId,onSelect,onNotify}:{active:boolean;selectedId:string|null;onSelect:(id:string|null)=>void;onNotify:(message:string,tone?:"error")=>void}) {
  const [sessions,setSessions]=useState<Session[]|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [actionError,setActionError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [mutation,setMutation]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0);
  const [expanded,setExpanded]=useState(false);
  const [confirm,setConfirm]=useState<Session|null>(null);
  const [frame,setFrame]=useState<string|null>(null);
  const [frameError,setFrameError]=useState<string|null>(null);
  const [frameAttempt,setFrameAttempt]=useState(0);
  const root=useRef<HTMLElement>(null);
  const picker=useRef<HTMLButtonElement>(null);
  const current=useRef({selectedId,onSelect});current.current={selectedId,onSelect};
  const locked=useRef(false);
  useEffect(()=>{
    if(!active||mutation) return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=async()=>{
      setBusy(true);
      try {
        const result=await api.terminalSessions(abort.signal);
        if(abort.signal.aborted||locked.current) return;
        setSessions(result.sessions);setError(null);
        if(!result.sessions.some(s=>s.id===current.current.selectedId))current.current.onSelect(sortSessions(result.sessions)[0]?.id??null);
      } catch(err) {
        if(!abort.signal.aborted) setError(err instanceof Error?err.message:t.workspace.terminal.readFailed);
      } finally {
        if(!abort.signal.aborted){setBusy(false);timer=setTimeout(()=>void refresh(),5000);}
      }
    };
    void refresh();
    return ()=>{abort.abort();clearTimeout(timer);};
  },[active,attempt,mutation]);
  const closingSelected=!!selectedId && mutation===selectedId;
  const selectedExists=!!sessions?.some(s=>s.id===selectedId);
  useEffect(()=>{
    let cancelled=false;setFrame(null);setFrameError(null);
    if(active && selectedId && selectedExists && !closingSelected)void api.ticket(`/terminal?session_id=${encodeURIComponent(selectedId)}`).then(ticket=>{if(!cancelled)setFrame(ticket.url);}).catch(err=>{if(!cancelled)setFrameError(err instanceof Error?err.message:t.workspace.terminal.connectFailed);});
    return ()=>{cancelled=true;};
  },[active,selectedId,selectedExists,closingSelected,frameAttempt]);
  useEffect(()=>{
    if(!expanded)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setExpanded(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setExpanded(false);picker.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[expanded]);
  const sorted=sortSessions(sessions??[]);
  const selected=sessions?.find(s=>s.id===selectedId);
  const choose=(id:string)=>{if(locked.current)return;onSelect(id);setExpanded(false);setConfirm(null);};
  const copy=async(id:string)=>{try{await navigator.clipboard.writeText(id);onNotify(t.workspace.terminal.copied);}catch{onNotify(t.workspace.terminal.copyFailed,'error');}};
  const create=async()=>{
    if(locked.current)return;locked.current=true;setMutation('new');setActionError(null);
    try {const {id}=await api.createTerminalSession();setSessions(old=>[...(old??[]),{id,status:'ready',workingDir:'',lastUsedAt:null}]);onSelect(id);setExpanded(false);}
    catch(err){setActionError(err instanceof Error?err.message:t.workspace.terminal.createFailed);}
    finally{locked.current=false;setMutation(null);setAttempt(n=>n+1);}
  };
  const close=async(s:Session)=>{
    if(locked.current)return;locked.current=true;setMutation(s.id);setConfirm(null);setActionError(null);
    try {await api.closeTerminalSession(s.id);const remaining=sorted.filter(t=>t.id!==s.id);setSessions(remaining);if(current.current.selectedId===s.id)onSelect(remaining[0]?.id??null);onNotify(t.workspace.terminal.closed);}
    catch(err){setActionError(err instanceof Error?err.message:t.workspace.terminal.closeFailed);}
    finally{locked.current=false;setMutation(null);setAttempt(n=>n+1);}
  };
  // The sandbox cannot say whether a command is running in a terminal, and closing interrupts it: always ask.
  const requestClose=(s:Session)=>setConfirm(s);
  return <section className="terminal-panel" aria-label={t.workspace.terminal.panel}>
    <section ref={root} className="terminal-sessions" aria-label={t.workspace.terminal.activeSessions}>
      <div className="terminal-sessions-head">
        <button ref={picker} className="terminal-picker" aria-label={t.workspace.terminal.switchSession} aria-expanded={expanded} aria-controls="terminal-session-list" disabled={!sessions?.length||!!mutation} onClick={()=>setExpanded(v=>!v)}>
          <span aria-hidden>⌘</span><span className="terminal-picker-text"><strong>{selected?shortId(selected.id):t.workspace.terminal.choose}</strong><small>{selected?.workingDir||t.workspace.terminal.sessionCount(sessions?.length??0)}</small></span>
          {selected && <span className={`terminal-session-status ${selected.status==='running'?'running':''}`}>{labels[selected.status]??selected.status}</span>}<span className="terminal-count">{sessions?.length??0}</span><span aria-hidden>⌄</span>
        </button>
        <button className="ghost terminal-icon" disabled={busy||!active||!!mutation} onClick={()=>setAttempt(n=>n+1)} aria-label={t.workspace.terminal.refreshLabel} title={t.workspace.terminal.refresh}>↻</button>
        <button className="ghost terminal-icon" disabled={!active||!!mutation} onClick={()=>void create()} aria-label={t.workspace.terminal.create} title={t.workspace.terminal.create}>＋</button>
        <button className="ghost terminal-icon" disabled={!selected||!!mutation} onClick={()=>selected&&requestClose(selected)} aria-label={t.workspace.terminal.closeCurrent} title={t.workspace.terminal.closeCurrent}>×</button>
      </div>
      {expanded && <div className="terminal-session-menu" id="terminal-session-list"><div className="terminal-menu-label">{t.workspace.terminal.menuLabel(sorted.length)}</div><ul>{sorted.map(s=><li key={s.id} className={selectedId===s.id?'selected':''}>
        <button className="terminal-session-choice" onClick={()=>choose(s.id)} aria-label={t.workspace.terminal.switchTo(s.id)} aria-current={selectedId===s.id?'true':undefined} disabled={!!mutation}>
          <span className="terminal-session-info"><code title={s.id}>{shortId(s.id)}</code><span title={s.workingDir}>{s.workingDir||t.workspace.terminal.noWorkingDir}</span></span><span className={`terminal-session-status ${s.status==='running'?'running':''}`}>{labels[s.status]??s.status}</span>
        </button>
        <button className="ghost terminal-icon" aria-label={t.workspace.terminal.copyId(s.id)} title={t.workspace.terminal.copyFullId} onClick={()=>void copy(s.id)}>⧉</button>
        <button className="ghost terminal-icon" aria-label={t.workspace.terminal.closeSession(s.id)} title={t.workspace.terminal.close} disabled={!!mutation} onClick={()=>requestClose(s)}>×</button>
      </li>)}</ul></div>}
      {confirm && <div className="terminal-confirm" role="alert"><span>{t.workspace.terminal.confirmClose(shortId(confirm.id))}</span><button className="ghost tiny" onClick={()=>setConfirm(null)}>{t.workspace.terminal.cancel}</button><button className="danger tiny" onClick={()=>void close(confirm)}>{t.workspace.terminal.confirm}</button></div>}
      {actionError && <p className="error tiny" role="alert">{actionError}</p>}
      {error && <p className="error tiny" role="alert">{error}{sessions?t.workspace.terminal.keptLast:''}</p>}
    </section>
    <div className="terminal-screen">
      {!active?<p className="muted">{t.workspace.terminal.paused}</p>:mutation===selectedId&&selectedId?<p className="muted">{t.workspace.terminal.closing}</p>:frame?<iframe src={frame} title={t.workspace.terminal.frameTitle} allow="clipboard-read; clipboard-write"/>:frameError?<div role="alert"><p>{frameError}</p><button className="ghost" onClick={()=>setFrameAttempt(n=>n+1)}>{t.workspace.terminal.retry}</button></div>:selectedId?<p className="muted">{t.workspace.terminal.connecting}</p>:<div className="terminal-empty"><span aria-hidden>⌘</span><p>{sessions===null?t.workspace.terminal.loading:t.workspace.terminal.empty}</p><button className="primary" disabled={!!mutation} onClick={()=>void create()}>{t.workspace.terminal.create}</button></div>}
    </div>
  </section>;
}
