import {useCallback,useEffect,useState} from 'react';
import {api} from '../api';
import {t} from '../i18n';

export function SoulSettings() {
  const [content,setContent]=useState('');
  const [loaded,setLoaded]=useState<Awaited<ReturnType<typeof api.soul>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [saved,setSaved]=useState(false);
  const load=useCallback(async()=>{
    setBusy(true);setError(null);setSaved(false);
    try{const value=await api.soul();setLoaded(value);setContent(value.content);}
    catch(err){setError(err instanceof Error?err.message:t.settings.soul.loadFailed);}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const bytes=new TextEncoder().encode(content).length;
  const save=async()=>{
    if(!loaded)return;setBusy(true);setError(null);setSaved(false);
    try{const result=await api.saveSoul({content,revision:loaded.revision});setLoaded({...loaded,...result});setSaved(true);}
    catch(err){setError(err instanceof Error?err.message:t.settings.soul.saveFailed);}
    finally{setBusy(false);}
  };
  return <section className="settings-card soul-settings" aria-label={t.settings.soul.title}>
    <div className="settings-section-head"><h3>{t.settings.soul.title} <span className="settings-file-label">SOUL.md</span></h3><p>{t.settings.soul.intro}</p></div>
    <label className="field"><span>{t.settings.soul.contentLabel}</span><textarea aria-label={t.settings.soul.contentLabel} value={content} onChange={e=>{setContent(e.target.value);setSaved(false);}} disabled={busy||!loaded} spellCheck={false}/></label>
    <div className="muted tiny">{t.settings.soul.size(bytes.toLocaleString())}</div>
    {error&&<p className="banner error" role="alert">{error} {t.settings.soul.reloadWarning}</p>}
    {saved&&<p className="banner ok soul-saved" role="status">{t.settings.soul.saved}</p>}
    <div className="settings-actions soul-actions">
      <button className="ghost" aria-label={t.settings.soul.reloadLabel} disabled={busy} onClick={()=>void load()}>{t.settings.soul.reload}</button>
      <button className="ghost" disabled={busy||!loaded} onClick={()=>{setContent(loaded!.defaultContent);setSaved(false);}}>{t.settings.soul.fillDefault}</button>
      <span className="spacer"/>
      <button className="primary" disabled={busy||!loaded||bytes>(loaded?.maxBytes??65536)||content===loaded.content} onClick={()=>void save()}>{busy?t.settings.soul.busy:t.settings.soul.save}</button>
    </div>
  </section>;
}
