import { memo, useEffect, useState } from "react";
import type { ShareLink } from "../shareLinks";
import { openNativeBrowser } from "../deviceBrowser";
import { isSandboxLink } from "../sandboxLink";

async function copyText(text: string): Promise<boolean> {
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

/**
 * A public share page: its address in full, one tap to copy it, the system share
 * sheet where the device has one, and opening it in the person's own browser (it
 * is a public page meant for other people, not something to drive in the sandbox).
 */
export const ShareCard = memo(function ShareCard({ link, onOpenLink }: { link: ShareLink; onOpenLink?: (url: string) => void }) {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="share-card" data-testid="share-card">
      <div className="share-card-head">
        <span className="share-card-badge" aria-hidden="true">分享页</span>
        <span className="share-card-title">{link.title}</span>
      </div>
      <code className="share-card-url" data-testid="share-card-url">{link.url}</code>
      <div className="share-card-actions">
        <button type="button" className="primary tiny" onClick={() => void copyText(link.url).then((ok) => setCopied(ok ? "ok" : "failed"))}>
          {copied === "ok" ? "已复制" : copied === "failed" ? "复制失败，请长按链接" : "复制链接"}
        </button>
        {canShare && (
          <button type="button" className="ghost tiny" onClick={() => void navigator.share({ title: link.title, url: link.url }).catch(() => undefined)}>
            分享
          </button>
        )}
        <a className="ghost tiny share-card-open" href={link.url} target="_blank" rel="noopener noreferrer" onClick={event => { if (isSandboxLink(link.url)) { event.preventDefault(); onOpenLink?.(link.url); }
          else if (openNativeBrowser(link.url)) event.preventDefault(); }}>打开</a>
      </div>
    </div>
  );
});
