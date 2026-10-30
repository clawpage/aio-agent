import { memo, useEffect, useState } from "react";
import type { ShareLink } from "../shareLinks";
import { openNativeBrowser } from "../deviceBrowser";
import { isSandboxLink } from "../sandboxLink";
import { pathUser } from "../userPath";
import { useClawpageCover } from "../clawpageCover";
import { t } from "../i18n";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebKit or a non-secure context: fall back to a selected textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

const PAGE = /^https?:\/\/[^/]+\/u\/([A-Za-z0-9_-]{2,40})\/share(?:\/([a-z0-9][a-z0-9-]{0,62})\/?|\?([a-z0-9][a-z0-9-]{0,62}))$/;

/** The clawpage a link names, when it is one of this account's own (only those have a cover here). */
function ownPage(url: string): string | null {
  const m = PAGE.exec(url);
  return m && m[1] === pathUser() ? (m[2] ?? m[3] ?? null) : null;
}

/**
 * A clawpage (public share page) in a message: its cover (a picture of the page,
 * for the account's own pages), its title and address, one tap to copy it, the
 * system share sheet where the device has one, and opening it in the person's
 * own browser (it is a public page meant for other people, not something to drive
 * in the sandbox).
 */
export const ShareCard = memo(function ShareCard({ link, onOpenLink }: { link: ShareLink; onOpenLink?: (url: string) => void }) {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const cover = useClawpageCover(ownPage(link.url));
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const open = (event: React.MouseEvent) => {
    if (isSandboxLink(link.url)) { event.preventDefault(); onOpenLink?.(link.url); }
    else if (openNativeBrowser(link.url)) event.preventDefault();
  };
  return (
    <div className={`share-card${cover ? " has-cover" : ""}`} data-testid="share-card">
      {cover && <a className="share-card-cover" href={link.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true" onClick={open}>
        <img src={cover} alt="" decoding="async" draggable={false} data-testid="share-card-cover"/>
      </a>}
      <div className="share-card-body">
        <span className="share-card-title">{link.title}</span>
        <code className="share-card-url" data-testid="share-card-url">{link.url}</code>
        <div className="share-card-actions">
          <a className="primary tiny share-card-open" href={link.url} target="_blank" rel="noopener noreferrer" onClick={open}>{t.cards.share.open}</a>
          <button type="button" className="ghost tiny" onClick={() => void copyText(link.url).then((ok) => setCopied(ok ? "ok" : "failed"))}>
            {copied === "ok" ? t.cards.share.copied : copied === "failed" ? t.cards.share.copyFailed : t.cards.share.copy}
          </button>
          {canShare && (
            <button type="button" className="ghost tiny" onClick={() => void navigator.share({ title: link.title, url: link.url }).catch(() => undefined)}>
              {t.cards.share.share}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
