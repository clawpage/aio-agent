import { useEffect, useState } from "react";
import { cachedImage, holdImage } from "../imageCache";
import { t } from "../i18n";

/** One picture of the strip: drawn once fetched; one that is gone (a temporary file since removed) is left out. */
function DraftThumb({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const [url, setUrl] = useState(() => cachedImage(path));
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    const held = holdImage(path, (next) => { if (live) setUrl(next); });
    held.promise.then((next) => { if (live) setUrl(next); }, () => { if (live) setGone(true); });
    return () => { live = false; held.release(); };
  }, [path]);
  if (gone) return null;
  const name = path.split("/").pop() ?? "";
  return <button type="button" className="draft-thumb" title={name} aria-label={name} onClick={() => onOpen(path)}>
    {url ? <img src={url} alt="" /> : <span className="draft-thumb-loading" aria-hidden="true" />}
  </button>;
}

/** Pictures the agent looked at while it worked: marked as a draft, never mistaken for what it delivers. */
export function DraftStrip({ paths, onOpen }: { paths: string[]; onOpen: (path: string) => void }) {
  return <div className="draft-strip" role="group" aria-label={t.chat.timeline.drafts.note}>
    <div className="draft-strip-head"><span className="draft-badge">{t.chat.timeline.drafts.badge}</span><span className="muted tiny">{t.chat.timeline.drafts.note}</span></div>
    <div className="draft-strip-pictures">{paths.map((path) => <DraftThumb key={path} path={path} onOpen={onOpen} />)}</div>
  </div>;
}
