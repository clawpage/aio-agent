import {useEffect, useState} from "react";
import {api} from "../api";

type Session = Awaited<ReturnType<typeof api.terminalSessions>>["sessions"][number];
const labels: Record<string,string> = {running:"运行中", completed:"空闲", idle:"空闲", ready:"就绪", waiting:"等待输入", failed:"命令失败", timeout:"命令超时"};

/** Observes AIO shell sessions without creating, attaching to or killing one. */
export function TerminalSessions({active,onNotify}:{active:boolean;onNotify:(message:string,tone?:"error")=>void}) {
  const [sessions,setSessions]=useState<Session[]|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!active) return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=async()=>{
      setBusy(true);
      try {
        const result=await api.terminalSessions(abort.signal);
        if(abort.signal.aborted) return;
        setSessions(result.sessions);setError(null);
      } catch(err) {
        if(!abort.signal.aborted) setError(err instanceof Error?err.message:'无法读取会话');
      } finally {
        if(!abort.signal.aborted){setBusy(false);timer=setTimeout(()=>void refresh(),5000);}
      }
    };
    void refresh();
    return ()=>{abort.abort();clearTimeout(timer);};
  },[active,attempt]);
  const sorted=[...(sessions??[])].sort((a,b)=>Number(b.status==='running')-Number(a.status==='running') || (b.lastUsedAt??'').localeCompare(a.lastUsedAt??''));
  const copy=async(id:string)=>{try{await navigator.clipboard.writeText(id);onNotify('已复制 session ID');}catch{onNotify('复制失败，请选中 ID 手动复制','error');}};
  return <section className="terminal-sessions" aria-label="活跃 Shell 会话">
    <div className="terminal-sessions-head"><strong>活跃会话{sessions?` · ${sessions.length}`:''}</strong><span className="muted tiny">Session ID</span><span className="spacer"/><button className="ghost tiny" disabled={busy||!active} onClick={()=>setAttempt(n=>n+1)} aria-label="刷新终端会话">刷新</button></div>
    {error && <p className="error tiny" role="alert">{error}{sessions?'（下面为上次读取结果）':''}</p>}
    {sessions===null && !error && <p className="muted tiny" role="status">正在读取会话…</p>}
    {sessions?.length===0 && !error && <p className="muted tiny">暂无活跃 Shell 会话</p>}
    {sorted.length>0 && <ul>{sorted.map(s=><li key={s.id}>
      <div className="terminal-session-info"><code>{s.id}</code>{s.workingDir && <span className="muted tiny" title={s.workingDir}>{s.workingDir}</span>}</div>
      <span className={`tiny terminal-session-status ${s.status==='running'?'running':''}`}>{labels[s.status]??s.status}</span>
      <button className="ghost tiny" aria-label={`复制 session ID ${s.id}`} onClick={()=>void copy(s.id)}>复制</button>
    </li>)}</ul>}
  </section>;
}
