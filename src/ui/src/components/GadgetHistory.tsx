import { InlineLoading } from "./Brand";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, type GadgetMessage } from '../api';
import { MessageTime, useDisplayClock } from './MessageTime';
import { t } from '../i18n';

/** The account name as a title: `betaw` → `Betaw`. */
export const accountLabel = (account: string) => account.charAt(0).toUpperCase() + account.slice(1);

const PAGE = 50;

/** The owner's read-only view of what the voice gadget's account said and was told. */
export function GadgetHistory({ active, onExpired }: { active: boolean; onExpired: () => void }) {
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  /** Oldest first. */
  const [messages, setMessages] = useState<GadgetMessage[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const now = useDisplayClock();

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) onExpired();
    else setError(err instanceof Error ? err.message : t.gadget.readFailed);
  }, [onExpired]);

  // The newest page, merged into what is shown; polled while the page is in view.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let busy = false, first = true;
    const load = async () => {
      if (busy) return; busy = true;
      try {
        const page = await api.gadgetHistory({ limit: PAGE }, controller.signal);
        if (controller.signal.aborted) return;
        setAccount(page.account); setError('');
        setMessages(shown => {
          const fresh = new Map(page.messages.map(m => [m.id, m]));
          const kept = shown.filter(m => !fresh.has(m.id));
          return [...kept, ...[...page.messages].reverse()].sort((a, b) => a.createdAt - b.createdAt);
        });
        if (first) { setMore(page.more); first = false; }
      } catch (err) { if (!controller.signal.aborted) fail(err); }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, fail]);

  const older = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    const el = scroller.current, from = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const page = await api.gadgetHistory({ limit: PAGE, before: oldest.createdAt });
      stick.current = false;
      setMessages(shown => [...[...page.messages].reverse().filter(m => !shown.some(s => s.id === m.id)), ...shown]);
      setMore(page.more);
      // Keep the message that was at the top where it was.
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - from; });
    } catch (err) { fail(err); }
    finally { setLoadingOlder(false); }
  };

  // Follow new messages while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const title = account ? accountLabel(account) : t.gadget.fallbackTitle;
  return <section className="gadget-history" aria-labelledby="gadget-title">
    <header className="chat-head"><div className="chat-title"><h2 id="gadget-title">{title}</h2><span className="task-list-sub muted tiny">{t.gadget.subtitle}</span></div></header>
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="gadget-log" ref={scroller} onScroll={onScroll} role="log" aria-label={t.gadget.logLabel(title)}>
      {account === undefined && !error ? <p><InlineLoading label={t.gadget.loading}/></p>
        : account === null ? <p className="muted">{t.gadget.unbound}</p>
        : messages.length === 0 ? <p className="muted">{t.gadget.empty}</p>
        : <>
          {more && <button className="ghost gadget-older" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? t.gadget.loadingOlder : t.gadget.loadOlder}</button>}
          {messages.map(m => <div key={m.id} className="gadget-exchange">
            <article className="msg user"><div className="bubble"><div className="plain">{m.text}</div><div className="message-meta"><MessageTime at={m.createdAt} now={now}/></div></div></article>
            <article className="msg assistant"><div className="bubble">
              {m.done && m.reply ? <div className="plain">{m.reply}</div>
                : m.done ? <div className="plain gadget-failed">{t.gadget.failed[m.status] ?? t.gadget.noReply}{m.error ? t.gadget.errorDetail(m.error) : ''}</div>
                : <div className="muted">{t.gadget.answering}</div>}
              {m.done && <div className="message-meta"><MessageTime at={m.completedAt ?? m.createdAt} now={now}/></div>}
            </div></article>
          </div>)}
        </>}
    </div>
  </section>;
}
