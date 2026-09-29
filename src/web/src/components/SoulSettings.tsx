import {useCallback,useEffect,useState} from 'react';
import {api} from '../api';

export function SoulSettings() {
  const [content,setContent]=useState('');
  const [loaded,setLoaded]=useState<Awaited<ReturnType<typeof api.soul>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [saved,setSaved]=useState(false);
  const load=useCallback(async()=>{
    setBusy(true);setError(null);setSaved(false);
    try{const value=await api.soul();setLoaded(value);setContent(value.content);}
    catch(err){setError(err instanceof Error?err.message:'读取失败');}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const bytes=new TextEncoder().encode(content).length;
  const save=async()=>{
    if(!loaded)return;setBusy(true);setError(null);setSaved(false);
    try{const result=await api.saveSoul({content,revision:loaded.revision});setLoaded({...loaded,...result});setSaved(true);}
    catch(err){setError(err instanceof Error?err.message:'保存失败');}
    finally{setBusy(false);}
  };
  return <section className="settings-card soul-settings" aria-label="助理设定">
    <div className="settings-section-head"><h3>助理设定 <span className="settings-file-label">SOUL.md</span></h3><p>定义助理的身份、语气和做事方式。保存后作为系统指令，用于下一次任务规划、启动或继续任务。</p></div>
    <label className="field"><span>SOUL.md 内容</span><textarea aria-label="SOUL.md 内容" value={content} onChange={e=>{setContent(e.target.value);setSaved(false);}} disabled={busy||!loaded} spellCheck={false}/></label>
    <div className="muted tiny">{bytes.toLocaleString()} / 65,536 字节 · 可留空以清除自定义设定</div>
    {error&&<p className="banner error" role="alert">{error} 重新加载会替换当前草稿，请先复制保留。</p>}
    {saved&&<p className="banner ok soul-saved" role="status">SOUL.md 已保存，下次任务开始时生效。</p>}
    <div className="settings-actions soul-actions">
      <button className="ghost" aria-label="重新加载 SOUL.md" disabled={busy} onClick={()=>void load()}>重新加载</button>
      <button className="ghost" disabled={busy||!loaded} onClick={()=>{setContent(loaded!.defaultContent);setSaved(false);}}>填入默认设定</button>
      <span className="spacer"/>
      <button className="primary" disabled={busy||!loaded||bytes>(loaded?.maxBytes??65536)||content===loaded.content} onClick={()=>void save()}>{busy?'处理中…':'保存 SOUL.md'}</button>
    </div>
  </section>;
}
