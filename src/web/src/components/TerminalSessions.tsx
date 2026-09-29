import {useEffect, useRef, useState} from "react";
import {api} from "../api";

type Session = Awaited<ReturnType<typeof api.terminalSessions>>["sessions"][number];
const labels: Record<string,string> = {running:"运行中", completed:"空闲", idle:"空闲", ready:"就绪", waiting:"等待输入", failed:"命令失败", timeout:"命令超时"};
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
        if(!abort.signal.aborted) setError(err instanceof Error?err.message:'无法读取会话');
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
    if(active && selectedId && selectedExists && !closingSelected)void api.ticket(`/terminal?session_id=${encodeURIComponent(selectedId)}`).then(ticket=>{if(!cancelled)setFrame(ticket.url);}).catch(err=>{if(!cancelled)setFrameError(err instanceof Error?err.message:'终端连接失败');});
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
  const copy=async(id:string)=>{try{await navigator.clipboard.writeText(id);onNotify('已复制 session ID');}catch{onNotify('复制失败，请选中 ID 手动复制','error');}};
  const create=async()=>{
    if(locked.current)return;locked.current=true;setMutation('new');setActionError(null);
    try {const {id}=await api.createTerminalSession();setSessions(old=>[...(old??[]),{id,status:'ready',workingDir:'',lastUsedAt:null}]);onSelect(id);setExpanded(false);}
    catch(err){setActionError(err instanceof Error?err.message:'创建终端失败');}
    finally{locked.current=false;setMutation(null);setAttempt(n=>n+1);}
  };
  const close=async(s:Session)=>{
    if(locked.current)return;locked.current=true;setMutation(s.id);setConfirm(null);setActionError(null);
    try {await api.closeTerminalSession(s.id);const remaining=sorted.filter(t=>t.id!==s.id);setSessions(remaining);if(current.current.selectedId===s.id)onSelect(remaining[0]?.id??null);onNotify('终端已关闭');}
    catch(err){setActionError(err instanceof Error?err.message:'关闭终端失败，请刷新核对');}
    finally{locked.current=false;setMutation(null);setAttempt(n=>n+1);}
  };
  const requestClose=(s:Session)=>{if(s.status==='running'||s.status==='waiting')setConfirm(s);else void close(s);};
  return <section className="terminal-panel" aria-label="终端会话">
    <section ref={root} className="terminal-sessions" aria-label="活跃 Shell 会话">
      <div className="terminal-sessions-head">
        <button ref={picker} className="terminal-picker" aria-label="切换终端会话" aria-expanded={expanded} aria-controls="terminal-session-list" disabled={!sessions?.length||!!mutation} onClick={()=>setExpanded(v=>!v)}>
          <span aria-hidden>⌘</span><span className="terminal-picker-text"><strong>{selected?shortId(selected.id):'选择终端'}</strong><small>{selected?.workingDir||`${sessions?.length??0} 个会话`}</small></span>
          {selected && <span className={`terminal-session-status ${selected.status==='running'?'running':''}`}>{labels[selected.status]??selected.status}</span>}<span className="terminal-count">{sessions?.length??0}</span><span aria-hidden>⌄</span>
        </button>
        <button className="ghost terminal-icon" disabled={busy||!active||!!mutation} onClick={()=>setAttempt(n=>n+1)} aria-label="刷新终端会话" title="刷新">↻</button>
        <button className="ghost terminal-icon" disabled={!active||!!mutation} onClick={()=>void create()} aria-label="新建终端" title="新建终端">＋</button>
        <button className="ghost terminal-icon" disabled={!selected||!!mutation} onClick={()=>selected&&requestClose(selected)} aria-label="关闭当前终端" title="关闭当前终端">×</button>
      </div>
      {expanded && <div className="terminal-session-menu" id="terminal-session-list"><div className="terminal-menu-label">终端会话 · {sorted.length}</div><ul>{sorted.map(s=><li key={s.id} className={selectedId===s.id?'selected':''}>
        <button className="terminal-session-choice" onClick={()=>choose(s.id)} aria-label={`切换到终端 ${s.id}`} aria-current={selectedId===s.id?'true':undefined} disabled={!!mutation}>
          <span className="terminal-session-info"><code title={s.id}>{shortId(s.id)}</code><span title={s.workingDir}>{s.workingDir||'工作目录未记录'}</span></span><span className={`terminal-session-status ${s.status==='running'?'running':''}`}>{labels[s.status]??s.status}</span>
        </button>
        <button className="ghost terminal-icon" aria-label={`复制 session ID ${s.id}`} title="复制完整 ID" onClick={()=>void copy(s.id)}>⧉</button>
        <button className="ghost terminal-icon" aria-label={`关闭终端 ${s.id}`} title="关闭终端" disabled={!!mutation} onClick={()=>requestClose(s)}>×</button>
      </li>)}</ul></div>}
      {confirm && <div className="terminal-confirm" role="alert"><span>关闭 {shortId(confirm.id)} 会终止该会话中正在运行的命令。</span><button className="ghost tiny" onClick={()=>setConfirm(null)}>取消</button><button className="danger tiny" onClick={()=>void close(confirm)}>确认关闭</button></div>}
      {actionError && <p className="error tiny" role="alert">{actionError}</p>}
      {error && <p className="error tiny" role="alert">{error}{sessions?'（保留上次读取结果）':''}</p>}
    </section>
    <div className="terminal-screen">
      {!active?<p className="muted">终端连接已暂停，返回页面后恢复。</p>:mutation===selectedId&&selectedId?<p className="muted">正在关闭终端…</p>:frame?<iframe src={frame} title="终端" allow="clipboard-read; clipboard-write"/>:frameError?<div role="alert"><p>{frameError}</p><button className="ghost" onClick={()=>setFrameAttempt(n=>n+1)}>重试连接</button></div>:selectedId?<p className="muted">正在连接终端…</p>:<div className="terminal-empty"><span aria-hidden>⌘</span><p>{sessions===null?'正在读取会话…':'暂无活跃终端'}</p><button className="primary" disabled={!!mutation} onClick={()=>void create()}>新建终端</button></div>}
    </div>
  </section>;
}
